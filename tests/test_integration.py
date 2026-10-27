"""Config flow, scan round trip over MQTT, websocket subscription, entities, unload."""

from __future__ import annotations

import asyncio
import json

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_mqtt_message

from homeassistant.components import frontend
from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from custom_components.zigbee2mqtt_map.const import CONF_BASE_TOPIC, DOMAIN, PANEL_URL_PATH, WS_SCAN, WS_SUBSCRIBE

RAW_MAP = {
    "nodes": [
        {"ieeeAddr": "0x1", "friendlyName": "Coordinator", "type": "Coordinator", "networkAddress": 0},
        {"ieeeAddr": "0x2", "friendlyName": "Router A", "type": "Router", "networkAddress": 10},
        {"ieeeAddr": "0x3", "friendlyName": "Sensor", "type": "EndDevice", "networkAddress": 20},
    ],
    "links": [
        {"source": {"ieeeAddr": "0x2", "networkAddress": 10}, "target": {"ieeeAddr": "0x1", "networkAddress": 0}, "linkquality": 200, "depth": 1, "relationship": 1, "routes": [], "sourceIeeeAddr": "0x2", "targetIeeeAddr": "0x1", "sourceNwkAddr": 10, "lqi": 200},
    ],
}


async def _setup(hass: HomeAssistant, topic: str = "z2m") -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_BASE_TOPIC: topic}, title="test")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_config_flow_detects_topic(hass: HomeAssistant, monkeypatch) -> None:
    """A retained online bridge/state pre-fills the form; offline ones are ignored."""
    monkeypatch.setattr("custom_components.zigbee2mqtt_map.config_flow.DETECT_SECONDS", 0.3)

    async def fire_states():
        await asyncio.sleep(0.15)  # the real broker replays retained messages on subscribe; the mock needs a nudge once the flow listens
        async_fire_mqtt_message(hass, "zigbee2mqtt/bridge/state", json.dumps({"state": "offline"}))
        async_fire_mqtt_message(hass, "zigbee2mqtt2/bridge/state", json.dumps({"state": "online"}))

    hass.async_create_task(fire_states())
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] == "form"
    assert result["description_placeholders"] == {"detected": "zigbee2mqtt2"}
    assert result["data_schema"]({})[CONF_BASE_TOPIC] == "zigbee2mqtt2"

    bad = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_BASE_TOPIC: "a/#"})
    assert bad["errors"] == {CONF_BASE_TOPIC: "invalid_topic"}

    done = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_BASE_TOPIC: " zigbee2mqtt2/ "})
    assert done["type"] == "create_entry"
    assert done["data"] == {CONF_BASE_TOPIC: "zigbee2mqtt2"}
    await hass.async_block_till_done()


async def test_setup_creates_panel_and_entities(hass: HomeAssistant) -> None:
    await _setup(hass)
    assert PANEL_URL_PATH in hass.data[frontend.DATA_PANELS]
    for entity_id in (
        "number.zigbee2mqtt_map_background_scan_interval",
        "number.zigbee2mqtt_map_scan_interval_while_viewing",
        "button.zigbee2mqtt_map_scan_now",
        "sensor.zigbee2mqtt_map_last_scan",
    ):
        assert hass.states.get(entity_id) is not None, entity_id
    assert hass.states.get("sensor.zigbee2mqtt_map_last_scan").state == "unknown"
    # the networkmap_fast switch exists but is disabled by default
    registry = er.async_get(hass)
    switch = registry.async_get("switch.zigbee2mqtt_map_use_the_networkmap_fast_topic")
    assert switch is not None and switch.disabled_by == er.RegistryEntryDisabler.INTEGRATION


async def test_scan_round_trip_and_websocket(hass: HomeAssistant, hass_ws_client, mqtt) -> None:
    entry = await _setup(hass)
    client = await hass_ws_client(hass)

    await client.send_json({"id": 1, "type": WS_SUBSCRIBE})
    assert (await client.receive_json())["success"]
    status = (await client.receive_json())["event"]
    assert status["type"] == "status"
    assert status["base_topic"] == "z2m"
    assert status["entities"]["bg"] == "number.zigbee2mqtt_map_background_scan_interval"
    assert status["scanning"] is None

    # a scan request publishes to Zigbee2MQTT and announces itself
    await client.send_json({"id": 2, "type": WS_SCAN, "routes": True})
    msgs = [await client.receive_json() for _ in range(3)]
    result = next(m for m in msgs if m["id"] == 2 and m["type"] == "result")
    assert result["result"]["started"] is True and result["result"]["scanning"] == "networkmap"
    events = [m["event"] for m in msgs if m["type"] == "event"]
    assert events[0]["type"] == "scan_started" and events[0]["kind"] == "networkmap"
    assert events[1]["type"] == "status" and events[1]["scanning"] == "networkmap"
    assert mqtt.async_publish.call_args.args[:2] == ("z2m/bridge/request/networkmap", '{"type":"raw","routes":true}')

    # a second request while running is refused
    await client.send_json({"id": 3, "type": WS_SCAN})
    assert (await client.receive_json())["result"]["started"] is False

    # Zigbee2MQTT answers: map event, status back to idle, sensor set, store written
    async_fire_mqtt_message(
        hass, "z2m/bridge/response/networkmap", json.dumps({"status": "ok", "data": {"value": RAW_MAP, "duration": 12}})
    )
    await hass.async_block_till_done()
    msgs = [await client.receive_json() for _ in range(2)]
    map_event = next(m["event"] for m in msgs if m["event"]["type"] == "map")
    assert map_event["map"] == RAW_MAP and map_event["duration"] == 12 and map_event["kind"] == "networkmap"
    assert next(m["event"] for m in msgs if m["event"]["type"] == "status")["scanning"] is None
    sensor = hass.states.get("sensor.zigbee2mqtt_map_last_scan")
    assert sensor.state != "unknown"
    assert sensor.attributes["routers"] == 1 and sensor.attributes["end_devices"] == 1 and sensor.attributes["links"] == 1

    # a new subscriber gets the stored map right away
    client2 = await hass_ws_client(hass)
    await client2.send_json({"id": 1, "type": WS_SUBSCRIBE})
    assert (await client2.receive_json())["success"]
    assert (await client2.receive_json())["event"]["type"] == "status"
    assert (await client2.receive_json())["event"]["map"] == RAW_MAP

    # settings through the entities reach the panel as a status event and change the request topic
    await hass.data[DOMAIN][entry.entry_id].async_set_setting("parallel", True)
    ev = (await client.receive_json())["event"]
    assert ev["type"] == "status" and ev["settings"]["parallel"] is True
    await hass.services.async_call("button", "press", {"entity_id": "button.zigbee2mqtt_map_scan_now"}, blocking=True)
    assert mqtt.async_publish.call_args.args[:2] == ("z2m/bridge/request/networkmap_fast", '{"type":"raw","routes":false}')
    async_fire_mqtt_message(hass, "z2m/bridge/networkmap_fast/progress", json.dumps({"done": 2, "total": 5, "failed": 0}))
    await hass.async_block_till_done()
    evs = [(await client.receive_json())["event"] for _ in range(3)]
    assert any(e["type"] == "progress" and e["done"] == 2 for e in evs)
    async_fire_mqtt_message(hass, "z2m/bridge/response/networkmap_fast", json.dumps({"status": "error", "error": "busy"}))
    await hass.async_block_till_done()
    evs = [(await client.receive_json())["event"] for _ in range(2)]
    assert any(e["type"] == "error" and e["message"] == "busy" for e in evs)

    # unload removes the panel and the subscription stops delivering
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data[frontend.DATA_PANELS]


async def test_scan_needs_admin(hass: HomeAssistant, hass_ws_client, hass_read_only_access_token) -> None:
    await _setup(hass)
    client = await hass_ws_client(hass, hass_read_only_access_token)
    await client.send_json({"id": 1, "type": WS_SCAN})
    reply = await client.receive_json()
    assert reply["success"] is False and reply["error"]["code"] == "unauthorized"
    await client.send_json({"id": 2, "type": WS_SUBSCRIBE})
    assert (await client.receive_json())["success"] is True


async def test_background_schedule(hass: HomeAssistant, mqtt, freezer) -> None:
    from datetime import timedelta
    from pytest_homeassistant_custom_component.common import async_fire_time_changed
    from homeassistant.util import dt as dt_util

    entry = await _setup(hass)
    coordinator = hass.data[DOMAIN][entry.entry_id]
    await coordinator.async_set_setting("background_hours", 1.0)
    mqtt.async_publish.reset_mock()
    freezer.tick(timedelta(minutes=5))
    async_fire_time_changed(hass, dt_util.utcnow())
    await hass.async_block_till_done()
    assert mqtt.async_publish.call_count == 1  # never scanned before: due at once
    async_fire_mqtt_message(hass, "z2m/bridge/response/networkmap", json.dumps({"status": "ok", "data": {"value": RAW_MAP}}))
    await hass.async_block_till_done()
    freezer.tick(timedelta(minutes=30))
    async_fire_time_changed(hass, dt_util.utcnow())
    await hass.async_block_till_done()
    assert mqtt.async_publish.call_count == 1  # 30 min < 1 h
    freezer.tick(timedelta(minutes=29))
    async_fire_time_changed(hass, dt_util.utcnow())
    await hass.async_block_till_done()
    assert mqtt.async_publish.call_count == 2  # 59 min >= 1 h - 90 s slack
