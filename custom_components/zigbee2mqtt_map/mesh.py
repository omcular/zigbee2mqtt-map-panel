"""The two mesh numbers, computed from a raw Zigbee2MQTT network map.

This is the one implementation: the integration runs it after every scan, stores the result with the map and
exposes it as sensors; the panel shows what it receives and computes nothing itself.

  connected at >= C : the highest LQI threshold at which every router still reaches the coordinator
  redundant at >= R : the highest threshold at which no single router is a point of failure (removing any one
                      router leaves every other router connected to the coordinator)

Both use the weaker direction of each two-sided router link. Routers without any two-sided link (dead, or just
paired and not yet scanned) are left out and listed in `ignored`. Also found: the link that limits C (`bottleneck`,
with the routers it would cut off) and, for R, the router that becomes a single point of failure just above R
(`spof`, with the routers it would cut off). Nodes marked `removed` (gone from Zigbee2MQTT after the scan) and
their links are not part of the mesh.
"""

from __future__ import annotations

from typing import Any

COORDINATOR = "Coordinator"
END_LIKE = ("EndDevice", "Unknown")


def _classify(raw: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Raw map -> nodes by id (insertion order kept) and paired links with the weaker direction.

    In a raw link, `source` is the neighbour and `target` the device that reported it; `lqi` is what the target
    hears from the source. Link endpoints missing from the node list are unknown devices and count as end-like.
    """
    removed = {n.get("ieeeAddr") for n in raw.get("nodes", []) if n.get("removed")}
    nodes: dict[str, dict[str, Any]] = {}
    for n in raw.get("nodes", []):
        ieee = n.get("ieeeAddr")
        if not ieee or ieee in removed:
            continue
        kind = n.get("type") or "Unknown"
        nodes[ieee] = {"name": n.get("friendlyName") or ieee, "type": kind, "is_end": kind in END_LIKE}
    raw_links = [
        l for l in raw.get("links", [])
        if l.get("sourceIeeeAddr") and l.get("targetIeeeAddr")
        and l["sourceIeeeAddr"] not in removed and l["targetIeeeAddr"] not in removed
    ]
    for l in raw_links:
        for ieee in (l["sourceIeeeAddr"], l["targetIeeeAddr"]):
            if ieee not in nodes:
                nodes[ieee] = {"name": f"{ieee} (not in device list)", "type": "Unknown", "is_end": True}
    pairs: dict[tuple[str, str], dict[str, Any]] = {}
    for l in raw_links:
        a, b = sorted((l["sourceIeeeAddr"], l["targetIeeeAddr"]))
        pairs.setdefault((a, b), {})[l["targetIeeeAddr"]] = l.get("lqi")
    links: list[dict[str, Any]] = []
    for (a, b), hear in pairs.items():
        lq_a, lq_b = hear.get(a), hear.get(b)  # what a hears / what b hears
        end_link = nodes[a]["is_end"] or nodes[b]["is_end"]
        if end_link:
            vals = [v for v in (lq_a, lq_b) if v is not None and v > 0]
            weakest = min(vals) if vals else 0
        else:
            weakest = min(999 if lq_a is None else lq_a, 999 if lq_b is None else lq_b)
        one_sided = not end_link and (lq_a is None or lq_b is None or lq_a == 0 or lq_b == 0)
        links.append({"s": a, "t": b, "min": weakest, "end_link": end_link, "one_sided": one_sided})
    return nodes, links


def mesh_from_map(raw: dict[str, Any]) -> dict[str, Any] | None:
    """See the module docstring. Returns None when there is no coordinator or fewer than two members."""
    nodes, links = _classify(raw)
    coord = next((ieee for ieee, n in nodes.items() if n["type"] == COORDINATOR), None)
    usable = [l for l in links if not l["end_link"] and not l["one_sided"] and l["min"] > 0]
    linked = {ieee for l in usable for ieee in (l["s"], l["t"])}
    routers = [ieee for ieee, n in nodes.items() if not n["is_end"] and n["type"] != COORDINATOR]
    members = [ieee for ieee in routers if ieee in linked]
    if coord:
        members.append(coord)
    ignored = [nodes[ieee]["name"] for ieee in routers if ieee not in linked]
    if not coord or len(members) < 2:
        return None

    def reach(threshold: int, without: str | None = None) -> set[str]:
        adj: dict[str, list[str]] = {ieee: [] for ieee in members}
        for l in usable:
            if l["min"] >= threshold and l["s"] != without and l["t"] != without:
                adj[l["s"]].append(l["t"])
                adj[l["t"]].append(l["s"])
        seen = {coord}
        stack = [coord]
        while stack:
            x = stack.pop()
            for y in adj[x]:
                if y not in seen and y != without:
                    seen.add(y)
                    stack.append(y)
        return seen

    def all_in(threshold: int, without: str | None = None) -> bool:
        return len(reach(threshold, without)) == len(members) - (1 if without else 0)

    values = sorted({l["min"] for l in usable})  # candidate thresholds, ascending

    def best(test) -> int:  # monotone: once a threshold fails, every higher one fails
        result = 0
        for t in values:
            if test(t):
                result = t
            else:
                break
        return result

    connected = best(lambda t: all_in(t))
    redundant = best(lambda t: all_in(t) and all(ieee == coord or all_in(t, ieee) for ieee in members))

    def next_above(v: int) -> int | None:
        return next((t for t in values if t > v), None)

    bottleneck = None
    if (tc := next_above(connected)) is not None:
        r = reach(tc)
        lost = [ieee for ieee in members if ieee not in r]
        link = next((l for l in usable if l["min"] == connected and ((l["s"] in r) != (l["t"] in r))), None)
        if link:
            bottleneck = {"source": link["s"], "target": link["t"], "lost": lost}
    spof = None
    if (tr := next_above(redundant)) is not None:
        base = reach(tr)
        for ieee in members:
            if ieee == coord:
                continue
            r = reach(tr, ieee)
            lost = [x for x in members if x != ieee and x in base and x not in r]  # only routers reachable at all at that level count as cut off
            if lost:
                spof = {"id": ieee, "lost": lost}
                break
    return {
        "connected": connected,
        "redundant": redundant,
        "routers": len(members) - 1,
        "ignored": ignored,
        "bottleneck": bottleneck,
        "spof": spof,
    }
