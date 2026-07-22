"""Cluster and host metrics: Docker socket proxy + Glances agents.

Two independent sources, deliberately kept independent:

* **Docker socket proxy** (``/nodes``, ``/services``, ``/tasks``) — the
  authoritative view of the Swarm. Read through ``tecnativa/docker-socket-proxy``
  in read-only mode with only those three endpoint groups enabled, so the
  dashboard never holds a writable Docker socket.
* **Glances agents** — per-host CPU/RAM/disk/network, reached directly on the
  host's LAN address at ``GLANCES_PORT``. Glances runs with ``mode: host`` port
  publishing, so ``Status.Addr`` from ``/nodes`` is the stable address and no
  overlay IP or DNS lookup is involved.

Standalone hosts are polled **without** touching the Docker proxy, and their
poll starts before the proxy call and survives it failing. That is the whole
point: when the Swarm is in trouble, the database and storage hosts are
precisely the ones you still want to see.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

import httpx

from . import config
from .config import ExtraHost

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(config.METRICS_TIMEOUT),
            # One pool for every poll rather than a connection per request: a
            # dashboard open in a browser polls this every few seconds across
            # nine hosts, and TCP setup dominates otherwise.
            limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


# --- Glances ----------------------------------------------------------------


async def _glances(addr: str, endpoint: str) -> Any:
    url = f"http://{addr}:{config.GLANCES_PORT}/api/4/{endpoint}"
    response = await client().get(url)
    response.raise_for_status()
    return response.json()


def _gather_disk(data: Any) -> dict[str, Any]:
    """Glances v4 returns fs as a dict keyed by mount point, or as a list."""
    items = data if isinstance(data, list) else list((data or {}).values())
    root = next((f for f in items if f.get("mnt_point") == "/"), None) or (items[0] if items else None)
    if not root:
        return {"used": None, "total": None, "percent": None}
    return {"used": root.get("used"), "total": root.get("size"), "percent": root.get("percent")}


def _gather_net(data: Any) -> dict[str, float]:
    if isinstance(data, list):
        items = [n for n in data if n.get("interface_name") != "lo"]
    else:
        items = [v for k, v in (data or {}).items() if k != "lo"]
    rx = tx = 0.0
    for n in items:
        dt = n.get("time_since_update") or 1
        rx += n.get("rx_rate") if n.get("rx_rate") is not None else (n.get("rx", 0) or 0) / dt
        tx += n.get("tx_rate") if n.get("tx_rate") is not None else (n.get("tx", 0) or 0) / dt
    return {"rx_rate": rx, "tx_rate": tx}


def _looks_like_container_id(value: str | None) -> bool:
    """Guard against a stale container id turning up as the hostname.

    Glances reports the container id when ``/etc/hostname`` is not bind-mounted;
    a 12- or 64-char hex string is never a real host in this cluster.
    """
    if not value:
        return True
    return len(value) in (12, 64) and all(c in "0123456789abcdefABCDEF" for c in value)


async def poll_host(hostname: str | None, addr: str | None, label: str | None = None) -> dict[str, Any]:
    """One host's full metric set.

    Shared by Swarm nodes and standalone hosts so the two can never drift apart
    in what they report — the frontend renders them with the same card, and a
    difference here would show up as a half-empty card.
    """
    if not addr:
        return {"hostname": hostname, "label": label, "online": False}
    try:
        system, cpu, mem, fs_data, network = await asyncio.gather(
            _glances(addr, "system"),
            _glances(addr, "cpu"),
            _glances(addr, "mem"),
            _glances(addr, "fs"),
            _glances(addr, "network"),
        )
        reported = system.get("hostname") if isinstance(system, dict) else None
        glances_hostname = None if _looks_like_container_id(reported) else reported
        return {
            "hostname": hostname or glances_hostname or addr,
            "label": label,
            "addr": addr,
            "online": True,
            "cpu": cpu.get("total"),
            "mem": {"used": mem.get("used"), "total": mem.get("total"), "percent": mem.get("percent")},
            "disk": _gather_disk(fs_data),
            "net": _gather_net(network),
            "uptime": system.get("uptime") if isinstance(system, dict) else None,
            "os": system.get("os_name") if isinstance(system, dict) else None,
        }
    except Exception:  # noqa: BLE001 — unreachable, timed out, or garbage back
        print(f"[metrics] OFFLINE {hostname} ({addr})")
        return {"hostname": hostname, "label": label, "addr": addr, "online": False}


async def poll_extra_hosts(hosts: list[ExtraHost] | None = None) -> list[dict[str, Any]]:
    hosts = config.EXTRA_HOSTS if hosts is None else hosts
    results = await asyncio.gather(*(poll_host(h.hostname, h.addr, h.label) for h in hosts))
    return sorted(results, key=lambda r: (r["hostname"] or ""))


# --- Docker socket proxy ----------------------------------------------------


async def _docker(path: str) -> Any:
    response = await client().get(f"{config.DOCKER_PROXY_URL}{path}")
    response.raise_for_status()
    return response.json()


async def swarm_snapshot() -> dict[str, Any]:
    """Nodes, services and tasks in one round trip set.

    Raises on failure — callers decide whether that is a 503 or a degraded tile.
    """
    task_filter = json.dumps({"service": [config.GLANCES_SERVICE]})
    nodes, services, tasks, glances_tasks = await asyncio.gather(
        _docker("/nodes"),
        _docker("/services"),
        _docker("/tasks"),
        _docker(f"/tasks?filters={task_filter}"),
    )
    return {
        "nodes": nodes if isinstance(nodes, list) else [],
        "services": services if isinstance(services, list) else [],
        "tasks": tasks if isinstance(tasks, list) else [],
        "glances_tasks": glances_tasks if isinstance(glances_tasks, list) else [],
    }


def node_info(node: dict[str, Any]) -> dict[str, Any]:
    manager_status = node.get("ManagerStatus") or {}
    return {
        "id": node.get("ID"),
        "hostname": (node.get("Description") or {}).get("Hostname") or node.get("ID"),
        "addr": (node.get("Status") or {}).get("Addr"),
        "state": (node.get("Status") or {}).get("State"),
        "availability": (node.get("Spec") or {}).get("Availability"),
        "role": (node.get("Spec") or {}).get("Role", "worker"),
        "is_manager": (node.get("Spec") or {}).get("Role") == "manager",
        "is_leader": bool(manager_status.get("Leader")),
        "reachability": manager_status.get("Reachability"),
    }


async def collect(snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    """Full metrics payload: Swarm node cards + standalone host cards.

    Standalone hosts are kept in a separate key rather than merged into
    ``nodes``: they are not Swarm members, and folding them in would quietly
    inflate the "nodes online X/Y" tile into a number that no longer describes
    the cluster.
    """
    extra_task = asyncio.ensure_future(poll_extra_hosts())

    try:
        snap = snapshot if snapshot is not None else await swarm_snapshot()
    except Exception as err:  # noqa: BLE001
        print(f"[metrics] docker proxy unavailable: {err}")
        return {
            "nodes": [],
            "extraHosts": await extra_task,
            "swarm": None,
            "error": "PROXY_UNAVAILABLE",
        }

    nodes = [node_info(n) for n in snap["nodes"]]
    by_id = {n["id"]: n for n in nodes}

    running_glances = {
        t.get("NodeID")
        for t in snap["glances_tasks"]
        if (t.get("Status") or {}).get("State") == "running"
    }
    live = [n for n in nodes if n["id"] in running_glances]

    print(
        f"[metrics] poll — nodes:{len(nodes)} glances-running:{len(running_glances)} "
        f"addrs=[{', '.join(n['addr'] or '?' for n in live) or 'none'}]"
    )

    polled = await asyncio.gather(*(poll_host(n["hostname"], n["addr"]) for n in live))
    metrics_by_host = {p["hostname"]: p for p in polled}

    cards: list[dict[str, Any]] = []
    for node in nodes:
        card = metrics_by_host.get(node["hostname"]) or {"hostname": node["hostname"], "online": False}
        cards.append(
            {
                **card,
                "role": node["role"],
                "isLeader": node["is_leader"],
                "swarmState": node["state"],
                "availability": node["availability"],
            }
        )
    cards.sort(key=lambda c: (c["hostname"] or ""))

    extra = await extra_task
    responded = sum(1 for c in cards if c.get("online"))
    print(f"[metrics] responded: {responded}/{len(nodes)} swarm, "
          f"{sum(1 for e in extra if e['online'])}/{len(extra)} standalone")

    return {
        "nodes": cards,
        "extraHosts": extra,
        "swarm": swarm_summary(nodes, snap),
        "error": None,
    }


def swarm_summary(nodes: list[dict[str, Any]], snap: dict[str, Any]) -> dict[str, Any]:
    managers = [n for n in nodes if n["is_manager"]]
    reachable_managers = [m for m in managers if m["reachability"] == "reachable"]
    services = snap["services"]
    tasks = snap["tasks"]

    running_by_service: dict[str, int] = {}
    for t in tasks:
        if (t.get("Status") or {}).get("State") == "running":
            sid = t.get("ServiceID")
            running_by_service[sid] = running_by_service.get(sid, 0) + 1

    service_status = []
    for s in services:
        spec = s.get("Spec") or {}
        mode = spec.get("Mode") or {}
        replicated = mode.get("Replicated") or {}
        desired = replicated.get("Replicas")
        if desired is None:
            # Global mode: one task per node that satisfies the constraints.
            desired = len([n for n in nodes if n["state"] == "ready"]) if "Global" in mode else 1
        service_status.append(
            {
                "id": s.get("ID"),
                "name": spec.get("Name", ""),
                "running": running_by_service.get(s.get("ID"), 0),
                "desired": desired,
            }
        )
    service_status.sort(key=lambda s: s["name"])

    return {
        "nodesTotal": len(nodes),
        "nodesReady": sum(1 for n in nodes if n["state"] == "ready"),
        "managersTotal": len(managers),
        "managersReachable": len(reachable_managers),
        "hasLeader": any(m["is_leader"] for m in managers),
        "servicesTotal": len(services),
        "services": service_status,
    }


# --- Backup status ----------------------------------------------------------
#
# Reads the per-node JSON files the backup script drops into the shared storage
# directory. Deliberately NOT moved into PostgreSQL: the producer is a shell
# script that would otherwise need a psql client and database credentials on
# every node, and a file drop is the simpler contract for that.


def backup_status() -> dict[str, Any]:
    directory = config.BACKUP_STATUS_DIR
    empty = {"display_status": "unknown", "most_recent": None, "nodes": []}
    if not directory.is_dir():
        return empty

    entries: list[dict[str, Any]] = []
    try:
        files = sorted(directory.glob("*.json"))
    except OSError:
        return empty

    now = datetime.now(timezone.utc)
    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            last_run = data.get("last_run")
            age = None
            if last_run:
                parsed = datetime.fromisoformat(str(last_run).replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                age = (now - parsed).total_seconds()
            stale = age is None or age > config.BACKUP_STALE_SECONDS
            display = "failed" if data.get("status") == "failed" else ("stale" if stale else "ok")
            entries.append({**data, "display_status": display})
        except (OSError, ValueError, TypeError):
            continue  # a half-written or malformed drop must not break the tile

    entries.sort(key=lambda e: str(e.get("last_run") or ""), reverse=True)

    display = "unknown" if not entries else "ok"
    for entry in entries:
        if entry["display_status"] == "failed":
            display = "failed"
            break
        if entry["display_status"] == "stale" and display == "ok":
            display = "stale"

    return {
        "display_status": display,
        "most_recent": entries[0].get("last_run") if entries else None,
        "nodes": entries,
    }


# --- Status tiles -----------------------------------------------------------


def build_tiles(metrics: dict[str, Any], backup: dict[str, Any]) -> dict[str, Any]:
    """The five headline tiles, computed server-side.

    Deliberately not left to the frontend: every one of these is an X-of-Y that
    was wrong at some point because two different views each counted it their
    own way. There is now exactly one implementation.
    """
    swarm = metrics.get("swarm")
    nodes = metrics.get("nodes") or []
    extra = metrics.get("extraHosts") or []

    # "Nodes online" counts Swarm members ANSWERING GLANCES, against the total
    # number of Swarm members. A node that is 'ready' in Docker but whose Glances
    # agent is down is not online for our purposes — we have no metrics for it.
    nodes_reporting = sum(1 for n in nodes if n.get("online"))
    nodes_total = swarm["nodesTotal"] if swarm else len(nodes)

    extra_online = sum(1 for e in extra if e.get("online"))
    extra_total = len(extra)

    if swarm is None:
        cluster_state, cluster_detail = "unknown", "PROXY_UNAVAILABLE"
    elif swarm["managersTotal"] == 0:
        cluster_state, cluster_detail = "unknown", "NO_MANAGERS"
    elif not swarm["hasLeader"]:
        cluster_state, cluster_detail = "critical", "NO_LEADER"
    elif swarm["managersReachable"] < swarm["managersTotal"]:
        cluster_state, cluster_detail = "warning", "MANAGER_UNREACHABLE"
    elif swarm["nodesReady"] < swarm["nodesTotal"]:
        cluster_state, cluster_detail = "warning", "NODE_DOWN"
    else:
        cluster_state, cluster_detail = "healthy", "ALL_REACHABLE"

    return {
        "nodes": {
            "value": nodes_reporting,
            "total": nodes_total,
            "state": _fraction_state(nodes_reporting, nodes_total),
        },
        "services": {
            "value": swarm["servicesTotal"] if swarm else None,
            "state": "unknown" if swarm is None else "healthy",
        },
        "cluster": {
            "state": cluster_state,
            "detail": cluster_detail,
            "managersReachable": swarm["managersReachable"] if swarm else None,
            "managersTotal": swarm["managersTotal"] if swarm else None,
        },
        "infrastructure": {
            "value": extra_online,
            "total": extra_total,
            "state": _fraction_state(extra_online, extra_total),
        },
        "backup": {
            "state": {"ok": "healthy", "stale": "warning", "failed": "critical"}.get(
                backup["display_status"], "unknown"
            ),
            "lastRun": backup["most_recent"],
            "detail": backup["display_status"],
            "nodes": len(backup["nodes"]),
        },
    }


def _fraction_state(value: int, total: int) -> str:
    if total == 0:
        return "unknown"
    if value == total:
        return "healthy"
    if value == 0:
        return "critical"
    return "warning"
