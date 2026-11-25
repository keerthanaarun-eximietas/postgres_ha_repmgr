#!/usr/bin/env bash

set -Eeuo pipefail

EXPECTED_HOST="EXILP-PG057VNG"
CONTAINERS=("repmgrd-server1" "postgres-ha-1")

log() {
    echo "[$(date -Is)] $*"
}

fail() {
    log "FENCING FAILED: $*"
    exit 1
}

# Ensure this script is running on Server 1.
CURRENT_HOST="$(hostname -s)"

[[ "$CURRENT_HOST" == "$EXPECTED_HOST" ]] || \
    fail "Unexpected host: $CURRENT_HOST"

# Verify Docker is available.
command -v docker >/dev/null 2>&1 || \
    fail "Docker CLI is unavailable"

docker info >/dev/null 2>&1 || \
    fail "Cannot communicate with Docker"

# Verify both expected containers exist.
for container in "${CONTAINERS[@]}"; do
    docker inspect "$container" >/dev/null 2>&1 || \
        fail "Container not found: $container"
done

log "Starting fencing procedure on $CURRENT_HOST"

# Disable automatic Docker restart for both containers.
docker update --restart=no "${CONTAINERS[@]}" || \
    fail "Could not disable Docker restart policies"

# Stop repmgrd first, then PostgreSQL.
for container in "${CONTAINERS[@]}"; do
    running="$(docker inspect -f '{{.State.Running}}' "$container")"

    if [[ "$running" == "true" ]]; then
        log "Stopping $container"
        docker stop --time 15 "$container" || \
            fail "Could not stop $container"
    fi
done

# Verify that both containers are stopped and restart policy is disabled.
for container in "${CONTAINERS[@]}"; do
    running="$(docker inspect -f '{{.State.Running}}' "$container")"
    restart_policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$container")"

    [[ "$running" == "false" ]] || \
        fail "$container is still running"

    [[ "$restart_policy" == "no" ]] || \
        fail "$container restart policy is not disabled"
done

# Ensure no running container is publishing PostgreSQL port 5543.
published="$(docker ps --filter publish=5543 --format '{{.Names}}')"

[[ -z "$published" ]] || \
    fail "Port 5543 is still published by: $published"

log "SUCCESS: Both containers are stopped."
log "SUCCESS: Docker restart policies are disabled."
log "SUCCESS: No running container publishes port 5543."

exit 0
