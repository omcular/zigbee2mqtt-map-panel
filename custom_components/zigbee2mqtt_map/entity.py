"""Base class: one device "Zigbee2MQTT map", entities update when the coordinator says so."""

from __future__ import annotations

from typing import Any

from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, EVENT_MAP, EVENT_STATUS, VERSION
from .coordinator import MapCoordinator


class MapEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, coordinator: MapCoordinator, key: str, role: str | None = None) -> None:
        self.coordinator = coordinator
        self._key = key
        self._role = role  # name under which the panel finds this entity's id
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{key}"
        self._attr_translation_key = key
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry.entry_id)},
            name="Zigbee2MQTT map",
            manufacturer="omcular",
            model="Zigbee2MQTT network map panel",
            sw_version=VERSION,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.coordinator.add_listener(self._on_event))
        if self._role:
            self.coordinator.entities[self._role] = self.entity_id

    @callback
    def _on_event(self, event: dict[str, Any]) -> None:
        if event["type"] in (EVENT_STATUS, EVENT_MAP):
            self.async_write_ha_state()
