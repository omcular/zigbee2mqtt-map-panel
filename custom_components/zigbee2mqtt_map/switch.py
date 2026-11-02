"""Two switches: read routing tables on every scan, and send scan requests to the networkmap_fast extension's own topic.

"Pull routes" is the setting behind the panel's checkbox of the same name; it applies to scheduled scans and the "Scan now"
button too, so a map pulled in the background keeps the routes overlay alive. The topic switch is not needed with the
extension's default configuration (it answers the normal networkmap topic too) and is disabled by default, for the case
where that takeover is off or stops working.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SETTING_PARALLEL, SETTING_ROUTES
from .coordinator import MapCoordinator
from .entity import MapEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: MapCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([RoutesSwitch(coordinator), ParallelScanSwitch(coordinator)])


class SettingSwitch(MapEntity, SwitchEntity):
    _attr_entity_category = EntityCategory.CONFIG

    @property
    def is_on(self) -> bool:
        return bool(self.coordinator.settings[self._key])

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.async_set_setting(self._key, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.async_set_setting(self._key, False)


class RoutesSwitch(SettingSwitch):
    _attr_icon = "mdi:routes"

    def __init__(self, coordinator: MapCoordinator) -> None:
        super().__init__(coordinator, SETTING_ROUTES, "routes")


class ParallelScanSwitch(SettingSwitch):
    _attr_entity_registry_enabled_default = False
    _attr_icon = "mdi:fast-forward"

    def __init__(self, coordinator: MapCoordinator) -> None:
        super().__init__(coordinator, SETTING_PARALLEL, "fast")

