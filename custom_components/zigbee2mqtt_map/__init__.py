"""Zigbee2MQTT map: the Zigbee2MQTT network map as a Home Assistant sidebar panel."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components import frontend, mqtt, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers.typing import ConfigType

from . import websocket
from .const import (
    CONF_REQUIRE_ADMIN,
    CONF_SIDEBAR_TITLE,
    CONF_Z2M_URL,
    DEFAULT_REQUIRE_ADMIN,
    DEFAULT_SIDEBAR_TITLE,
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_FILE,
    PANEL_ICON,
    PANEL_URL_PATH,
    STATIC_URL,
    VERSION,
)
from .coordinator import MapCoordinator

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.BUTTON, Platform.NUMBER, Platform.SENSOR, Platform.SWITCH]
FRONTEND_DIR = Path(__file__).parent / "frontend"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Things that happen once per Home Assistant run: static files and websocket commands."""
    hass.data.setdefault(DOMAIN, {})
    await hass.http.async_register_static_paths([StaticPathConfig(STATIC_URL, str(FRONTEND_DIR), cache_headers=True)])
    websocket.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Start talking to Zigbee2MQTT, create the entities, put the panel in the sidebar."""
    if not await mqtt.async_wait_for_mqtt_client(hass):
        raise ConfigEntryNotReady("the MQTT integration is not available")
    coordinator = MapCoordinator(hass, entry)
    await coordinator.async_setup()
    hass.data[DOMAIN][entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await _async_register_panel(hass, entry)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the panel and stop listening; the stored map survives for the next start."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if coordinator := hass.data[DOMAIN].pop(entry.entry_id, None):
        await coordinator.async_unload()
    return ok


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Base topic, sidebar title or admin flag changed: start over."""
    await hass.config_entries.async_reload(entry.entry_id)


async def _async_register_panel(hass: HomeAssistant, entry: ConfigEntry) -> None:
    # the file's hash in the URL makes browsers drop the cached module after an update
    file_hash = await hass.async_add_executor_job(_short_hash, FRONTEND_DIR / PANEL_FILE)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title=entry.options.get(CONF_SIDEBAR_TITLE, DEFAULT_SIDEBAR_TITLE),
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/{PANEL_FILE}?v={file_hash}",
        require_admin=entry.options.get(CONF_REQUIRE_ADMIN, DEFAULT_REQUIRE_ADMIN),
        config={"version": VERSION, "z2m_url": entry.options.get(CONF_Z2M_URL, "")},
    )


def _short_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]
