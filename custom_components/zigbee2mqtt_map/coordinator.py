"""Talks to Zigbee2MQTT over MQTT, keeps the last network map, runs the background schedule."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timedelta
import logging
from typing import Any

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.helpers.json import json_dumps
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util
from homeassistant.util.json import json_loads_object

from .const import (
    CONF_BASE_TOPIC,
    DEFAULT_SETTINGS,
    EVENT_ERROR,
    EVENT_MAP,
    EVENT_PROGRESS,
    EVENT_SCAN_STARTED,
    EVENT_STATUS,
    SCAN_KIND_FAST,
    SCAN_KIND_NORMAL,
    FIRST_SCAN_DELAY,
    SCAN_TIMEOUT,
    SCHEDULE_SLACK,
    SETTING_BACKGROUND_HOURS,
    SETTING_PARALLEL,
    SETTING_VIEWING_MINUTES,
    STORE_KEY,
    STORE_VERSION,
    TIMER_INTERVAL,
    VERSION,
)

_LOGGER = logging.getLogger(__name__)

Listener = Callable[[dict[str, Any]], None]


class MapCoordinator:
    """One per config entry: scan state, last map, settings, listeners."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.base_topic: str = entry.options.get(CONF_BASE_TOPIC, entry.data[CONF_BASE_TOPIC])
        self.map: dict[str, Any] | None = None  # {"fetchedAt", "map", "duration", "kind"}
        self.last_request: datetime | None = None
        self.scanning: str | None = None  # kind while a scan is running
        self.settings: dict[str, Any] = dict(DEFAULT_SETTINGS)
        self.entities: dict[str, str] = {}  # role -> entity_id, filled by the platforms
        self._listeners: set[Listener] = set()
        self._store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, STORE_KEY)
        self._unsubs: list[CALLBACK_TYPE] = []
        self._timeout: asyncio.TimerHandle | None = None

    # ---- lifecycle ------------------------------------------------------------------------------------------------
    async def async_setup(self) -> None:
        """Load what the last run left, subscribe to Zigbee2MQTT's answers, start the schedule."""
        if (data := await self._store.async_load()) is not None:
            self.map = data.get("map")
            if last := data.get("last_request"):
                self.last_request = dt_util.parse_datetime(last)
            self.settings.update({k: v for k, v in data.get("settings", {}).items() if k in DEFAULT_SETTINGS})
        for kind in (SCAN_KIND_NORMAL, SCAN_KIND_FAST):
            self._unsubs.append(
                await mqtt.async_subscribe(self.hass, f"{self.base_topic}/bridge/response/{kind}", self._on_response)
            )
        self._unsubs.append(
            await mqtt.async_subscribe(self.hass, f"{self.base_topic}/bridge/{SCAN_KIND_FAST}/progress", self._on_progress)
        )
        self._unsubs.append(async_track_time_interval(self.hass, self._on_timer, timedelta(seconds=TIMER_INTERVAL)))
        if self.map is None:
            self._unsubs.append(async_call_later(self.hass, FIRST_SCAN_DELAY, self._first_scan))

    async def async_unload(self) -> None:
        """Stop listening; the store keeps the map for the next start."""
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        self._cancel_timeout()
        self._listeners.clear()

    # ---- listeners (websocket subscriptions and entities) ---------------------------------------------------------
    @callback
    def add_listener(self, listener: Listener) -> CALLBACK_TYPE:
        self._listeners.add(listener)

        @callback
        def _remove() -> None:
            self._listeners.discard(listener)

        return _remove

    @callback
    def _notify(self, event: dict[str, Any]) -> None:
        for listener in list(self._listeners):
            listener(event)

    @callback
    def status_event(self) -> dict[str, Any]:
        """What a panel needs to know before any map: topic, entity ids, whether a scan runs."""
        return {
            "type": EVENT_STATUS,
            "version": VERSION,
            "base_topic": self.base_topic,
            "entities": dict(self.entities),
            "scanning": self.scanning,
            "last_request": self.last_request.isoformat() if self.last_request else None,
            "settings": dict(self.settings),
        }

    @callback
    def map_event(self) -> dict[str, Any] | None:
        return {"type": EVENT_MAP, **self.map} if self.map else None

    # ---- settings ------------------------------------------------------------------------------------------------
    async def async_set_setting(self, key: str, value: Any) -> None:
        if key not in DEFAULT_SETTINGS:
            raise ValueError(f"unknown setting {key}")
        self.settings[key] = value
        self._save()
        self._notify(self.status_event())

    # ---- scanning ------------------------------------------------------------------------------------------------
    async def async_scan(self, *, routes: bool = False, source: str = "manual") -> bool:
        """Ask Zigbee2MQTT for the raw map. Returns False when a scan is already running."""
        if self.scanning:
            return False
        kind = SCAN_KIND_FAST if self.settings[SETTING_PARALLEL] else SCAN_KIND_NORMAL
        self.scanning = kind
        self.last_request = dt_util.utcnow()
        self._save()
        self._timeout = self.hass.loop.call_later(SCAN_TIMEOUT, self._on_timeout)
        self._notify({"type": EVENT_SCAN_STARTED, "kind": kind, "source": source})
        self._notify(self.status_event())
        _LOGGER.debug("scan requested (%s, %s, routes=%s)", kind, source, routes)
        try:
            await mqtt.async_publish(
                self.hass, f"{self.base_topic}/bridge/request/{kind}", json_dumps({"type": "raw", "routes": routes})
            )
        except Exception as err:  # noqa: BLE001 - whatever MQTT raises, the panel must hear about it
            self._finish_scan()
            self._notify({"type": EVENT_ERROR, "message": f"could not publish the scan request: {err}"})
            raise
        return True

    @callback
    def _on_response(self, msg: mqtt.ReceiveMessage) -> None:
        try:
            data = json_loads_object(msg.payload)
        except ValueError:
            _LOGGER.warning("unreadable network map answer on %s", msg.topic)
            return
        kind = msg.topic.rsplit("/", 1)[-1]
        if data.get("status") != "ok":
            self._finish_scan()
            message = str(data.get("error") or "unknown error")
            _LOGGER.warning("Zigbee2MQTT answered the %s request with an error: %s", kind, message)
            self._notify({"type": EVENT_ERROR, "message": message})
            self._notify(self.status_event())
            return
        value = data.get("data", {}).get("value") if isinstance(data.get("data"), dict) else None
        if not isinstance(value, dict) or "nodes" not in value:
            _LOGGER.warning("network map answer on %s has no nodes (is it a raw map?)", msg.topic)
            return
        self._finish_scan()
        self.map = {
            "fetchedAt": dt_util.utcnow().isoformat(),
            "map": value,
            "kind": kind,
            "duration": data["data"].get("duration"),
        }
        self._save()
        _LOGGER.debug("map received: %d nodes, %d links", len(value.get("nodes", [])), len(value.get("links", [])))
        self._notify(self.map_event())
        self._notify(self.status_event())

    @callback
    def _on_progress(self, msg: mqtt.ReceiveMessage) -> None:
        try:
            data = json_loads_object(msg.payload)
        except ValueError:
            return
        self._notify({"type": EVENT_PROGRESS, **{k: data.get(k) for k in ("done", "total", "failed")}})

    @callback
    def _on_timeout(self) -> None:
        self._timeout = None
        if not self.scanning:
            return
        _LOGGER.warning("no network map answer from Zigbee2MQTT within %d s", SCAN_TIMEOUT)
        self._finish_scan()
        self._notify({"type": EVENT_ERROR, "message": f"no answer from Zigbee2MQTT within {SCAN_TIMEOUT // 60} min"})
        self._notify(self.status_event())

    @callback
    def _finish_scan(self) -> None:
        self.scanning = None
        self._cancel_timeout()

    @callback
    def _cancel_timeout(self) -> None:
        if self._timeout:
            self._timeout.cancel()
            self._timeout = None

    async def _first_scan(self, _now: datetime) -> None:
        """Fresh install (nothing stored yet): fetch a first map so the panel has something to show."""
        if self.map is None and not self.scanning:
            await self.async_scan(source="first")

    async def _on_timer(self, now: datetime) -> None:
        """Background schedule: scan when the configured interval has passed since the last request from anyone."""
        hours = float(self.settings[SETTING_BACKGROUND_HOURS] or 0)
        if hours <= 0 or self.scanning:
            return
        if self.last_request and (now - self.last_request).total_seconds() < hours * 3600 - SCHEDULE_SLACK:
            return
        await self.async_scan(source="schedule")

    # ---- persistence ---------------------------------------------------------------------------------------------
    @callback
    def _save(self) -> None:
        self._store.async_delay_save(self._data_to_save, 1)

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        return {
            "map": self.map,
            "last_request": self.last_request.isoformat() if self.last_request else None,
            "settings": self.settings,
        }
