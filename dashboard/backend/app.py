
import json
import os
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone

import psycopg
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS


load_dotenv()

app = Flask(__name__)
CORS(app)

SERVERS = {
    "server1": {
        "name": "Server 1",
        "host": os.getenv("SERVER1_HOST"),
        "port": int(os.getenv("SERVER1_PORT", "5543")),
        "dbname": os.getenv("SERVER1_DB", "postgres"),
        "user": os.getenv("SERVER1_USER"),
        "password": os.getenv("SERVER1_PASSWORD"),
    },
    "server2": {
        "name": "Server 2",
        "host": os.getenv("SERVER2_HOST"),
        "port": int(os.getenv("SERVER2_PORT", "5543")),
        "dbname": os.getenv("SERVER2_DB", "postgres"),
        "user": os.getenv("SERVER2_USER"),
        "password": os.getenv("SERVER2_PASSWORD"),
    },
}

# Docker control is intentionally restricted to the two known PostgreSQL containers.
CONTAINERS = {
    "server1": os.getenv("SERVER1_CONTAINER", "postgres-ha-1"),
    "server2": os.getenv("SERVER2_CONTAINER", "postgres-ha-2"),
}
SERVER2_AGENT_URL = os.getenv("SERVER2_AGENT_URL", "").rstrip("/")
SERVER2_AGENT_TOKEN = os.getenv("SERVER2_AGENT_TOKEN", "")

# Keep the last observed database role while a node is unreachable.
# This prevents a former primary from being started as an independent primary.
LAST_KNOWN_ROLE = {}


def run_docker(args, timeout=30):
    try:
        completed = subprocess.run(
            ["docker", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError("Docker CLI was not found by the Flask backend.")
    except subprocess.TimeoutExpired:
        raise RuntimeError("Docker command timed out.")

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(detail or f"Docker command failed: {' '.join(args)}")
    return completed.stdout.strip()


def server2_agent_request(path, method="GET"):
    if not SERVER2_AGENT_URL or not SERVER2_AGENT_TOKEN:
        raise RuntimeError(
            "Server 2 remote agent is not configured. Set SERVER2_AGENT_URL "
            "and SERVER2_AGENT_TOKEN in the backend .env file."
        )

    request = urllib.request.Request(
        f"{SERVER2_AGENT_URL}{path}",
        method=method,
        headers={
            "Authorization": f"Bearer {SERVER2_AGENT_TOKEN}",
            "Content-Type": "application/json",
        },
        data=b"{}" if method != "GET" else None,
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Server 2 agent returned HTTP {exc.code}: {body}")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Cannot reach Server 2 agent: {exc.reason}")


def get_container_status(server_id):
    container_name = CONTAINERS[server_id]
    if server_id == "server1":
        raw = run_docker(["inspect", container_name])
        data = json.loads(raw)[0]
        state = data.get("State", {})
        return {
            "id": server_id,
            "name": SERVERS[server_id]["name"],
            "container": container_name,
            "available": True,
            "running": bool(state.get("Running")),
            "status": state.get("Status", "unknown"),
            "exit_code": state.get("ExitCode"),
            "error": None,
        }

    data = server2_agent_request("/v1/container/status")
    data.update({"id": "server2", "name": SERVERS["server2"]["name"]})
    return data


def control_container(server_id, action):
    if action not in ("start", "stop"):
        raise ValueError("Unsupported container operation.")

    if server_id == "server1":
        output = run_docker([action, CONTAINERS[server_id]])
        return {"output": output or f"{action} command completed."}

    data = server2_agent_request(f"/v1/container/{action}", method="POST")
    return data



def inspect_server(server_id, config):
    result = {
        "id": server_id,
        "name": config["name"],
        "host": config["host"],
        "port": config["port"],
        "available": False,
        "role": "unknown",
        "postgres_version": None,
        "in_recovery": None,
        "replication": None,
        "error": None,
    }

    try:
        with psycopg.connect(
            host=config["host"],
            port=config["port"],
            dbname=config["dbname"],
            user=config["user"],
            password=config["password"],
            connect_timeout=3,
            options="-c statement_timeout=3000",
        ) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT
                        pg_is_in_recovery(),
                        version(),
                        current_database(),
                        pg_postmaster_start_time()
                """)

                in_recovery, version, database, started_at = cur.fetchone()

                result.update({
                    "available": True,
                    "role": "standby" if in_recovery else "primary",
                    "in_recovery": in_recovery,
                    "postgres_version": version.split(",")[0],
                    "database": database,
                    "started_at": started_at.isoformat(),
                })
                LAST_KNOWN_ROLE[server_id] = result["role"]

                if in_recovery:
                    cur.execute("""
                        SELECT status, sender_host, sender_port,
                            written_lsn, flushed_lsn, latest_end_lsn
                        FROM pg_stat_wal_receiver
                    """)
                    receiver = cur.fetchone()

                    result["replication"] = {
                        "status": receiver[0],
                        "sender_host": receiver[1],
                        "sender_port": receiver[2],
                        "written_lsn": str(receiver[3]) if receiver[3] else None,
                        "flushed_lsn": str(receiver[4]) if receiver[4] else None,
                        "latest_end_lsn": str(receiver[5]) if receiver[5] else None,
                    } if receiver else {
                        "status": "not_connected"
                    }
                else:
                    cur.execute("""
                        SELECT application_name, client_addr,
                               state, sync_state,
                               write_lag, flush_lag, replay_lag
                        FROM pg_stat_replication
                    """)

                    result["replication"] = [
                        {
                            "application_name": row[0],
                            "client_addr": str(row[1]) if row[1] else None,
                            "state": row[2],
                            "sync_state": row[3],
                            "write_lag": str(row[4]) if row[4] else None,
                            "flush_lag": str(row[5]) if row[5] else None,
                            "replay_lag": str(row[6]) if row[6] else None,
                        }
                        for row in cur.fetchall()
                    ]

    except Exception as exc:
        result["error"] = str(exc)

    return result


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "running",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


@app.route("/api/cluster/status", methods=["GET"])
def cluster_status():
    servers = [
        inspect_server(server_id, config)
        for server_id, config in SERVERS.items()
    ]

    available = [s for s in servers if s["available"]]
    primaries = [s for s in available if s["role"] == "primary"]
    standbys = [s for s in available if s["role"] == "standby"]

    if len(primaries) == 1 and len(standbys) == 1:
        cluster_state = "healthy"
    elif len(primaries) > 1:
        cluster_state = "split_brain"
    elif len(primaries) == 0:
        cluster_state = "no_primary"
    else:
        cluster_state = "degraded"

    return jsonify({
        "cluster_state": cluster_state,
        "primary_count": len(primaries),
        "standby_count": len(standbys),
        "servers": servers,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


@app.route("/api/cluster/write-test", methods=["POST"])
def write_test():
    # Discover the current primary.
    statuses = [
        inspect_server(server_id, config)
        for server_id, config in SERVERS.items()
    ]

    primaries = [
        server for server in statuses
        if server["available"] and server["role"] == "primary"
    ]

    # Refuse to write if the primary is ambiguous or unavailable.
    if len(primaries) != 1:
        return jsonify({
            "success": False,
            "error": f"Expected exactly one primary, found {len(primaries)}."
        }), 409

    primary_id = primaries[0]["id"]
    config = SERVERS[primary_id]

    message = (request.json or {}).get(
        "message", "PostgreSQL HA dashboard write test"
    )

    try:
        with psycopg.connect(
            host=config["host"],
            port=config["port"],
            dbname=config["dbname"],
            user=os.getenv("WRITER_USER"),
            password=os.getenv("WRITER_PASSWORD"),
            connect_timeout=5,
            options="-c statement_timeout=5000",
        ) as conn:

            with conn.cursor() as cur:
                # Recheck the role on the actual write connection.
                cur.execute("""
                    SELECT pg_is_in_recovery(), inet_server_addr()
                """)

                in_recovery, server_address = cur.fetchone()

                if in_recovery:
                    return jsonify({
                        "success": False,
                        "error": "Selected server is no longer the primary. Please retry."
                    }), 409

                cur.execute("""
                    INSERT INTO public.ha_dashboard_write_test
                        (message, server_name)
                    VALUES (%s, %s)
                    RETURNING id, created_at
                """, (message, config["name"]))

                record_id, created_at = cur.fetchone()

        return jsonify({
            "success": True,
            "message": "Test record inserted successfully.",
            "record": {
                "id": record_id,
                "message": message,
                "server_name": config["name"],
                "server_address": str(server_address),
                "created_at": created_at.isoformat(),
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    except Exception as exc:
        return jsonify({
            "success": False,
            "error": str(exc),
        }), 500

@app.route("/api/cluster/table-monitor", methods=["GET"])
def table_monitor():
    table_name = "public.ha_dashboard_write_test"
    results = []

    for server_id, config in SERVERS.items():
        server_result = {
            "id": server_id,
            "name": config["name"],
            "available": False,
            "records": [],
            "total_records": 0,
            "error": None,
        }

        try:
            with psycopg.connect(
                host=config["host"],
                port=config["port"],
                dbname=config["dbname"],
                user=config["user"],
                password=config["password"],
                connect_timeout=3,
                options="-c statement_timeout=3000",
            ) as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT id, message, created_at, server_name
                        FROM public.ha_dashboard_write_test
                        ORDER BY id DESC
                        LIMIT 100
                    """)

                    rows = cur.fetchall()

                    cur.execute("""
                        SELECT COUNT(*)
                        FROM public.ha_dashboard_write_test
                    """)

                    total = cur.fetchone()[0]

                    server_result.update({
                        "available": True,
                        "total_records": total,
                        "records": [
                            {
                                "id": row[0],
                                "message": row[1],
                                "created_at": row[2].isoformat(),
                                "server_name": row[3],
                            }
                            for row in rows
                        ],
                    })

        except Exception as exc:
            server_result["error"] = str(exc)

        results.append(server_result)

    return jsonify({
        "table": table_name,
        "servers": results,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


@app.route("/api/admin/containers", methods=["GET"])
def admin_container_status():
    results = []
    for server_id in ("server1", "server2"):
        try:
            status = get_container_status(server_id)
            status["last_known_role"] = LAST_KNOWN_ROLE.get(server_id, "unknown")
            status["start_allowed"] = (
                not status.get("running", False)
                and LAST_KNOWN_ROLE.get(server_id) == "standby"
            )
            if not status["start_allowed"] and not status.get("running", False):
                status["start_block_reason"] = (
                    "The last observed database role was not standby. "
                    "A former primary must be rewound and rejoined before it is started."
                    if LAST_KNOWN_ROLE.get(server_id) != "standby"
                    else "Start is currently unavailable."
                )
            else:
                status["start_block_reason"] = None
        except Exception as exc:
            status = {
                "id": server_id,
                "name": SERVERS[server_id]["name"],
                "container": CONTAINERS[server_id],
                "available": False,
                "running": None,
                "status": "unknown",
                "last_known_role": LAST_KNOWN_ROLE.get(server_id, "unknown"),
                "start_allowed": False,
                "start_block_reason": str(exc),
                "error": str(exc),
            }
        results.append(status)

    return jsonify({
        "containers": results,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


@app.route("/api/admin/primary/stop", methods=["POST"])
def admin_stop_current_primary():
    statuses = [
        inspect_server(server_id, config)
        for server_id, config in SERVERS.items()
    ]
    primaries = [
        item for item in statuses
        if item["available"] and item["role"] == "primary"
    ]
    standbys = [
        item for item in statuses
        if item["available"] and item["role"] == "standby"
    ]

    # A failure simulation is only safe when the standby is currently reachable.
    if len(primaries) != 1 or len(standbys) != 1:
        return jsonify({
            "success": False,
            "error": (
                "Refusing to stop a node: failure simulation requires exactly "
                f"one reachable primary and one reachable standby. "
                f"Found {len(primaries)} primary and {len(standbys)} standby."
            ),
        }), 409

    primary_id = primaries[0]["id"]
    try:
        result = control_container(primary_id, "stop")
        return jsonify({
            "success": True,
            "server_id": primary_id,
            "server_name": SERVERS[primary_id]["name"],
            "message": (
                f"Stop requested for {SERVERS[primary_id]['name']}. "
                "repmgrd must detect the failure and promote the standby."
            ),
            "details": result,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


@app.route("/api/admin/nodes/<server_id>/start", methods=["POST"])
def admin_start_standby(server_id):
    if server_id not in SERVERS:
        return jsonify({"success": False, "error": "Unknown server ID."}), 404

    # Never directly start a node last observed as primary (or with unknown role).
    last_role = LAST_KNOWN_ROLE.get(server_id)
    if last_role != "standby":
        return jsonify({
            "success": False,
            "error": (
                f"Direct start blocked for {SERVERS[server_id]['name']}. "
                "Its last observed role was "
                f"'{last_role}'. A former primary must be rewound and rejoined "
                "using repmgr before its PostgreSQL container is started."
            ),
            "requires_rejoin": True,
        }), 409

    other_id = "server2" if server_id == "server1" else "server1"
    other_status = inspect_server(other_id, SERVERS[other_id])
    if not other_status["available"] or other_status["role"] != "primary":
        return jsonify({
            "success": False,
            "error": "A reachable primary must be confirmed before starting this standby.",
        }), 409

    try:
        container_status = get_container_status(server_id)
        if container_status.get("running"):
            return jsonify({
                "success": False,
                "error": f"{SERVERS[server_id]['name']} container is already running.",
            }), 409

        result = control_container(server_id, "start")
        return jsonify({
            "success": True,
            "server_id": server_id,
            "server_name": SERVERS[server_id]["name"],
            "message": (
                f"{SERVERS[server_id]['name']} container start requested. "
                "The dashboard will verify whether it reconnects as a standby."
            ),
            "details": result,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
