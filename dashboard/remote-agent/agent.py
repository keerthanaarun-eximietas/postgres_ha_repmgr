\
import hmac
import os
import subprocess
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()

app = Flask(__name__)

TOKEN = os.getenv("AGENT_TOKEN", "")
ALLOWED_SOURCE_IPS = {
    value.strip()
    for value in os.getenv("ALLOWED_SOURCE_IPS", "192.168.28.12").split(",")
    if value.strip()
}
CONTAINER_NAME = os.getenv("POSTGRES_CONTAINER", "postgres-ha-2")


def authorized(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        source_ip = request.remote_addr or ""
        if ALLOWED_SOURCE_IPS and source_ip not in ALLOWED_SOURCE_IPS:
            return jsonify({"error": "Source IP is not allowed."}), 403

        supplied = request.headers.get("Authorization", "")
        expected = f"Bearer {TOKEN}"
        if not TOKEN or not hmac.compare_digest(supplied, expected):
            return jsonify({"error": "Unauthorized."}), 401
        return fn(*args, **kwargs)
    return wrapper


def docker(args, timeout=30):
    try:
        result = subprocess.run(
            ["docker", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError("Docker CLI was not found. Ensure Docker Desktop is running.")
    except subprocess.TimeoutExpired:
        raise RuntimeError("Docker command timed out.")

    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip() or "Docker command failed.")
    return result.stdout.strip()


@app.get("/v1/health")
@authorized
def health():
    return jsonify({"status": "ok", "service": "postgres-ha-remote-agent"})


@app.get("/v1/container/status")
@authorized
def container_status():
    try:
        raw = docker(["inspect", CONTAINER_NAME])
        import json
        data = json.loads(raw)[0]
        state = data.get("State", {})
        return jsonify({
            "container": CONTAINER_NAME,
            "available": True,
            "running": bool(state.get("Running")),
            "status": state.get("Status", "unknown"),
            "exit_code": state.get("ExitCode"),
            "error": None,
        })
    except Exception as exc:
        return jsonify({
            "container": CONTAINER_NAME,
            "available": False,
            "running": None,
            "status": "unknown",
            "error": str(exc),
        }), 502


@app.post("/v1/container/stop")
@authorized
def stop_container():
    try:
        output = docker(["stop", CONTAINER_NAME], timeout=45)
        return jsonify({
            "success": True,
            "container": CONTAINER_NAME,
            "message": output or "Container stopped.",
        })
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


@app.post("/v1/container/start")
@authorized
def start_container():
    # This endpoint is only called by the Server 1 backend after it confirms
    # that this node was last observed as a standby and the other node is primary.
    try:
        output = docker(["start", CONTAINER_NAME], timeout=45)
        return jsonify({
            "success": True,
            "container": CONTAINER_NAME,
            "message": output or "Container started.",
        })
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


if __name__ == "__main__":
    # For production use, run via Waitress (see run.ps1).
    app.run(host="0.0.0.0", port=int(os.getenv("AGENT_PORT", "5051")), debug=False)
