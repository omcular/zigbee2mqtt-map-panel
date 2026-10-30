"""Constants for the Zigbee2MQTT map integration."""

from __future__ import annotations

DOMAIN = "zigbee2mqtt_map"
VERSION = "2.1.0"

CONF_BASE_TOPIC = "base_topic"
CONF_SIDEBAR_TITLE = "sidebar_title"
CONF_REQUIRE_ADMIN = "require_admin"
CONF_Z2M_URL = "z2m_url"  # Zigbee2MQTT frontend, optional: the panel links devices to <url>/#/device/<ieee>/info

DEFAULT_BASE_TOPIC = "zigbee2mqtt"
DEFAULT_SIDEBAR_TITLE = "Zigbee map"
DEFAULT_REQUIRE_ADMIN = True

PANEL_URL_PATH = "zigbee-map"
PANEL_ICON = "mdi:zigbee"
PANEL_ELEMENT = "zigbee-map-panel"
PANEL_FILE = "zigbee2mqtt-map-panel.js"
STATIC_URL = f"/{DOMAIN}/static"

STORE_KEY = f"{DOMAIN}.map"
STORE_VERSION = 1

SCAN_KIND_NORMAL = "networkmap"
SCAN_KIND_FAST = "networkmap_fast"
FIRST_SCAN_DELAY = 20  # s after setup with no stored map: the first scan without anyone pressing anything (Z2M may still be starting)
SCAN_TIMEOUT = 600  # s, Zigbee2MQTT's own scan of a large mesh can take minutes
TIMER_INTERVAL = 300  # s, how often the background schedule is checked
SCHEDULE_SLACK = 90  # s, a scan due "every 2 h" may run this much early so a 5-min timer does not slip a whole tick
DETECT_SECONDS = 3.0  # how long the config flow listens for retained <base>/bridge/state messages

# settings kept in the store, with defaults
SETTING_BACKGROUND_HOURS = "background_hours"
SETTING_VIEWING_MINUTES = "viewing_minutes"
SETTING_PARALLEL = "parallel"
DEFAULT_SETTINGS = {SETTING_BACKGROUND_HOURS: 0.0, SETTING_VIEWING_MINUTES: 10, SETTING_PARALLEL: False}

WS_SUBSCRIBE = f"{DOMAIN}/subscribe"
WS_SCAN = f"{DOMAIN}/scan"
WS_PERMIT_JOIN = f"{DOMAIN}/permit_join"
PERMIT_JOIN_SECONDS = 254  # Zigbee2MQTT's maximum; it closes the network itself when the time is up

EVENT_STATUS = "status"
EVENT_MAP = "map"
EVENT_PROGRESS = "progress"
EVENT_ERROR = "error"
EVENT_SCAN_STARTED = "scan_started"
EVENT_Z2M = "z2m_event"  # device_joined / device_announce / device_interview / device_leave from <base>/bridge/event
