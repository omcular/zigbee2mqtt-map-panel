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
from homeassistant.util.json import json_loads_array, json_loads_object

from .const import (
    CONF_BASE_TOPIC,
    DEFAULT_SETTINGS,
    EVENT_ERROR,
    EVENT_MAP,
    EVENT_PROGRESS,
    EVENT_SCAN_STARTED,
    EVENT_STATUS,
    EVENT_Z2M,
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
        self.permit_join_end: datetime | None = None  # from <base>/bridge/info; None while the network is closed
        # what this integration asked for, so every panel shows the same picture: a broadcast end, or one end per router
        # (each router keeps its own timer; a request from elsewhere, e.g. the Zigbee2MQTT frontend, stays unattributed)
        self.permit_join_all: datetime | None = None
        self.permit_join_via: dict[str, datetime] = {}
        self._permit_pending: str | None = None
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
        # retained device list: renames, joins and removals reach the panel without a new scan
        self._unsubs.append(await mqtt.async_subscribe(self.hass, f"{self.base_topic}/bridge/devices", self._on_devices))
        # retained bridge info: whether (and until when) the network accepts new devices
        self._unsubs.append(await mqtt.async_subscribe(self.hass, f"{self.base_topic}/bridge/info", self._on_info))
        # live pairing feed and the answer to a permit-join request
        self._unsubs.append(await mqtt.async_subscribe(self.hass, f"{self.base_topic}/bridge/event", self._on_event))
        self._unsubs.append(
            await mqtt.async_subscribe(self.hass, f"{self.base_topic}/bridge/response/permit_join", self._on_permit_join_response)
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
            "permit_join_end": self.permit_join_end.isoformat() if self.permit_join_end else None,
            "permit_join_all": self.permit_join_all.isoformat() if self.permit_join_all else None,
            "permit_join_via": {ieee: end.isoformat() for ieee, end in self.permit_join_via.items()},
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
    def _on_devices(self, msg: mqtt.ReceiveMessage) -> None:
        """Zigbee2MQTT's device list (retained, re-published on every change): renames, joins and removals.

        Renamed → the node's friendlyName follows. Joined → a node without links (the panel parks it until a scan
        wires it). Removed → the node stays, marked `removed`, so the panel can grey it with its links; the next scan
        answer replaces the map and drops it for good.
        """
        if not self.map:
            return
        try:
            devices = json_loads_array(msg.payload)
        except ValueError:
            return
        listed = {d["ieee_address"]: d for d in devices if isinstance(d, dict) and d.get("ieee_address") and d.get("friendly_name")}
        if not any(d.get("type") == "Coordinator" for d in listed.values()):
            return  # partial or empty list (Zigbee2MQTT starting up): never mark everything removed on that
        nodes = self.map["map"].setdefault("nodes", [])
        renamed = joined = removed = returned = 0
        for node in nodes:
            device = listed.get(node.get("ieeeAddr"))
            if device is None:
                if not node.get("removed"):
                    node["removed"] = True
                    removed += 1
                continue
            if node.pop("removed", None):
                returned += 1
            if node.get("friendlyName") != device["friendly_name"]:
                node["friendlyName"] = device["friendly_name"]
                renamed += 1
        known = {node.get("ieeeAddr") for node in nodes}
        for ieee, device in listed.items():
            if ieee in known:
                continue
            node: dict[str, Any] = {
                "ieeeAddr": ieee,
                "friendlyName": device["friendly_name"],
                "type": device.get("type") or "Unknown",
                "networkAddress": device.get("network_address"),
                "failed": [],
            }
            definition = device.get("definition")
            if isinstance(definition, dict):
                node["definition"] = {k: definition.get(k) for k in ("vendor", "model", "description")}
            nodes.append(node)
            joined += 1
        if not (renamed or joined or removed or returned):
            return
        self.map["updatedAt"] = dt_util.utcnow().isoformat()
        self._save()
        _LOGGER.debug(
            "device list: %d renamed, %d joined, %d removed, %d back in the stored map", renamed, joined, removed, returned
        )
        self._notify(self.map_event())

    @callback
    def _on_info(self, msg: mqtt.ReceiveMessage) -> None:
        """<base>/bridge/info (retained): permit_join / permit_join_end (epoch ms) drive the panel's countdown."""
        try:
            info = json_loads_object(msg.payload)
        except ValueError:
            return
        end = info.get("permit_join_end") if info.get("permit_join") else None
        new = dt_util.utc_from_timestamp(end / 1000) if isinstance(end, (int, float)) else None
        if new == self.permit_join_end:
            return
        now = dt_util.utcnow()
        if new is None:
            self.permit_join_all = None
            self.permit_join_via = {}
        elif self._permit_pending == "all":
            self.permit_join_all = new
            self.permit_join_via = {}
        elif self._permit_pending not in (None, "stop"):
            self.permit_join_via[self._permit_pending] = new
        if self.permit_join_all and self.permit_join_all <= now:
            self.permit_join_all = None
        self.permit_join_via = {ieee: end for ieee, end in self.permit_join_via.items() if end > now}
        self._permit_pending = None
        self.permit_join_end = new
        self._notify(self.status_event())

    @callback
    def _on_event(self, msg: mqtt.ReceiveMessage) -> None:
        """<base>/bridge/event: the pairing feed (joined, announce, interview started/successful/failed, leave)."""
        try:
            event = json_loads_object(msg.payload)
        except ValueError:
            return
        kind = event.get("type")
        data = event.get("data")
        if kind not in ("device_joined", "device_announce", "device_interview", "device_leave") or not isinstance(data, dict):
            return
        definition = data.get("definition") if isinstance(data.get("definition"), dict) else {}
        self._notify(
            {
                "type": EVENT_Z2M,
                "event": kind,
                "friendly_name": data.get("friendly_name"),
                "ieee_address": data.get("ieee_address"),
                "status": data.get("status"),
                "supported": data.get("supported"),
                "model": definition.get("model"),
                "vendor": definition.get("vendor"),
            }
        )

    @callback
    def _on_permit_join_response(self, msg: mqtt.ReceiveMessage) -> None:
        """Zigbee2MQTT's answer: "join OK" for the feed, or the error; the countdown itself comes from bridge/info."""
        try:
            data = json_loads_object(msg.payload)
        except ValueError:
            return
        if data.get("status") != "ok":
            self._notify({"type": EVENT_ERROR, "message": f"permit join: {data.get('error') or 'unknown error'}"})
            return
        time = data.get("data", {}).get("time") if isinstance(data.get("data"), dict) else None
        self._notify({"type": EVENT_Z2M, "event": "permit_join", "status": "ok", "time": time})

    async def async_permit_join(self, seconds: int, device: str | None = None) -> None:
        """Open (seconds > 0) or close (0) the network, globally or through one router (friendly name or IEEE)."""
        payload: dict[str, Any] = {"time": seconds}
        if device:
            payload["device"] = device
        self._permit_pending = "stop" if seconds == 0 else (device or "all")  # claimed by the next bridge/info
        await mqtt.async_publish(self.hass, f"{self.base_topic}/bridge/request/permit_join", json_dumps(payload))

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
