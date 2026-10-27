"""Scan now."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import MapCoordinator
from .entity import MapEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: MapCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([ScanButton(coordinator)])


class ScanButton(MapEntity, ButtonEntity):
    _attr_icon = "mdi:radar"

    def __init__(self, coordinator: MapCoordinator) -> None:
        super().__init__(coordinator, "scan_now")

    async def async_press(self) -> None:
        await self.coordinator.async_scan(source="button")
