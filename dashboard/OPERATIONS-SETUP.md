# PostgreSQL HA Dashboard - Container Operations

This update adds container stop/start controls while retaining the existing monitoring,
write-test, table-monitor and replication views.

## Safety behaviour

- **Stop current primary** detects the current primary from PostgreSQL itself and stops
  only that node's PostgreSQL container.
- The dashboard does not promote a node. `repmgrd` remains responsible for failover.
- **Start stopped standby** is allowed only when the dashboard previously observed that
  node as a standby and can currently confirm the other node is primary.
- A node last observed as a primary (or with unknown role) cannot be directly started.
  It must first be rewound/rejoined with `repmgr`. This prevents accidentally starting
  the old primary alongside the promoted primary.
- The app does not yet automate `pg_rewind`/`repmgr node rejoin`; that procedure is
  deliberately kept separate from a plain Docker start.

## 1. Server 2 remote agent

Copy `dashboard/remote-agent` to Server 2, for example:

`C:\Users\<user>\postgres-ha-remote-agent`

In PowerShell on Server 2:

```powershell
cd C:\Users\<user>\postgres-ha-remote-agent
py -3.12 -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Generate a long random token (run once):

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Put the generated value in `AGENT_TOKEN` in Server 2's `.env`.

Create the firewall rule in **Administrator PowerShell on Server 2**:

```powershell
New-NetFirewallRule -DisplayName "PostgreSQL HA Dashboard Agent" -Direction Inbound -Protocol TCP -LocalPort 5051 -RemoteAddress 192.168.28.12 -Action Allow
```

Start the agent:

```powershell
.\venv\Scripts\python.exe -m waitress --listen=0.0.0.0:5051 agent:app
```

Keep this process running. For automatic startup later, configure it as a Windows service.

## 2. Server 1 dashboard backend

Keep the existing Server 1 `.env` and its PostgreSQL credentials. Add these lines:

```dotenv
SERVER1_CONTAINER=postgres-ha-1
SERVER2_CONTAINER=postgres-ha-2
SERVER2_AGENT_URL=http://192.168.28.15:5051
SERVER2_AGENT_TOKEN=THE_EXACT_SAME_TOKEN
```

Do not replace the existing database credentials. The backend currently binds to `127.0.0.1:5000`,
so the dashboard API is local to Server 1.

Start the backend as before:

```powershell
cd "C:\Users\Keerthana\VS Code\GitHub\postgres-ha-repmgr\dashboard\backend"
.\venv\Scripts\python.exe app.py
```

Start the frontend in another PowerShell window:

```powershell
cd "C:\Users\Keerthana\VS Code\GitHub\postgres-ha-repmgr\dashboard\frontend"
npm.cmd run dev
```

## 3. Operations in the dashboard

- Click **Stop Current Primary** to simulate a primary failure.
- Watch the role cards until `repmgrd` promotes the standby.
- A stopped node that was previously a standby can be started using its **Start Standby** action.
- If the stopped node was the former primary, direct start is blocked. Perform the approved
  `pg_rewind` + `repmgr node rejoin` workflow first, then start it as a standby.

## Network and security notes

- Server 2's agent only exposes fixed operations for `postgres-ha-2`; it does not accept
  arbitrary shell commands or arbitrary container names.
- The agent requires a bearer token and restricts source IP to Server 1 by default.
- Keep port 5051 restricted to Server 1. Do not expose it to the public internet.
- The backend's admin endpoints are intended for the local dashboard and the backend binds
  to loopback. Do not change it to `0.0.0.0` without adding authentication.
- The `.env` files are not included in this archive. Create them locally and do not commit them.
