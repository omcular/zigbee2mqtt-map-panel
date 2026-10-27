"""Parallel scan: send requests to the networkmap_fast extension instead of Zigbee2MQTT's own scan."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SETTING_PARALLEL
from .coordinator import MapCoordinator
from .entity import MapEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: MapCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([ParallelScanSwitch(coordinator)])


class ParallelScanSwitch(MapEntity, SwitchEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_icon = "mdi:fast-forward"

    def __init__(self, coordinator: MapCoordinator) -> None:
        super().__init__(coordinator, SETTING_PARALLEL, "fast")

    @property
    def is_on(self) -> bool:
        return bool(self.coordinator.settings[SETTING_PARALLEL])

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.async_set_setting(SETTING_PARALLEL, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.async_set_setting(SETTING_PARALLEL, False)
