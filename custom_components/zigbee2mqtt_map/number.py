"""The two scan intervals."""

from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberEntityDescription, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SETTING_BACKGROUND_HOURS, SETTING_VIEWING_MINUTES
from .coordinator import MapCoordinator
from .entity import MapEntity

DESCRIPTIONS = (
    NumberEntityDescription(
        key=SETTING_BACKGROUND_HOURS,
        native_min_value=0,
        native_max_value=24,
        native_step=0.25,  # 15 min: fine enough for the mesh sensors; the schedule timer ticks every 5 min
        native_unit_of_measurement=UnitOfTime.HOURS,
        mode=NumberMode.BOX,
        entity_category=EntityCategory.CONFIG,
        icon="mdi:timer-sync-outline",
    ),
    NumberEntityDescription(
        key=SETTING_VIEWING_MINUTES,
        native_min_value=0,
        native_max_value=60,
        native_step=1,
        native_unit_of_measurement=UnitOfTime.MINUTES,
        mode=NumberMode.BOX,
        entity_category=EntityCategory.CONFIG,
        icon="mdi:eye-refresh-outline",
    ),
)
ROLES = {SETTING_BACKGROUND_HOURS: "bg", SETTING_VIEWING_MINUTES: "live"}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: MapCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(MapNumber(coordinator, d) for d in DESCRIPTIONS)


class MapNumber(MapEntity, NumberEntity):
    def __init__(self, coordinator: MapCoordinator, description: NumberEntityDescription) -> None:
        super().__init__(coordinator, description.key, ROLES[description.key])
        self.entity_description = description

    @property
    def native_value(self) -> float:
        return float(self.coordinator.settings[self._key])

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.async_set_setting(self._key, value)
