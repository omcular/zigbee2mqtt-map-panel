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

from custom_components.zigbee2mqtt_map.const import CONF_BASE_TOPIC, DOMAIN, PANEL_URL_PATH, WS_PERMIT_JOIN, WS_SCAN, WS_SUBSCRIBE

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


async def test_rename_reaches_the_stored_map(hass: HomeAssistant, hass_ws_client, mqtt) -> None:
    """A friendly-name change in Zigbee2MQTT's device list patches the stored map and is pushed to subscribers."""
    await _setup(hass)
    async_fire_mqtt_message(hass, "z2m/bridge/response/networkmap", json.dumps({"status": "ok", "data": {"value": RAW_MAP}}))
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": WS_SUBSCRIBE})
    assert (await client.receive_json())["success"]
    assert (await client.receive_json())["event"]["type"] == "status"
    first = (await client.receive_json())["event"]
    assert first["type"] == "map" and "updatedAt" not in first

    devices = [
        {"ieee_address": "0x1", "friendly_name": "Coordinator", "type": "Coordinator"},
        {"ieee_address": "0x2", "friendly_name": "Router B", "type": "Router"},
        {"ieee_address": "0x3", "friendly_name": "Sensor", "type": "EndDevice"},
    ]
    async_fire_mqtt_message(hass, "z2m/bridge/devices", json.dumps(devices))
    await hass.async_block_till_done()
    ev = (await client.receive_json())["event"]
    assert ev["type"] == "map" and ev["fetchedAt"] == first["fetchedAt"] and ev["updatedAt"]
    assert [n["friendlyName"] for n in ev["map"]["nodes"]] == ["Coordinator", "Router B", "Sensor"]
    assert not any("removed" in n for n in ev["map"]["nodes"])

    # the same list again, an unreadable one, or one without the coordinator (partial, at start-up): nothing happens
    async_fire_mqtt_message(hass, "z2m/bridge/devices", json.dumps(devices))
    async_fire_mqtt_message(hass, "z2m/bridge/devices", "not json")
    async_fire_mqtt_message(hass, "z2m/bridge/devices", json.dumps([devices[1]]))
    await hass.async_block_till_done()
    coordinator = hass.data[DOMAIN][next(iter(hass.data[DOMAIN]))]
    await coordinator.async_set_setting("parallel", True)
    assert (await client.receive_json())["event"]["type"] == "status"

    # a joined device (0x9) appears as a node without links; a device gone from the list (0x3) is marked, not dropped
    devices = [
        {"ieee_address": "0x1", "friendly_name": "Coordinator", "type": "Coordinator"},
        {"ieee_address": "0x2", "friendly_name": "Router B", "type": "Router"},
        {"ieee_address": "0x9", "friendly_name": "New plug", "type": "Router", "network_address": 99,
         "definition": {"vendor": "Nous", "model": "A1Z", "description": "Smart plug", "exposes": []}},
    ]
    async_fire_mqtt_message(hass, "z2m/bridge/devices", json.dumps(devices))
    await hass.async_block_till_done()
    ev = (await client.receive_json())["event"]
    nodes = {n["ieeeAddr"]: n for n in ev["map"]["nodes"]}
    assert set(nodes) == {"0x1", "0x2", "0x3", "0x9"}
    assert nodes["0x9"]["friendlyName"] == "New plug" and nodes["0x9"]["networkAddress"] == 99
    assert nodes["0x9"]["definition"] == {"vendor": "Nous", "model": "A1Z", "description": "Smart plug"}
    assert nodes["0x3"]["removed"] is True and "removed" not in nodes["0x2"] and "removed" not in nodes["0x9"]
    assert len(ev["map"]["links"]) == 1  # links of a removed device stay (the panel greys them)

    # the device comes back (re-paired with the same address): the mark goes
    devices.append({"ieee_address": "0x3", "friendly_name": "Sensor", "type": "EndDevice"})
    async_fire_mqtt_message(hass, "z2m/bridge/devices", json.dumps(devices))
    await hass.async_block_till_done()
    ev = (await client.receive_json())["event"]
    assert "removed" not in next(n for n in ev["map"]["nodes"] if n["ieeeAddr"] == "0x3")

    # a scan answer is the mesh as it is: it replaces the patched map wholesale
    async_fire_mqtt_message(hass, "z2m/bridge/response/networkmap", json.dumps({"status": "ok", "data": {"value": RAW_MAP}}))
    await hass.async_block_till_done()
    msgs = [(await client.receive_json())["event"] for _ in range(2)]
    assert next(m for m in msgs if m["type"] == "map")["map"] == RAW_MAP


async def test_permit_join(hass: HomeAssistant, hass_ws_client, mqtt) -> None:
    """Bridge info drives the countdown in the status, the command publishes the request, the pairing feed is forwarded."""
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": WS_SUBSCRIBE})
    assert (await client.receive_json())["success"]
    assert (await client.receive_json())["event"]["permit_join_end"] is None

    async_fire_mqtt_message(hass, "z2m/bridge/info", json.dumps({"permit_join": True, "permit_join_end": 1800000000000, "version": "2.14.2"}))
    await hass.async_block_till_done()
    ev = (await client.receive_json())["event"]
    assert ev["type"] == "status" and ev["permit_join_end"] == "2027-01-15T08:00:00+00:00"
    async_fire_mqtt_message(hass, "z2m/bridge/info", json.dumps({"permit_join": True, "permit_join_end": 1800000000000}))  # unchanged: silent
    async_fire_mqtt_message(hass, "z2m/bridge/info", json.dumps({"permit_join": False}))
    await hass.async_block_till_done()
    assert (await client.receive_json())["event"]["permit_join_end"] is None

    await client.send_json({"id": 2, "type": WS_PERMIT_JOIN, "device": "0x2"})
    assert (await client.receive_json())["result"] == {"published": True}
    assert mqtt.async_publish.call_args.args[:2] == ("z2m/bridge/request/permit_join", '{"time":254,"device":"0x2"}')
    await client.send_json({"id": 3, "type": WS_PERMIT_JOIN, "time": 0})
    assert (await client.receive_json())["result"] == {"published": True}
    assert mqtt.async_publish.call_args.args[:2] == ("z2m/bridge/request/permit_join", '{"time":0}')
    await client.send_json({"id": 4, "type": WS_PERMIT_JOIN, "time": 300})
    assert (await client.receive_json())["success"] is False

    async_fire_mqtt_message(hass, "z2m/bridge/response/permit_join", json.dumps({"status": "error", "error": "Device 'x' does not exist"}))
    await hass.async_block_till_done()
    ev = (await client.receive_json())["event"]
    assert ev["type"] == "error" and ev["message"] == "permit join: Device 'x' does not exist"
    async_fire_mqtt_message(hass, "z2m/bridge/response/permit_join", json.dumps({"status": "ok", "data": {"time": 254}}))
    await hass.async_block_till_done()
    ev = (await client.receive_json())["event"]
    assert ev == {"type": "z2m_event", "event": "permit_join", "status": "ok", "time": 254}

    async_fire_mqtt_message(
        hass, "z2m/bridge/event",
        json.dumps({"type": "device_interview", "data": {"friendly_name": "0x9", "ieee_address": "0x9", "status": "successful", "supported": True,
                                                         "definition": {"vendor": "Nous", "model": "A1Z", "description": "plug"}}}),
    )
    async_fire_mqtt_message(hass, "z2m/bridge/event", json.dumps({"type": "device_options", "data": {}}))  # not a pairing event
    async_fire_mqtt_message(hass, "z2m/bridge/event", json.dumps({"type": "device_leave", "data": {"friendly_name": "Old", "ieee_address": "0x3"}}))
    await hass.async_block_till_done()
    evs = [(await client.receive_json())["event"] for _ in range(2)]
    assert evs[0] == {"type": "z2m_event", "event": "device_interview", "friendly_name": "0x9", "ieee_address": "0x9", "status": "successful",
                      "supported": True, "model": "A1Z", "vendor": "Nous"}
    assert evs[1]["event"] == "device_leave" and evs[1]["friendly_name"] == "Old" and evs[1]["model"] is None


async def test_permit_join_needs_admin(hass: HomeAssistant, hass_ws_client, hass_read_only_access_token, mqtt) -> None:
    await _setup(hass)
    client = await hass_ws_client(hass, hass_read_only_access_token)
    await client.send_json({"id": 1, "type": WS_PERMIT_JOIN})
    reply = await client.receive_json()
    assert reply["success"] is False and reply["error"]["code"] == "unauthorized"
    assert not any(c.args[0].endswith("permit_join") for c in mqtt.async_publish.call_args_list)


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


async def test_first_scan_after_install(hass: HomeAssistant, mqtt, freezer) -> None:
    """A fresh install (no stored map) scans once by itself shortly after setup."""
    from datetime import timedelta
    from pytest_homeassistant_custom_component.common import async_fire_time_changed
    from homeassistant.util import dt as dt_util

    await _setup(hass)
    mqtt.async_publish.reset_mock()
    freezer.tick(timedelta(seconds=25))
    async_fire_time_changed(hass, dt_util.utcnow())
    await hass.async_block_till_done()
    assert mqtt.async_publish.call_count == 1
    assert mqtt.async_publish.call_args.args[:2] == ("z2m/bridge/request/networkmap", '{"type":"raw","routes":false}')


def test_version_in_sync() -> None:
    """manifest.json, const.VERSION and the panel's VERSION must agree (tools/bump_version.sh sets all three)."""
    import json
    import re
    from pathlib import Path

    from custom_components.zigbee2mqtt_map.const import VERSION

    d = Path(__file__).resolve().parents[1] / "custom_components" / "zigbee2mqtt_map"
    assert json.loads((d / "manifest.json").read_text())["version"] == VERSION
    js = (d / "frontend" / "zigbee2mqtt-map-panel.js").read_text()
    assert re.search(r"^const VERSION = '([0-9.]+)';", js, re.M).group(1) == VERSION
