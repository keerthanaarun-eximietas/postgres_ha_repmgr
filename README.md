# PostgreSQL High Availability using repmgr

## 1. Project Overview

This project implements PostgreSQL High Availability using **PostgreSQL 17 and repmgr 5.5** across two physical machines.

The objectives are:

- Configure PostgreSQL primary and standby servers.
- Replicate data between the two servers using streaming replication.
- Monitor PostgreSQL using `repmgrd`.
- Implement automatic failover with software-based fencing.
- Test failover, recovery, and rejoining the former primary.

**Important:** This is a two-node setup without a third witness. Software fencing reduces split-brain risk but cannot guarantee protection against every network partition or manual restart.

## 2. Architecture

| Component | Server 1 | Server 2 |
|---|---|---|
| Role | Primary | Standby |
| Windows hostname | EXILP-PG057VNG | To be verified |
| IP address | 192.168.28.12 | 192.168.28.15 |
| PostgreSQL port | 5543 | 5543 |
| Docker container | postgres-ha-1 | postgres-ha-2 |
| repmgrd container | repmgrd-server1 | repmgrd-server2 |
| repmgr node ID | 1 | 2 |

Both machines use Windows, Ubuntu WSL2, and Docker Desktop.

### Architecture flow

Application / pgAdmin → PostgreSQL primary → Streaming replication → PostgreSQL standby

`repmgrd` monitors the PostgreSQL nodes and coordinates failover according to the configured policy.

## 3. Technologies Used

- PostgreSQL 17
- repmgr 5.5
- Docker Desktop
- Docker Compose
- Ubuntu WSL2
- pgAdmin 4
- SSH for remote fencing

## 4. Project Structure

```text
postgres-ha-repmgr/
│
├── config/
│   ├── server1.env
│   ├── server1-repmgr.conf
│   ├── server2.env
│   ├── server2.env.example
│   └── server2-repmgr.conf
│
├── docker/
│   └── Dockerfile
│
├── fencing/
│   └── fence-server1.sh
│
├── scripts/
│   └── setup-server2.sh
│
├── docker-compose.yml
├── docker-compose.server2.yml
├── .dockerignore
└── .gitignore
```

Actual environment files and credentials should not be committed to GitHub.

## 5. PostgreSQL Docker Image

A custom image is built using PostgreSQL 17 with repmgr installed.

The Dockerfile installs:

- postgresql-17-repmgr
- ca-certificates
- procps
- iproute2
- netcat-openbsd

Build the image on Server 1:

```bash
docker compose build
```

The resulting image is named:

```text
postgres-repmgr:17
```

The same image is built on Server 2.

## 6. Server 1 – Primary Configuration

### PostgreSQL configuration

The following settings are enabled:

```conf
wal_level=replica
max_wal_senders=10
max_replication_slots=10
wal_log_hints=on
shared_preload_libraries=repmgr
```

These settings support PostgreSQL physical streaming replication and repmgr.

### repmgr configuration

Important settings in `config/server1-repmgr.conf`:

```conf
node_id=1
node_name='server1'

conninfo='host=192.168.28.12 port=5543 user=repmgr dbname=repmgr connect_timeout=5 passfile=/var/lib/postgresql/data/.pgpass'

data_directory='/var/lib/postgresql/data'
pg_bindir='/usr/lib/postgresql/17/bin'

use_replication_slots=true

monitor_interval_secs=2
log_level=INFO
monitoring_history=yes
connection_check_type=ping
failover=manual
```

Automatic failover is intentionally disabled during the initial setup and replication testing.

### repmgr database and user

A dedicated database and user are created:

```sql
CREATE ROLE repmgr WITH LOGIN SUPERUSER REPLICATION;
CREATE DATABASE repmgr OWNER repmgr;
ALTER USER repmgr SET search_path TO repmgr, "$user", public;
```

The repmgr password is stored in the PostgreSQL data directory's `.pgpass` file with restricted permissions.

### Replication access

Server 1's `pg_hba.conf` includes:

```conf
host replication repmgr 192.168.28.15/32 scram-sha-256
```

The existing general access rule is preserved:

```conf
host all all all scram-sha-256
```

After modifying `pg_hba.conf`, reload PostgreSQL:

```bash
docker exec -u postgres postgres-ha-1 \
  psql -U postgres -d postgres \
  -c "SELECT pg_reload_conf();"
```

Check for configuration errors:

```bash
docker exec -u postgres postgres-ha-1 \
  psql -U postgres -d postgres \
  -c "SELECT * FROM pg_hba_file_rules WHERE error IS NOT NULL;"
```

### Verify primary status

```bash
docker exec -u postgres postgres-ha-1 \
  psql -U postgres -d postgres \
  -c "SELECT pg_is_in_recovery();"
```

Expected result: `false`.

## 7. Server 2 – Standby Configuration

Server 2 is configured using:

- `docker-compose.server2.yml`
- `config/server2-repmgr.conf`
- `config/server2.env`

Its repmgr configuration uses:

```conf
node_id=2
node_name='server2'

conninfo='host=192.168.28.15 port=5543 user=repmgr dbname=repmgr connect_timeout=5 passfile=/var/lib/postgresql/data/.pgpass'

data_directory='/var/lib/postgresql/data'
pg_bindir='/usr/lib/postgresql/17/bin'

use_replication_slots=true

monitor_interval_secs=2
log_level=INFO
monitoring_history=yes
connection_check_type=ping
failover=manual
```

### Standby setup

The script `scripts/setup-server2.sh` automates the following:

1. Checks that it is running on Server 2.
2. Validates Docker and Compose configuration.
3. Builds the PostgreSQL + repmgr image.
4. Creates and checks an empty standby data volume.
5. Checks network connectivity to Server 1.
6. Performs a standby clone pre-check.
7. Clones Server 1 using `repmgr standby clone`.
8. Starts PostgreSQL on Server 2.
9. Registers Server 2 using `repmgr standby register`.
10. Starts `repmgrd`.
11. Verifies that Server 2 is in recovery mode.

Run this script only on Server 2, from the project root, after the required network, SSH, and authentication configuration is complete.

```bash
chmod +x scripts/setup-server2.sh
./scripts/setup-server2.sh
```

Do not start an empty Server 2 PostgreSQL container before cloning. The clone must populate its data volume first.

## 8. Monitoring the Cluster

Check cluster status:

```bash
docker exec -u postgres postgres-ha-1 \
  repmgr -f /etc/repmgr/repmgr.conf cluster show
```

Check the primary:

```sql
SELECT pg_is_in_recovery();
```

Expected: `false`.

Check the standby:

```sql
SELECT pg_is_in_recovery();
```

Expected: `true`.

Check replication status on Server 1:

```sql
SELECT
    application_name,
    client_addr,
    state,
    sync_state
FROM pg_stat_replication;
```

The standby should appear as a connected replication client.

## 9. Demonstration Database

The initial database is created on Server 1 using pgAdmin.

Database:

```text
ha_demo
```

### Employees table

```sql
CREATE TABLE employees (
    employee_id INTEGER PRIMARY KEY,
    employee_name VARCHAR(100) NOT NULL,
    department VARCHAR(100) NOT NULL
);
```

Initial records:

| ID | Name | Department |
|---:|---|---|
| 1 | Arun | Engineering |
| 2 | Priya | HR |
| 3 | Rahul | Finance |

### Projects table

```sql
CREATE TABLE projects (
    project_id INTEGER PRIMARY KEY,
    project_name VARCHAR(150) NOT NULL,
    status VARCHAR(50) NOT NULL
);
```

Initial records:

| ID | Project | Status |
|---:|---|---|
| 101 | PostgreSQL HA | Active |
| 102 | Replication Testing | Active |

### Replication demonstration

After Server 2 is connected, insert additional records on Server 1:

```sql
INSERT INTO employees VALUES
(4, 'Keerthana', 'Database Engineering'),
(5, 'Amit', 'DevOps');

INSERT INTO projects VALUES
(103, 'Automatic Failover', 'In Progress');
```

Query the same tables on Server 2.

The new records should appear automatically through streaming replication.

Physical replication copies the entire PostgreSQL cluster, not just `ha_demo`.

## 10. Fencing

The fencing script is located at:

```text
fencing/fence-server1.sh
```

It performs the following actions:

1. Confirms that it is running on Server 1.
2. Checks Docker availability.
3. Disables Docker restart policies for the PostgreSQL and repmgrd containers.
4. Stops repmgrd.
5. Stops PostgreSQL.
6. Verifies that both containers are stopped.
7. Verifies that port 5543 is no longer published.

The operational copy is stored at:

```text
/home/keerthana/repmgr-fencing/fence-server1.sh
```

Its permissions are restricted to the owner:

```bash
chmod 700 /home/keerthana/repmgr-fencing/fence-server1.sh
```

**Important:** This is best-effort software fencing. It does not provide the same guarantees as independent hardware fencing or a third-party quorum mechanism.

The remote SSH authentication and fencing procedure must be tested before enabling automatic failover.

## 11. Failover and Recovery Testing

The following tests are planned:

1. Stop PostgreSQL on Server 1 and verify whether Server 2 can be promoted.
2. Test loss of network connectivity separately from PostgreSQL failure.
3. Verify that the old primary is fenced before promotion.
4. Verify that applications can reconnect to the promoted primary.
5. Recover Server 1.
6. Rejoin it as a standby using `pg_rewind` when its prerequisites and available WAL permit; otherwise reclone it.
7. Verify replication in the reverse direction.

Automatic failover will only be enabled after the fencing and recovery procedures have been validated.

## 12. Important Notes

- Keep `failover=manual` until both nodes and fencing are fully tested.
- PostgreSQL replication is asynchronous in the initial design, so recently committed transactions can be lost during failover.
- repmgr does not automatically redirect application connections.
- Both machines must have the necessary Windows and WSL firewall rules.
- The SSH account used for fencing has Docker control privileges and must be protected.
- Never allow both servers to operate independently as writable primaries.

## 13. Current Implementation Status

| Task | Status |
|---|---|
| Server 1 Docker image and containers | Completed |
| Server 1 PostgreSQL primary | Completed |
| repmgr installation and registration | Completed |
| repmgrd on Server 1 | Completed |
| Server 1 replication settings | Completed |
| Server 1 replication access rule | Completed |
| Server 1 fencing script | Prepared |
| Server 2 Compose and configuration | Prepared |
| Server 2 setup script | Prepared |
| pgAdmin connection to Server 1 | Completed |
| Initial demonstration database and data | Completed |
| GitHub repository | Pending |
| Server 2 deployment and initial clone | Pending |
| Streaming replication verification | Pending |
| Automatic failover and recovery tests | Pending |
