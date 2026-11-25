#!/usr/bin/env bash

set -Eeuo pipefail

# --------------------------------------------------
# PostgreSQL HA - Server 2 standby setup
# Run this script on Server 2, from the project root.
# --------------------------------------------------

PRIMARY_IP="192.168.28.12"
PRIMARY_PORT="5543"

SERVER2_IP="192.168.28.15"
SERVER2_PORT="5543"

VOLUME="postgres_server2_data"
IMAGE="postgres-repmgr:17"
COMPOSE_FILE="docker-compose.server2.yml"
REPMGR_CONFIG="config/server2-repmgr.conf"

CONTAINERS=("postgres-ha-2" "repmgrd-server2")

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

fail() {
    log "ERROR: $*"
    exit 1
}

# Check that the script is run from the project directory.
[[ -f "$COMPOSE_FILE" ]] || fail "Run this script from the project root."
[[ -f "$REPMGR_CONFIG" ]] || fail "Missing $REPMGR_CONFIG."
[[ -f "config/server2.env" ]] || fail "Missing config/server2.env."

# Check required commands.
for cmd in docker hostname grep; do
    command -v "$cmd" >/dev/null 2>&1 || fail "Required command not found: $cmd"
done

docker info >/dev/null 2>&1 || fail "Docker is unavailable."

# Ensure this is Server 2.
HOST_IPS="$(hostname -I 2>/dev/null || true)"

if ! echo "$HOST_IPS" | tr ' ' '\n' | grep -Fxq "$SERVER2_IP"; then
    fail "Expected Server 2 IP $SERVER2_IP, but found: $HOST_IPS"
fi

# Validate the Compose configuration.
docker compose -f "$COMPOSE_FILE" config --quiet ||
    fail "Server 2 Compose configuration is invalid."

# Do not overwrite existing containers.
for container in "${CONTAINERS[@]}"; do
    if docker inspect "$container" >/dev/null 2>&1; then
        fail "Container $container already exists. Inspect it before continuing."
    fi
done

log "Building PostgreSQL + repmgr image..."
docker compose -f "$COMPOSE_FILE" build postgres-server2

# Create the standby volume if it does not exist.
if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    docker volume create "$VOLUME" >/dev/null
fi

# Never overwrite an existing database.
log "Checking that the standby data volume is empty..."

docker run --rm \
    --user root \
    -v "$VOLUME:/data" \
    --entrypoint bash \
    "$IMAGE" \
    -c 'test -z "$(find /data -mindepth 1 -maxdepth 1 -print -quit)"' ||
    fail "The standby volume is not empty. Refusing to overwrite it."

# Give PostgreSQL ownership of the empty volume.
docker run --rm \
    --user root \
    -v "$VOLUME:/var/lib/postgresql/data" \
    --entrypoint bash \
    "$IMAGE" \
    -c 'chown postgres:postgres /var/lib/postgresql/data'

# Check network access to Server 1.
log "Checking connectivity to Server 1..."

docker run --rm \
    --entrypoint nc \
    "$IMAGE" \
    -z -w 5 "$PRIMARY_IP" "$PRIMARY_PORT" ||
    fail "Cannot reach Server 1 at $PRIMARY_IP:$PRIMARY_PORT."

# Collect the repmgr password without echoing it.
read -r -s -p "Enter the existing repmgr database password: " REPMGR_PASSWORD
echo

[[ -n "$REPMGR_PASSWORD" ]] || fail "The repmgr password cannot be empty."

log "Checking standby clone prerequisites..."

# The password is passed through stdin and written only to a temporary
# in-memory file inside the one-off container.
printf '%s\n' "$REPMGR_PASSWORD" | docker run -i --rm \
    --user 999:999 \
    --network bridge \
    --tmpfs /run/repmgr-secret:rw,noexec,nosuid,size=64k,uid=999,gid=999,mode=0700 \
    -v "$VOLUME:/var/lib/postgresql/data" \
    -v "$PWD/$REPMGR_CONFIG:/etc/repmgr/repmgr.conf:ro" \
    --entrypoint bash \
    "$IMAGE" \
    -c '
        set -e
        IFS= read -r password
        escaped=${password//\\/\\\\}
        escaped=${escaped//:/\\:}
        umask 077
        printf "*:*:*:repmgr:%s\n" "$escaped" > /run/repmgr-secret/pgpass
        unset password escaped
        export PGPASSFILE=/run/repmgr-secret/pgpass
        sed 's#passfile=/var/lib/postgresql/data/.pgpass#passfile=/run/repmgr-secret/pgpass#' \
            /etc/repmgr/repmgr.conf > /run/repmgr-secret/repmgr.conf

        repmgr -f /run/repmgr-secret/repmgr.conf \
            -h 192.168.28.12 -p 5543 -U repmgr -d repmgr \
            standby clone --dry-run
    ' || fail "Standby clone pre-check failed. Check Server 1 connectivity, credentials and pg_hba.conf."

echo
read -r -p "Clone Server 1 into the empty Server 2 volume? (yes/no): " CONFIRM
[[ "$CONFIRM" == "yes" ]] || fail "Clone cancelled."

log "Cloning the primary database. This may take some time..."

printf '%s\n' "$REPMGR_PASSWORD" | docker run -i --rm \
    --user 999:999 \
    --network bridge \
    --tmpfs /run/repmgr-secret:rw,noexec,nosuid,size=64k,uid=999,gid=999,mode=0700 \
    -v "$VOLUME:/var/lib/postgresql/data" \
    -v "$PWD/$REPMGR_CONFIG:/etc/repmgr/repmgr.conf:ro" \
    --entrypoint bash \
    "$IMAGE" \
    -c '
        set -e
        IFS= read -r password
        escaped=${password//\\/\\\\}
        escaped=${escaped//:/\\:}
        umask 077
        printf "*:*:*:repmgr:%s\n" "$escaped" > /run/repmgr-secret/pgpass
        unset password escaped
        export PGPASSFILE=/run/repmgr-secret/pgpass
        sed 's#passfile=/var/lib/postgresql/data/.pgpass#passfile=/run/repmgr-secret/pgpass#' \
            /etc/repmgr/repmgr.conf > /run/repmgr-secret/repmgr.conf

        exec repmgr -f /run/repmgr-secret/repmgr.conf \
            -h 192.168.28.12 -p 5543 -U repmgr -d repmgr \
            standby clone
    ' || fail "Standby clone failed. Inspect the volume before retrying."

# Install the repmgr password file into the cloned data directory.
# The file is owned by the PostgreSQL user and has mode 600.
printf '%s\n' "$REPMGR_PASSWORD" | docker run -i --rm \
    --user root \
    -v "$VOLUME:/var/lib/postgresql/data" \
    --entrypoint bash \
    "$IMAGE" \
    -c '
        set -e
        IFS= read -r password
        escaped=${password//\\/\\\\}
        escaped=${escaped//:/\\:}
        umask 077
        printf "*:*:*:repmgr:%s\n" "$escaped" > /var/lib/postgresql/data/.pgpass
        chown 999:999 /var/lib/postgresql/data/.pgpass
        chmod 600 /var/lib/postgresql/data/.pgpass
        unset password escaped
    ' || fail "Could not install the repmgr password file."

unset REPMGR_PASSWORD

log "Starting PostgreSQL standby..."
docker compose -f "$COMPOSE_FILE" up -d postgres-server2

# Wait up to five minutes for PostgreSQL to become healthy.
log "Waiting for PostgreSQL health check..."

HEALTHY=false

for attempt in $(seq 1 60); do
    STATUS="$(docker inspect -f '{{.State.Health.Status}}' postgres-ha-2 2>/dev/null || true)"

    if [[ "$STATUS" == "healthy" ]]; then
        HEALTHY=true
        break
    fi

    sleep 5
done

[[ "$HEALTHY" == "true" ]] || fail "PostgreSQL did not become healthy. Inspect its logs."

# Register the running standby with repmgr.
log "Registering Server 2 with repmgr..."

docker exec -u postgres \
    -e PGPASSFILE=/var/lib/postgresql/data/.pgpass \
    postgres-ha-2 \
    repmgr -f /etc/repmgr/repmgr.conf standby register ||
    fail "Standby registration failed."

# Start repmgrd only after registration.
log "Starting repmgrd..."
docker compose -f "$COMPOSE_FILE" up -d repmgrd-server2

# Verify PostgreSQL is still in recovery mode.
RECOVERY="$(docker exec -u postgres postgres-ha-2 \
    psql -U postgres -d postgres -Atqc 'SELECT pg_is_in_recovery();')"

[[ "$RECOVERY" == "t" ]] ||
    fail "Server 2 is not in standby recovery mode."

log "Server 2 standby setup completed."
log "PostgreSQL is running in recovery mode."

docker exec -u postgres \
    -e PGPASSFILE=/var/lib/postgresql/data/.pgpass \
    postgres-ha-2 \
    repmgr -f /etc/repmgr/repmgr.conf cluster show
