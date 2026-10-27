"""Websocket commands the panel uses: a subscription for maps and status, a command to start a scan."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, WS_SCAN, WS_SUBSCRIBE
from .coordinator import MapCoordinator


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_scan)


def _coordinator(hass: HomeAssistant) -> MapCoordinator | None:
    """The one coordinator (single config entry), or None while the integration is not set up."""
    return next(iter(hass.data.get(DOMAIN, {}).values()), None)


@websocket_api.websocket_command({vol.Required("type"): WS_SUBSCRIBE})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Send the status and the stored map right away, then every new map, progress count and error."""
    if (coordinator := _coordinator(hass)) is None:
        connection.send_error(msg["id"], "not_ready", "the Zigbee2MQTT map integration is not set up")
        return

    @callback
    def forward(event: dict[str, Any]) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], event))

    connection.subscriptions[msg["id"]] = coordinator.add_listener(forward)
    connection.send_result(msg["id"])
    forward(coordinator.status_event())
    if map_event := coordinator.map_event():
        forward(map_event)


@websocket_api.websocket_command({vol.Required("type"): WS_SCAN, vol.Optional("routes", default=False): bool})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_scan(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Ask Zigbee2MQTT for a fresh map. The answer arrives through the subscription."""
    if (coordinator := _coordinator(hass)) is None:
        connection.send_error(msg["id"], "not_ready", "the Zigbee2MQTT map integration is not set up")
        return
    started = await coordinator.async_scan(routes=msg["routes"], source="panel")
    connection.send_result(msg["id"], {"started": started, "scanning": coordinator.scanning})
