"""Config flow: find the Zigbee2MQTT base topic, let the user confirm it; options for the sidebar entry."""

from __future__ import annotations

import asyncio
from typing import Any

import voluptuous as vol

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import selector
from homeassistant.util.json import json_loads_object

from .const import (
    CONF_BASE_TOPIC,
    CONF_REQUIRE_ADMIN,
    CONF_SIDEBAR_TITLE,
    DEFAULT_BASE_TOPIC,
    DEFAULT_REQUIRE_ADMIN,
    DEFAULT_SIDEBAR_TITLE,
    DETECT_SECONDS,
    DOMAIN,
)


async def async_detect_base_topics(hass: HomeAssistant) -> list[str]:
    """Zigbee2MQTT keeps <base>/bridge/state retained; every one that says online names an instance.

    Stale retained "offline" states from earlier installs are ignored on purpose.
    """
    found: list[str] = []

    @callback
    def _on_message(msg: mqtt.ReceiveMessage) -> None:
        parts = msg.topic.split("/")
        if len(parts) != 3:
            return
        try:
            state = json_loads_object(msg.payload).get("state")
        except ValueError:  # older Zigbee2MQTT published a plain string
            state = msg.payload
        if state == "online" and parts[0] not in found:
            found.append(parts[0])

    unsub = await mqtt.async_subscribe(hass, "+/bridge/state", _on_message)
    try:
        await asyncio.sleep(DETECT_SECONDS)
    finally:
        unsub()
    return found


def _clean_topic(value: str) -> str:
    return value.strip().strip("/")


def _topic_valid(value: str) -> bool:
    return bool(value) and not any(c in value for c in "#+")


class ZigbeeMapConfigFlow(ConfigFlow, domain=DOMAIN):
    """One step: the base topic, pre-filled with what the broker tells us."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if not await mqtt.async_wait_for_mqtt_client(self.hass):
            return self.async_abort(reason="mqtt_missing")
        errors: dict[str, str] = {}
        detected: list[str] = []
        if user_input is not None:
            topic = _clean_topic(user_input[CONF_BASE_TOPIC])
            if _topic_valid(topic):
                return self.async_create_entry(title=f"Zigbee2MQTT map ({topic})", data={CONF_BASE_TOPIC: topic})
            errors[CONF_BASE_TOPIC] = "invalid_topic"
        else:
            detected = await async_detect_base_topics(self.hass)
        default = user_input[CONF_BASE_TOPIC] if user_input else (detected[0] if detected else DEFAULT_BASE_TOPIC)
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_BASE_TOPIC, default=default): str}),
            errors=errors,
            description_placeholders={"detected": ", ".join(detected) if detected else "none"},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> ZigbeeMapOptionsFlow:
        return ZigbeeMapOptionsFlow()


class ZigbeeMapOptionsFlow(OptionsFlow):
    """Base topic, sidebar title, admin-only. Saving reloads the integration."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            topic = _clean_topic(user_input[CONF_BASE_TOPIC])
            if _topic_valid(topic):
                return self.async_create_entry(data={**user_input, CONF_BASE_TOPIC: topic})
            errors[CONF_BASE_TOPIC] = "invalid_topic"
        entry = self.config_entry
        current = {
            CONF_BASE_TOPIC: entry.options.get(CONF_BASE_TOPIC, entry.data[CONF_BASE_TOPIC]),
            CONF_SIDEBAR_TITLE: entry.options.get(CONF_SIDEBAR_TITLE, DEFAULT_SIDEBAR_TITLE),
            CONF_REQUIRE_ADMIN: entry.options.get(CONF_REQUIRE_ADMIN, DEFAULT_REQUIRE_ADMIN),
        }
        if user_input:
            current.update(user_input)
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_BASE_TOPIC, default=current[CONF_BASE_TOPIC]): str,
                    vol.Required(CONF_SIDEBAR_TITLE, default=current[CONF_SIDEBAR_TITLE]): str,
                    vol.Required(CONF_REQUIRE_ADMIN, default=current[CONF_REQUIRE_ADMIN]): selector.BooleanSelector(),
                }
            ),
            errors=errors,
        )
