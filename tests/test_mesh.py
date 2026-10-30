"""The mesh numbers on a hand-computed graph (the panel shows exactly these, it computes nothing itself)."""

from __future__ import annotations

from custom_components.zigbee2mqtt_map.mesh import mesh_from_map


def _node(ieee: str, name: str, kind: str = "Router", **extra):
    return {"ieeeAddr": ieee, "friendlyName": name, "type": kind, **extra}


def _pair(a: str, b: str, a_hears: int | None, b_hears: int | None):
    """Both directions as Zigbee2MQTT reports them: target = the reporting device, lqi = what it hears from source."""
    links = []
    if a_hears is not None:
        links.append({"sourceIeeeAddr": b, "targetIeeeAddr": a, "lqi": a_hears})
    if b_hears is not None:
        links.append({"sourceIeeeAddr": a, "targetIeeeAddr": b, "lqi": b_hears})
    return links


# coordinator C; routers A, B, D, E; F has a one-sided link only; S is an end device; G is removed (gone from Zigbee2MQTT)
NODES = [
    _node("C", "Coordinator", "Coordinator"),
    _node("A", "Router A"),
    _node("B", "Router B"),
    _node("D", "Router D"),
    _node("E", "Router E"),
    _node("F", "Router F"),
    _node("S", "Sensor", "EndDevice"),
    _node("G", "Gone", removed=True),
]
LINKS = (
    _pair("C", "A", 200, 210) + _pair("C", "B", 150, 160) + _pair("A", "B", 120, 130) + _pair("B", "D", 100, 110)
    + _pair("A", "D", 90, 95) + _pair("A", "E", 70, 75) + _pair("D", "E", 60, 65)
    + _pair("A", "F", 180, None)  # F reports nothing: one-sided, F is ignored
    + _pair("A", "S", 255, None)  # end device: never part of the mesh
    + _pair("C", "G", 255, 255)  # removed with its links
)


def test_hand_computed_graph() -> None:
    m = mesh_from_map({"nodes": NODES, "links": LINKS})
    assert m["connected"] == 70  # above 70 the A–E link goes and E only has D–E at 60 left
    assert m["bottleneck"] == {"source": "A", "target": "E", "lost": ["E"]}
    assert m["redundant"] == 60  # at 70, removing A leaves E with D–E (60) only
    assert m["spof"] == {"id": "A", "lost": ["E"]}
    assert m["ignored"] == ["Router F"]
    assert m["routers"] == 4  # A B D E: F ignored, G removed, S an end device


def test_zero_on_one_side_is_one_sided() -> None:
    nodes = [_node("C", "Coordinator", "Coordinator"), _node("A", "A"), _node("B", "B")]
    links = _pair("C", "A", 200, 200) + _pair("A", "B", 0, 150)
    m = mesh_from_map({"nodes": nodes, "links": links})
    assert m["connected"] == 200 and m["ignored"] == ["B"] and m["routers"] == 1


def test_unknown_endpoint_counts_as_end_device() -> None:
    nodes = [_node("C", "Coordinator", "Coordinator"), _node("A", "A")]
    links = _pair("C", "A", 120, 120) + _pair("A", "0xghost", 200, 200)
    m = mesh_from_map({"nodes": nodes, "links": links})
    assert m["connected"] == 120 and m["routers"] == 1 and m["bottleneck"] is None and m["spof"] is None


def test_degenerate_maps() -> None:
    assert mesh_from_map({"nodes": [], "links": []}) is None
    assert mesh_from_map({"nodes": [_node("A", "A")], "links": []}) is None  # no coordinator
    m = mesh_from_map({"nodes": [_node("C", "Coordinator", "Coordinator"), _node("A", "A")], "links": []})  # nobody linked: zeros, A ignored
    assert m == {"connected": 0, "redundant": 0, "routers": 0, "ignored": ["A"], "bottleneck": None, "spof": None}
