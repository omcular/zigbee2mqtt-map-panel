"""When the last map arrived, and what it contained."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .coordinator import MapCoordinator
from .entity import MapEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: MapCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([LastScanSensor(coordinator), MeshSensor(coordinator, "connected"), MeshSensor(coordinator, "redundant"), MeshSensor(coordinator, "ignored")])


class LastScanSensor(MapEntity, SensorEntity):
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:sitemap-outline"

    def __init__(self, coordinator: MapCoordinator) -> None:
        super().__init__(coordinator, "last_scan")

    @property
    def native_value(self) -> datetime | None:
        if not (m := self.coordinator.map):
            return None
        return dt_util.parse_datetime(m["fetchedAt"])

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        attrs: dict[str, Any] = {"scanning": self.coordinator.scanning, "base_topic": self.coordinator.base_topic}
        if m := self.coordinator.map:
            nodes = m["map"].get("nodes", [])
            attrs.update(
                {
                    "routers": sum(1 for n in nodes if n.get("type") == "Router"),
                    "end_devices": sum(1 for n in nodes if n.get("type") == "EndDevice"),
                    "links": len(m["map"].get("links", [])),
                    "kind": m.get("kind"),
                    "duration": m.get("duration"),
                }
            )
        return attrs


class MeshSensor(MapEntity, SensorEntity):
    """connected ≥ C / redundant ≥ R, computed by the integration after every scan (see mesh.py); the panel shows the same."""

    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 0

    def __init__(self, coordinator: MapCoordinator, field: str) -> None:
        super().__init__(coordinator, f"mesh_{field}")
        self._field = field
        self._attr_icon = {"connected": "mdi:lan-connect", "redundant": "mdi:lan-check", "ignored": "mdi:lan-disconnect"}[field]

    @property
    def _mesh(self) -> dict[str, Any] | None:
        return (self.coordinator.map or {}).get("mesh")

    def _name(self, ieee: str) -> str:
        for n in (self.coordinator.map or {}).get("map", {}).get("nodes", []):
            if n.get("ieeeAddr") == ieee:
                return n.get("friendlyName") or ieee
        return ieee

    @property
    def native_value(self) -> int | None:
        if not self._mesh:
            return None
        return len(self._mesh["ignored"]) if self._field == "ignored" else self._mesh[self._field]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        if not (m := self._mesh):
            return {}
        if self._field == "ignored":  # routers Zigbee2MQTT knows that had no two-sided link in the scan: 0 is healthy
            return {"ignored": list(m.get("ignored", [])), "routers": m.get("routers")}
        if self._field == "connected":
            b = m.get("bottleneck")
            return {
                "bottleneck": f"{self._name(b['source'])} – {self._name(b['target'])}" if b else None,
                "cut_off": [self._name(x) for x in b["lost"]] if b else [],
                "ignored": list(m.get("ignored", [])),
                "routers": m.get("routers"),
            }
        s = m.get("spof")
        return {
            "single_point_of_failure": self._name(s["id"]) if s else None,
            "cut_off": [self._name(x) for x in s["lost"]] if s else [],
            "limited_by_connected_link": s is None and m["redundant"] == m["connected"],
            "routers": m.get("routers"),
        }
