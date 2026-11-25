# Server 2 – Complete Installation and Setup Guide

## 1. Purpose

This document explains how to prepare the second physical machine and configure it as a PostgreSQL standby using Docker, PostgreSQL 17, and repmgr 5.5.

Server 1 is already configured as the primary.

| Detail | Server 1 | Server 2 |
|---|---|---|
| Role | Primary | Standby |
| IP address | 192.168.28.12 | 192.168.28.15 |
| PostgreSQL port | 5543 | 5543 |
| PostgreSQL version | 17 | 17 |
| repmgr version | 5.5 | 5.5 |
| Node ID | 1 | 2 |

The final objective is to establish streaming replication between both machines.

---

# PART 1 – Prepare the Second Machine

## 2. Install Windows prerequisites

On Server 2, ensure that the following are available:

- Windows 10/11 with WSL2 support
- Administrator access for installing software and configuring firewall rules
- Internet connectivity
- Sufficient disk space for Docker images and PostgreSQL data

## 3. Install WSL2 and Ubuntu

Open PowerShell as Administrator.

Check whether WSL is installed:

```powershell
wsl --version
```

If WSL is not installed:

```powershell
wsl --install
```

Install Ubuntu if it is not already available:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if requested.

Launch Ubuntu:

```powershell
wsl -d Ubuntu
```

Complete the initial Ubuntu setup by creating a Linux username and password.

For consistency with Server 1, the same Ubuntu username can be used:

```text
keerthana
```

Check the Ubuntu version:

```bash
lsb_release -a
```

Update Ubuntu:

```bash
sudo apt update && sudo apt upgrade -y
```

## 4. Configure mirrored networking

Mirrored networking allows WSL2 to use the Windows machine's network connectivity more directly.

Open PowerShell:

```powershell
notepad $env:USERPROFILE\.wslconfig
```

Add:

```ini
[wsl2]
networkingMode=mirrored
```

Save the file.

Apply the configuration:

```powershell
wsl --shutdown
```

Start Ubuntu again:

```powershell
wsl -d Ubuntu
```

Check the IP address:

```bash
hostname -I
```

The output must include:

```text
192.168.28.15
```

If the expected IP is not present, resolve the WSL networking configuration before proceeding.

---

# PART 2 – Install Docker

## 5. Install Docker Desktop

Download Docker Desktop for Windows:

https://www.docker.com/products/docker-desktop/

Install it using the WSL2 backend.

During installation, ensure that the WSL2 backend is selected.

After installation:

1. Start Docker Desktop.
2. Open Settings.
3. Go to General.
4. Enable **Use the WSL 2 based engine**.
5. Go to Resources → WSL Integration.
6. Enable integration for Ubuntu.
7. Apply the changes.

## 6. Verify Docker installation

Open Ubuntu on Server 2.

Check Docker:

```bash
docker --version
```

Check Docker Compose:

```bash
docker compose version
```

Check whether Docker is running:

```bash
docker info
```

Check the Docker context:

```bash
docker context show
```

Expected context:

```text
desktop-linux
```

Test Docker:

```bash
docker run hello-world
```

A successful execution confirms that Ubuntu can communicate with Docker Desktop.

**Important:** Do not install a separate Docker Engine inside Ubuntu. We are using Docker Desktop with WSL integration, just as on Server 1.

---

# PART 3 – Install SSH and Configure Networking

## 7. Install and enable SSH

SSH is required for remote communication and the planned software-fencing mechanism.

Inside Ubuntu:

```bash
sudo apt update
sudo apt install -y openssh-server
```

Enable SSH socket activation:

```bash
sudo systemctl enable --now ssh.socket
```

Verify:

```bash
sudo systemctl status ssh.socket
```

Check that port 22 is listening:

```bash
sudo ss -tlnp | grep ':22'
```

The SSH server should listen on port 22.

## 8. Configure Windows Firewall

Open PowerShell as Administrator on Server 2.

Allow PostgreSQL access from Server 1:

```powershell
New-NetFirewallRule -DisplayName "PostgreSQL repmgr - Server 1" -Direction Inbound -Protocol TCP -LocalPort 5543 -RemoteAddress 192.168.28.12 -Action Allow -Profile Any
```

Allow SSH access from Server 1:

```powershell
New-NetFirewallRule -DisplayName "repmgr SSH - Server 1" -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress 192.168.28.12 -Action Allow -Profile Any
```

## 9. Configure WSL Hyper-V firewall

On Server 2, open PowerShell as Administrator.

For mirrored WSL networking, add the corresponding inbound Hyper-V firewall rules:

```powershell
New-NetFirewallHyperVRule -Name "repmgr-ssh-server1" -DisplayName "Allow SSH from Server 1" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 22 -RemoteAddresses 192.168.28.12
```

```powershell
New-NetFirewallHyperVRule -Name "repmgr-postgres-server1" -DisplayName "Allow PostgreSQL from Server 1" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 5543 -RemoteAddresses 192.168.28.12
```

Verify the firewall rules:

```powershell
Get-NetFirewallRule -DisplayName "PostgreSQL repmgr - Server 1","repmgr SSH - Server 1"
```

If the Hyper-V rules are not accepted or do not apply, inspect the active WSL Hyper-V firewall configuration before proceeding.

## 10. Test network connectivity

From Ubuntu on Server 2:

```bash
ping -c 4 192.168.28.12
```

Check Server 1's PostgreSQL port:

```bash
nc -zv 192.168.28.12 5543
```

Check Server 1's SSH port:

```bash
nc -zv 192.168.28.12 22
```

Both TCP tests should succeed.

At this stage, SSH password or key authentication still needs to be configured and tested separately.

---

# PART 4 – Install Git and Download the Project

## 11. Install Git

Inside Ubuntu:

```bash
sudo apt update
sudo apt install -y git
```

Verify:

```bash
git --version
```

## 12. Configure GitHub access

The project is stored in a private GitHub repository.

Configure GitHub authentication using either:

- SSH key authentication, or
- HTTPS with a GitHub Personal Access Token.

Do not put access tokens or passwords directly into the repository or scripts.

For SSH authentication, generate a key:

```bash
ssh-keygen -t ed25519 -C "server2-postgres-ha"
```

Display the public key:

```bash
cat ~/.ssh/id_ed25519.pub
```

Add this public key to the appropriate GitHub account or repository access settings.

Test GitHub SSH access:

```bash
ssh -T git@github.com
```

## 13. Clone the repository

Navigate to the home directory:

```bash
cd ~
```

Clone the private repository:

```bash
git clone <YOUR_PRIVATE_GITHUB_REPOSITORY_URL>
```

Enter the project directory:

```bash
cd postgres-ha-repmgr
```

Verify the project files:

```bash
find . -maxdepth 3 -type f -not -path './.git/*' | sort
```

---

# PART 5 – Configure Server 2

## 14. Create the Server 2 environment file

Actual environment files are excluded from GitHub for security.

Create the Server 2 environment file from the tracked example:

```bash
cp config/server2.env.example config/server2.env
```

Verify:

```bash
cat config/server2.env
```

Expected contents:

```env
NODE_ID=2
NODE_NAME=server2
NODE_IP=192.168.28.15

POSTGRES_USER=postgres
POSTGRES_DB=postgres
POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256
```

The PostgreSQL data directory will be populated from Server 1 during the standby clone.

## 15. Review the repmgr configuration

Open:

```bash
cat config/server2-repmgr.conf
```

Verify that it contains:

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

Keep `failover=manual` until the complete two-node failover and fencing procedures have been tested.

---

# PART 6 – Install PostgreSQL and repmgr Using Docker

## 16. Build the custom PostgreSQL image

We do not need to install PostgreSQL or repmgr separately inside Ubuntu.

The project's Dockerfile already installs:

- PostgreSQL 17
- repmgr 5.5
- repmgrd
- Required Linux utilities

The setup script builds this image automatically.

The image name is:

```text
postgres-repmgr:17
```

## 17. Validate the Server 2 Compose configuration

From the project root:

```bash
docker compose -f docker-compose.server2.yml config --quiet
```

Expected:

```text
```

No output indicates that the configuration is valid.

**Do not run `docker compose up` at this point.**

The standby data volume must first be populated by cloning Server 1.

## 18. Run the automated standby setup

Make the setup script executable:

```bash
chmod +x scripts/setup-server2.sh
```

Run:

```bash
./scripts/setup-server2.sh
```

The script will:

1. Verify Server 2's IP address.
2. Verify Docker connectivity.
3. Validate the Compose configuration.
4. Build the PostgreSQL + repmgr image.
5. Create an empty PostgreSQL data volume.
6. Verify that the volume is empty.
7. Check connectivity to Server 1.
8. Request the existing repmgr database password.
9. Perform a standby clone pre-check.
10. Ask for confirmation before cloning.
11. Clone the primary database.
12. Install the repmgr password file.
13. Start PostgreSQL on Server 2.
14. Register Server 2 with repmgr.
15. Start repmgrd.
16. Verify that PostgreSQL is running in standby mode.

The script will not overwrite an existing non-empty standby volume.

If any step fails, stop and inspect the logs and volume before attempting another clone.

---

# PART 7 – Install and Configure pgAdmin

## 19. Install pgAdmin 4 on Server 2

pgAdmin is optional for PostgreSQL replication, but it provides a graphical interface for inspecting both servers.

Download pgAdmin 4 for Windows:

https://www.pgadmin.org/download/pgadmin-4-windows/

Install and launch pgAdmin 4.

## 20. Register Server 1

In pgAdmin:

1. Right-click Servers.
2. Select Register → Server.
3. Enter the following details.

General tab:

```text
Name: PostgreSQL HA - Server 1
```

Connection tab:

| Field | Value |
|---|---|
| Host | 192.168.28.12 |
| Port | 5543 |
| Maintenance database | postgres |
| Username | postgres |
| Password | Existing PostgreSQL password |

Save the connection.

## 21. Register Server 2

Create another server registration.

General tab:

```text
Name: PostgreSQL HA - Server 2
```

Connection tab:

| Field | Value |
|---|---|
| Host | 192.168.28.15 |
| Port | 5543 |
| Maintenance database | postgres |
| Username | postgres |
| Password | Same PostgreSQL password copied from Server 1 |

The standby accepts read-only queries while it remains in recovery mode.

If pgAdmin cannot connect to the standby, check that PostgreSQL is running and that the Windows and WSL firewall rules permit the connection.

---

# PART 8 – Verify Replication

## 22. Verify cluster status

On Server 1:

```bash
docker exec -u postgres postgres-ha-1 \
  repmgr -f /etc/repmgr/repmgr.conf cluster show
```

Expected:

| Node | Role | Status |
|---|---|---|
| Server 1 | Primary | Running |
| Server 2 | Standby | Running |

## 23. Verify Server 2 is a standby

Connect to Server 2 using pgAdmin or Docker:

```bash
docker exec -u postgres postgres-ha-2 \
  psql -U postgres -d postgres \
  -c "SELECT pg_is_in_recovery();"
```

Expected:

```text
t
```

## 24. Verify the initial database clone

On Server 2, connect to `ha_demo`:

```sql
SELECT * FROM employees ORDER BY employee_id;
SELECT * FROM projects ORDER BY project_id;
```

Expected initial data:

- 3 employees
- 2 projects

These are the records created on Server 1 before the standby was cloned.

## 25. Verify ongoing streaming replication

Insert additional records on Server 1:

```sql
INSERT INTO employees VALUES
(4, 'Keerthana', 'Database Engineering'),
(5, 'Amit', 'DevOps');

INSERT INTO projects VALUES
(103, 'Automatic Failover', 'In Progress');
```

Run the same SELECT queries on Server 2.

The additional records should appear automatically.

On Server 1, verify the replication connection:

```sql
SELECT
    application_name,
    client_addr,
    state,
    sync_state
FROM pg_stat_replication;
```

The standby should appear as a connected replication client.

---

# PART 9 – Failover and Recovery

## 26. Prepare for failover testing

Do not enable automatic failover immediately after replication starts.

First verify:

- PostgreSQL replication works in both directions after role changes.
- SSH key authentication works between both machines.
- Remote fencing works.
- The old primary cannot restart and accept writes after fencing.
- The application can reconnect to the new primary.

The current design uses best-effort software fencing by remotely stopping Docker containers and disabling their restart policies.

This does not provide the same guarantees as independent hardware fencing or a third-node quorum.

## 27. Test failover

After all prerequisites are validated:

1. Simulate PostgreSQL failure on Server 1.
2. Verify that Server 1 is fenced.
3. Verify that Server 2 can be promoted.
4. Confirm that Server 2 accepts writes.
5. Restore Server 1.
6. Rejoin Server 1 as a standby using `pg_rewind` if possible, or reclone it.
7. Verify replication again.

Automatic failover should only be enabled after these tests are successful.

---

# PART 10 – Useful Commands

### Check Docker containers

```bash
docker ps -a
```

### Check PostgreSQL logs

```bash
docker logs postgres-ha-2
```

### Check repmgrd logs

```bash
docker logs repmgrd-server2
```

### Check PostgreSQL readiness

```bash
docker exec postgres-ha-2 pg_isready -U postgres
```

### Check standby status

```bash
docker exec -u postgres postgres-ha-2 \
  psql -U postgres -d postgres \
  -c "SELECT pg_is_in_recovery();"
```

### Check repmgr cluster status

```bash
docker exec -u postgres postgres-ha-2 \
  repmgr -f /etc/repmgr/repmgr.conf cluster show
```

### Check Docker Compose services

```bash
docker compose -f docker-compose.server2.yml ps
```

---

# Final Setup Checklist

| Task | Status |
|---|---|
| Windows prerequisites | Pending |
| WSL2 and Ubuntu installation | Pending |
| Mirrored networking | Pending |
| Docker Desktop installation | Pending |
| Docker WSL integration | Pending |
| SSH installation | Pending |
| Firewall configuration | Pending |
| GitHub authentication | Pending |
| Repository cloned | Pending |
| Server 2 environment configured | Pending |
| PostgreSQL + repmgr image built | Pending |
| Standby clone completed | Pending |
| repmgr registration completed | Pending |
| pgAdmin connection configured | Pending |
| Initial data verified | Pending |
| Streaming replication verified | Pending |
| Fencing tested | Pending |
| Automatic failover tested | Pending |
| Recovery and rejoin tested | Pending |

**Important:** PostgreSQL and repmgr are installed through the project's Docker image. Docker Desktop, WSL2, Ubuntu, Git, SSH, and optionally pgAdmin are the components that must be prepared separately on Server 2.