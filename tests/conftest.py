"""Shared fixtures: custom integrations enabled, a mocked MQTT broker."""

import pytest


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture(autouse=True)
async def mqtt(mqtt_mock):
    """Every test runs with the MQTT integration mocked and set up."""
    return mqtt_mock


@pytest.fixture
def expected_lingering_timers() -> bool:
    """The mocked MQTT client leaves its own periodic timer behind; that is HA's, not ours."""
    return True
