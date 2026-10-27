"""When the last map arrived, and what it contained."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .coordinator import MapCoordinator
from .entity import MapEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: MapCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([LastScanSensor(coordinator)])


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
