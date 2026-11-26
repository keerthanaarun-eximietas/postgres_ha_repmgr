
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Database,
  Server,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  Wifi,
  WifiOff,
  Clock,
  CheckCircle2,
  Send,
  XCircle,
  Power,
  Play,
  ShieldAlert,
} from "lucide-react";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:5000";

interface Replication {
  status?: string;
  sender_host?: string;
  sender_port?: number;
  written_lsn?: string;
  flushed_lsn?: string;
  latest_end_lsn?: string;
  application_name?: string;
  client_addr?: string;
  state?: string;
  sync_state?: string;
  write_lag?: string | null;
  flush_lag?: string | null;
  replay_lag?: string | null;
}

interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  available: boolean;
  role: string;
  postgres_version: string | null;
  in_recovery: boolean | null;
  database?: string;
  started_at?: string;
  replication: Replication | Replication[] | null;
  error: string | null;
}

interface TableRecord {
  id: number;
  message: string;
  created_at: string;
  server_name: string;
}

interface TableServer {
  id: string;
  name: string;
  available: boolean;
  total_records: number;
  records: TableRecord[];
  error: string | null;
}

interface TableMonitorData {
  table: string;
  servers: TableServer[];
  timestamp: string;
}

interface ContainerStatus {
  id: string;
  name: string;
  container: string;
  available: boolean;
  running: boolean | null;
  status: string;
  exit_code?: number | null;
  last_known_role: string;
  start_allowed: boolean;
  start_block_reason?: string | null;
  error?: string | null;
}

interface ContainerMonitorData {
  containers: ContainerStatus[];
  timestamp: string;
}

interface AdminActionResult {
  success: boolean;
  message?: string;
  error?: string;
  requires_rejoin?: boolean;
}

interface ActivityEvent {
  id: string;
  serverName: string;
  recordId: number;
  type: "INSERT" | "UPDATE";
  message: string;
  detectedAt: string;
}

interface ClusterData {
  cluster_state: string;
  primary_count: number;
  standby_count: number;
  servers: Server[];
  timestamp: string;
}

function App() {
  const [cluster, setCluster] = useState<ClusterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [writeLoading, setWriteLoading] = useState(false);
  const [writeResult, setWriteResult] = useState<any>(null);

  const [tableMonitor, setTableMonitor] = useState<TableMonitorData | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [tableMonitorError, setTableMonitorError] = useState<string | null>(null);
  const [containerMonitor, setContainerMonitor] = useState<ContainerMonitorData | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMessage, setAdminMessage] = useState<{ success: boolean; text: string } | null>(null);

  const previousRecords = useRef<Record<string, Record<number, string>>>({});


  async function fetchStatus() {
    try {
      const response = await fetch(`${API_URL}/api/cluster/status`);

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data: ClusterData = await response.json();

      setCluster(data);
      setLastUpdated(new Date().toLocaleTimeString());
      setApiError(null);
    } catch (error) {
      setApiError(
        error instanceof Error ? error.message : "Unable to contact backend"
      );
    } finally {
      setLoading(false);
    }
  }

  async function fetchTableMonitor() {
    try {
      const response = await fetch(`${API_URL}/api/cluster/table-monitor`);

      if (!response.ok) {
        throw new Error(`Table monitor returned HTTP ${response.status}`);
      }

      const data: TableMonitorData = await response.json();

      const currentSnapshots: Record<string, Record<number, string>> = {};
      const detectedEvents: ActivityEvent[] = [];

      for (const server of data.servers) {
        if (!server.available) continue;

        const currentServerRecords: Record<number, string> = {};

        for (const record of server.records) {
          const fingerprint = JSON.stringify({
            message: record.message,
            created_at: record.created_at,
            server_name: record.server_name,
          });

          currentServerRecords[record.id] = fingerprint;

          const previousFingerprint =
            previousRecords.current[server.id]?.[record.id];

          if (previousFingerprint === undefined) {
            // First poll establishes the baseline; don't report old records.
            if (previousRecords.current[server.id] !== undefined) {
              detectedEvents.push({
                id: `${server.id}-${record.id}-${Date.now()}-insert`,
                serverName: server.name,
                recordId: record.id,
                type: "INSERT",
                message: record.message,
                detectedAt: new Date().toLocaleTimeString(),
              });
            }
          } else if (previousFingerprint !== fingerprint) {
            detectedEvents.push({
              id: `${server.id}-${record.id}-${Date.now()}-update`,
              serverName: server.name,
              recordId: record.id,
              type: "UPDATE",
              message: record.message,
              detectedAt: new Date().toLocaleTimeString(),
            });
          }
        }

        currentSnapshots[server.id] = currentServerRecords;
      }

      previousRecords.current = {
        ...previousRecords.current,
        ...currentSnapshots,
      };

      if (detectedEvents.length > 0) {
        setActivityEvents((previous) =>
          [...detectedEvents, ...previous].slice(0, 30)
        );
      }

      setTableMonitor(data);
      setTableMonitorError(null);
    } catch (error) {
      setTableMonitorError(
        error instanceof Error ? error.message : "Unable to monitor database table"
      );
    }
  }

  async function fetchContainerMonitor() {
    try {
      const response = await fetch(`${API_URL}/api/admin/containers`);
      if (!response.ok) {
        throw new Error(`Container monitor returned HTTP ${response.status}`);
      }
      const data: ContainerMonitorData = await response.json();
      setContainerMonitor(data);
    } catch (error) {
      setAdminMessage({
        success: false,
        text: error instanceof Error ? error.message : "Unable to read container status",
      });
    }
  }

  async function runAdminAction(path: string, label: string) {
    setAdminBusy(true);
    setAdminMessage(null);
    try {
      const response = await fetch(`${API_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data: AdminActionResult = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `${label} failed`);
      }
      setAdminMessage({ success: true, text: data.message || `${label} request completed.` });
      await fetchStatus();
      await fetchContainerMonitor();
    } catch (error) {
      setAdminMessage({
        success: false,
        text: error instanceof Error ? error.message : `${label} failed`,
      });
    } finally {
      setAdminBusy(false);
    }
  }

  async function stopCurrentPrimary() {
    if (!window.confirm(
      "Stop the currently detected PostgreSQL primary to simulate failure? repmgrd must promote the standby."
    )) return;
    await runAdminAction("/api/admin/primary/stop", "Stop primary");
  }

  async function startStandby(serverId: string, serverName: string) {
    if (!window.confirm(
      `Start the stopped ${serverName} PostgreSQL container? This action is allowed only for a node last observed as a standby.`
    )) return;
    await runAdminAction(`/api/admin/nodes/${serverId}/start`, "Start standby");
  }

  useEffect(() => {
    fetchStatus();
    fetchTableMonitor();
    fetchContainerMonitor();

    const interval = setInterval(() => {
      fetchStatus();
      fetchTableMonitor();
      fetchContainerMonitor();
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  async function runWriteTest() {
    setWriteLoading(true);
    setWriteResult(null);

    try {
      const response = await fetch(`${API_URL}/api/cluster/write-test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `Dashboard write test - ${new Date().toLocaleString()}`,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Write test failed");
      }

      setWriteResult(data);
      fetchStatus();
    } catch (error) {
      setWriteResult({
        success: false,
        error: error instanceof Error ? error.message : "Write test failed",
      });
    } finally {
      setWriteLoading(false);
    }
  }

  const primary = cluster?.servers.find(
    (server) => server.available && server.role === "primary"
  );

  const standby = cluster?.servers.find(
    (server) => server.available && server.role === "standby"
  );

  function getReplicationStatus(server: Server) {
    if (Array.isArray(server.replication)) {
      return server.replication.some((r) => r.state === "streaming")
        ? "Streaming"
        : "No active standby";
    }

    return server.replication?.status === "streaming"
      ? "Streaming"
      : server.replication?.status === "not_connected"
        ? "Not connected"
        : "Unknown";
  }

  function formatDate(value?: string) {
    if (!value) return "Unavailable";
    return new Date(value).toLocaleString();
  }

  function ServerCard({ server }: { server: Server }) {
    const isPrimary = server.role === "primary";
    const isStandby = server.role === "standby";

    return (
      <div className="server-card">
        <div className="server-card-header">
          <div className="server-icon">
            <Server size={23} />
          </div>

          <div className="server-heading">
            <h3>{server.name}</h3>
            <span>{server.host}:{server.port}</span>
          </div>

          <span className={`status-pill ${server.available ? "online" : "offline"}`}>
            {server.available ? "Online" : "Offline"}
          </span>
        </div>

        <div className="role-section">
          <span className="muted-label">DATABASE ROLE</span>
          <span className={`role-badge ${isPrimary ? "primary" : isStandby ? "standby" : "unknown"}`}>
            {server.available ? server.role.toUpperCase() : "UNAVAILABLE"}
          </span>
        </div>

        <div className="server-details">
          <div>
            <span>PostgreSQL</span>
            <strong>{server.postgres_version || "Unavailable"}</strong>
          </div>

          <div>
            <span>Database</span>
            <strong>{server.database || "Unavailable"}</strong>
          </div>

          <div>
            <span>Replication</span>
            <strong>{server.available ? getReplicationStatus(server) : "Unavailable"}</strong>
          </div>

          <div>
            <span>Started at</span>
            <strong>{formatDate(server.started_at)}</strong>
          </div>
        </div>

        {server.error && (
          <div className="error-message">{server.error}</div>
        )}
      </div>
    );
  }

  const clusterHealthy = cluster?.cluster_state === "healthy";

  return (
    <div className="dashboard">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <Database size={24} />
          </div>
          <div>
            <h1>PostgreSQL HA Monitor</h1>
            <p>High Availability Cluster Dashboard</p>
          </div>
        </div>

        <div className="topbar-right">
          <span className="live-indicator">
            <span className="live-dot" />
            LIVE MONITORING
          </span>

          <button className="refresh-button" onClick={fetchStatus}>
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>
      </header>

      <main className="main-content">
        <section className="page-heading">
          <div>
            <h2>Cluster Overview</h2>
            <p>Monitor PostgreSQL server health, roles and replication.</p>
          </div>

          <div className="last-updated">
            <Clock size={15} />
            Last updated: {lastUpdated || "Waiting..."}
          </div>
        </section>

        {apiError && (
          <div className="alert-box">
            <AlertTriangle size={19} />
            Backend connection error: {apiError}
          </div>
        )}

        <section className="overview-grid">
          <div className="overview-card">
            <div className="overview-icon purple">
              <Database size={21} />
            </div>
            <div>
              <span>Cluster Status</span>
              <h3 className={clusterHealthy ? "healthy-text" : "warning-text"}>
                {loading ? "Loading..." : cluster?.cluster_state.replace("_", " ").toUpperCase() || "UNKNOWN"}
              </h3>
            </div>
          </div>

          <div className="overview-card">
            <div className="overview-icon green">
              <ShieldCheck size={21} />
            </div>
            <div>
              <span>Primary Server</span>
              <h3>{primary?.name || "Not detected"}</h3>
            </div>
          </div>

          <div className="overview-card">
            <div className="overview-icon blue">
              <Activity size={21} />
            </div>
            <div>
              <span>Standby Server</span>
              <h3>{standby?.name || "Not detected"}</h3>
            </div>
          </div>

          <div className="overview-card">
            <div className="overview-icon orange">
              <Server size={21} />
            </div>
            <div>
              <span>Available Servers</span>
              <h3>
                {cluster?.servers.filter((s) => s.available).length ?? 0} / 2
              </h3>
            </div>
          </div>
        </section>

        <section className="section-heading">
          <div>
            <h2>Database Servers</h2>
            <p>Individual server health and configuration</p>
          </div>
        </section>

        <section className="servers-grid">
          {cluster?.servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}

          {!cluster && loading && (
            <div className="empty-state">Connecting to PostgreSQL servers...</div>
          )}
        </section>

        <section className="section-heading operations-title">
          <div>
            <h2>Cluster Operations</h2>
            <p>Simulate primary failure and safely start a node that was previously a standby.</p>
          </div>
          <button
            className="danger-button"
            onClick={stopCurrentPrimary}
            disabled={adminBusy || !primary || cluster?.cluster_state !== "healthy"}
            title={!primary ? "A unique reachable primary is required" : "Stop the currently detected primary"}
          >
            <Power size={16} />
            {adminBusy ? "Working..." : "Stop Current Primary"}
          </button>
        </section>

        {adminMessage && (
          <div className={`admin-result ${adminMessage.success ? "admin-success" : "admin-error"}`}>
            {adminMessage.success ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}
            <span>{adminMessage.text}</span>
          </div>
        )}

        <section className="container-operations-grid">
          {containerMonitor?.containers.map((container) => (
            <div className="container-operation-card" key={container.id}>
              <div className="container-operation-heading">
                <div>
                  <h3>{container.name}</h3>
                  <span>{container.container}</span>
                </div>
                <span className={`status-pill ${container.running ? "online" : "offline"}`}>
                  {container.running ? "Running" : container.status}
                </span>
              </div>
              <div className="container-operation-meta">
                <span>Last observed DB role</span>
                <strong>{container.last_known_role.toUpperCase()}</strong>
              </div>
              {container.error && <p className="error-message">{container.error}</p>}
              {!container.running && (
                <>
                  {container.start_allowed ? (
                    <button
                      className="start-button"
                      disabled={adminBusy}
                      onClick={() => startStandby(container.id, container.name)}
                    >
                      <Play size={15} /> Start Standby
                    </button>
                  ) : (
                    <div className="rejoin-warning">
                      <ShieldAlert size={17} />
                      <span>{container.start_block_reason || "Direct start is blocked until this node is safely rejoined."}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {!containerMonitor && (
            <div className="empty-state">Waiting for Docker container status...</div>
          )}
        </section>

        <section className="section-heading">
          <div>
            <h2>Database Write Test</h2>
            <p>Insert a test record into the currently active primary.</p>
          </div>

          <button
            className="write-button"
            onClick={runWriteTest}
            disabled={writeLoading || !primary || cluster?.cluster_state !== "healthy"}
          >
            <Send size={16} />
            {writeLoading ? "Writing..." : "Run Write Test"}
          </button>
        </section>

        {writeResult && (
          <div className={`write-result ${writeResult.success ? "write-success" : "write-error"}`}>
            {writeResult.success ? (
              <CheckCircle2 size={21} />
            ) : (
              <XCircle size={21} />
            )}

            <div>
              <strong>
                {writeResult.success ? "Write successful" : "Write failed"}
              </strong>

              {writeResult.success ? (
                <>
                  <p>Record ID: {writeResult.record.id}</p>
                  <p>Written by: {writeResult.record.server_name}</p>
                  <p>Message: {writeResult.record.message}</p>
                </>
              ) : (
                <p>{writeResult.error}</p>
              )}
            </div>
          </div>
        )}

        <section className="section-heading">
          <div>
            <h2>Live Database Activity</h2>
            <p>
              Monitoring public.ha_dashboard_write_test on both PostgreSQL servers
            </p>
          </div>

          <span className="live-indicator">
            <span className="live-dot" />
            AUTO REFRESH · 3 SEC
          </span>
        </section>

        {tableMonitorError && (
          <div className="alert-box">
            <AlertTriangle size={19} />
            Table monitoring error: {tableMonitorError}
          </div>
        )}

        <section className="table-monitor-grid">
          {tableMonitor?.servers.map((server) => (
            <div className="table-monitor-card" key={server.id}>
              <div className="table-monitor-header">
                <div>
                  <h3>{server.name}</h3>
                  <span>public.ha_dashboard_write_test</span>
                </div>

                <span className={`status-pill ${server.available ? "online" : "offline"}`}>
                  {server.available ? "Connected" : "Unavailable"}
                </span>
              </div>

              <div className="record-count">
                <span>Total records</span>
                <strong>
                  {server.available ? server.total_records : "—"}
                </strong>
              </div>

              {server.error && (
                <div className="error-message">{server.error}</div>
              )}

              {server.available && (
                <div className="records-table-wrapper">
                  <table className="records-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Message</th>
                        <th>Created At</th>
                        <th>Written By</th>
                      </tr>
                    </thead>

                    <tbody>
                      {server.records.map((record) => (
                        <tr key={record.id}>
                          <td>{record.id}</td>
                          <td>{record.message}</td>
                          <td>{formatDate(record.created_at)}</td>
                          <td>{record.server_name}</td>
                        </tr>
                      ))}

                      {server.records.length === 0 && (
                        <tr>
                          <td colSpan={4}>No records found.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="activity-section">
          <div className="activity-heading">
            <div>
              <h3>Record Change History</h3>
              <p>New inserts and updates detected during monitoring</p>
            </div>

            <span className="activity-count">
              {activityEvents.length} events
            </span>
          </div>

          {activityEvents.length === 0 ? (
            <div className="empty-state">
              No new changes detected yet. Existing records are being monitored.
            </div>
          ) : (
            <div className="activity-list">
              {activityEvents.map((event) => (
                <div className="activity-item" key={event.id}>
                  <span
                    className={`activity-type ${
                      event.type === "INSERT" ? "insert-event" : "update-event"
                    }`}
                  >
                    {event.type}
                  </span>

                  <div className="activity-details">
                    <strong>
                      Record #{event.recordId} — {event.serverName}
                    </strong>
                    <span>{event.message}</span>
                  </div>

                  <time>{event.detectedAt}</time>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="section-heading">
          <div>
            <h2>Replication Overview</h2>
            <p>Current primary-to-standby replication connection</p>
          </div>
        </section>

        <section className="replication-card">
          {primary && standby ? (
            <>
              <div className="replication-node">
                <div className="node-icon primary-node">
                  <Database size={25} />
                </div>
                <strong>{primary.name}</strong>
                <span>PRIMARY</span>
                <small>{primary.host}</small>
              </div>

              <div className="replication-connection">
                <div className="connection-line">
                  <span className="connection-dot" />
                  <span className="connection-dot" />
                  <span className="connection-dot" />
                </div>
                <span className="streaming-label">
                  <Wifi size={15} />
                  {getReplicationStatus(primary)}
                </span>
                <small>WAL Streaming</small>
              </div>

              <div className="replication-node">
                <div className="node-icon standby-node">
                  <Database size={25} />
                </div>
                <strong>{standby.name}</strong>
                <span>STANDBY</span>
                <small>{standby.host}</small>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <WifiOff size={22} />
              Primary and standby connection not fully established.
            </div>
          )}
        </section>

        <footer>
          <span>PostgreSQL High Availability Monitoring</span>
          <span>Automatic refresh: 3 seconds</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
