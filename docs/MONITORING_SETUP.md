# Monitoring Setup Guide

Step-by-step guide for setting up the full ai-net observability stack — Prometheus, Grafana, Loki, and Promtail — on a self-hosted deployment.

> For general node operation, hardware requirements, and Systemd daemon setup, see [NODE_OPERATORS_GUIDE.md](./NODE_OPERATORS_GUIDE.md).

---

## Table of Contents

1. [Overview & Architecture](#1-overview--architecture)
2. [Prerequisites](#2-prerequisites)
3. [Starting the Monitoring Stack](#3-starting-the-monitoring-stack)
4. [Importing the Grafana Dashboard](#4-importing-the-grafana-dashboard)
5. [Configuring Alert Notification Channels](#5-configuring-alert-notification-channels)
6. [Customizing Alert Thresholds](#6-customizing-alert-thresholds)
7. [Loki Log Query Cheatsheet](#7-loki-log-query-cheatsheet)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Overview & Architecture

The ai-net monitoring stack consists of four services:

```
ai-net Backend ──► Prometheus ──► Grafana (dashboards + alerts)
                                         │
ai-net Logs   ──► Promtail ──► Loki ────┘
```

| Component | Role | Default Port |
|---|---|---|
| **Prometheus** | Scrapes and stores time-series metrics from the backend `/metrics` endpoint | `9090` |
| **Grafana** | Visualization, dashboards, and alert notification routing | `3001` |
| **Loki** | Log aggregation backend (receives log streams from Promtail) | `3100` |
| **Promtail** | Log shipping agent; tails container logs and forwards to Loki | — (no public port) |

Metrics exposed by the backend include:
- HTTP request rate, latency, and error rate per endpoint
- Active agents and task queue depth
- Stellar Horizon connection health
- Coordinator DAG execution success/failure rate
- Payment escrow lock/release latency

---

## 2. Prerequisites

Ensure the following are installed and available before proceeding.

| Tool | Minimum Version | Installation |
|---|---|---|
| Docker | 24.x | https://docs.docker.com/engine/install/ |
| Docker Compose | v2.20 | Bundled with Docker Desktop; `apt install docker-compose-plugin` on Linux |
| Grafana | 10.x (pulled automatically via Docker) | — |
| Prometheus | 2.47 (pulled automatically) | — |
| Loki | 2.9 (pulled automatically) | — |
| Promtail | 2.9 (pulled automatically) | — |

Verify your Docker Compose version:

```bash
docker compose version
# Docker Compose version v2.20.0
```

The backend must already be running and healthy before starting monitoring:

```bash
curl -s http://localhost:3000/health | jq .status
# "healthy"
```

---

## 3. Starting the Monitoring Stack

### 3.1 Add monitoring services to Docker Compose

Create or update `docker-compose.monitoring.yml` in the project root:

```yaml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:v2.47.0
    container_name: ai-net-prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./monitoring/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=30d'
      - '--web.enable-lifecycle'
    restart: unless-stopped

  grafana:
    image: grafana/grafana:10.2.0
    container_name: ai-net-grafana
    ports:
      - "3001:3000"
    volumes:
      - grafana_data:/var/lib/grafana
      - ./monitoring/grafana/provisioning:/etc/grafana/provisioning:ro
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:-admin}
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_SERVER_ROOT_URL=http://localhost:3001
    depends_on:
      - prometheus
      - loki
    restart: unless-stopped

  loki:
    image: grafana/loki:2.9.0
    container_name: ai-net-loki
    ports:
      - "3100:3100"
    volumes:
      - ./monitoring/loki/loki-config.yml:/etc/loki/local-config.yaml:ro
      - loki_data:/loki
    command: -config.file=/etc/loki/local-config.yaml
    restart: unless-stopped

  promtail:
    image: grafana/promtail:2.9.0
    container_name: ai-net-promtail
    volumes:
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - /var/run/docker.sock:/var/run/docker.sock
      - ./monitoring/promtail/promtail-config.yml:/etc/promtail/config.yml:ro
    command: -config.file=/etc/promtail/config.yml
    depends_on:
      - loki
    restart: unless-stopped

volumes:
  prometheus_data:
  grafana_data:
  loki_data:
```

### 3.2 Create the monitoring configuration directory

```bash
mkdir -p monitoring/prometheus
mkdir -p monitoring/grafana/provisioning/datasources
mkdir -p monitoring/grafana/provisioning/dashboards
mkdir -p monitoring/loki
mkdir -p monitoring/promtail
```

### 3.3 Prometheus scrape configuration

Create `monitoring/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alerts.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: []

scrape_configs:
  - job_name: 'ai-net-backend'
    static_configs:
      - targets: ['backend:3000']
    metrics_path: '/metrics'

  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
```

### 3.4 Prometheus alert rules

Create `monitoring/prometheus/alerts.yml`:

```yaml
groups:
  - name: ai-net
    rules:
      - alert: BackendDown
        expr: up{job="ai-net-backend"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "ai-net backend is down"
          description: "Backend has been unreachable for more than 1 minute."

      - alert: HighErrorRate
        expr: >
          sum(rate(http_requests_total{status=~"5.."}[5m]))
          / sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High HTTP error rate (>5%)"
          description: "More than 5% of HTTP requests are returning 5xx errors."

      - alert: TaskQueueDepthHigh
        expr: ai_net_task_queue_depth > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Task queue depth is high"
          description: "Task queue depth has exceeded 100 for more than 10 minutes."

      - alert: StellarHorizonUnhealthy
        expr: ai_net_stellar_horizon_healthy == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Stellar Horizon connection is unhealthy"
          description: "Backend cannot reach Stellar Horizon for more than 2 minutes."
```

### 3.5 Loki configuration

Create `monitoring/loki/loki-config.yml`:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

ingester:
  lifecycler:
    ring:
      kvstore:
        store: inmemory
      replication_factor: 1

schema_config:
  configs:
    - from: 2024-01-01
      store: boltdb-shipper
      object_store: filesystem
      schema: v11
      index:
        prefix: index_
        period: 24h

storage_config:
  boltdb_shipper:
    active_index_directory: /loki/boltdb-shipper-active
    cache_location: /loki/boltdb-shipper-cache
    shared_store: filesystem
  filesystem:
    directory: /loki/chunks

limits_config:
  enforce_metric_name: false
  reject_old_samples: true
  reject_old_samples_max_age: 168h
```

### 3.6 Promtail configuration

Create `monitoring/promtail/promtail-config.yml`:

```yaml
server:
  http_listen_port: 9080

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
    relabel_configs:
      - source_labels: ['__meta_docker_container_name']
        target_label: container
      - source_labels: ['__meta_docker_container_label_com_docker_compose_service']
        target_label: service
    pipeline_stages:
      - json:
          expressions:
            level: level
            msg: msg
            correlationId: correlationId
      - labels:
          level:
          correlationId:
```

### 3.7 Grafana datasource provisioning

Create `monitoring/grafana/provisioning/datasources/datasources.yml`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true

  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
```

### 3.8 Start the stack

```bash
# Start the monitoring stack alongside the main stack
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d

# Verify all monitoring containers are healthy
docker compose -f docker-compose.monitoring.yml ps
```

Expected output:

```
NAME                  IMAGE                          STATUS
ai-net-grafana        grafana/grafana:10.2.0         Up (healthy)
ai-net-loki           grafana/loki:2.9.0             Up
ai-net-prometheus     prom/prometheus:v2.47.0        Up
ai-net-promtail       grafana/promtail:2.9.0         Up
```

---

## 4. Importing the Grafana Dashboard

The pre-built ai-net dashboard JSON is located at `backend/grafana/ai-net-dashboard.json`.

### Option A: Import via the Grafana UI (Recommended)

1. Open Grafana at http://localhost:3001
2. Log in with username `admin` and the password set in `GRAFANA_ADMIN_PASSWORD` (default: `admin`)
3. Click the **+** (Create) icon in the left sidebar → **Import**
4. Click **Upload JSON file**
5. Select `backend/grafana/ai-net-dashboard.json`
6. Under **Prometheus**, select the `Prometheus` datasource
7. Click **Import**

You should now see the **ai-net Overview** dashboard with panels for:

- Request rate and error rate
- Task queue depth and throughput
- Active agent count
- Stellar Horizon latency
- Payment escrow lock/release rate
- Memory and CPU usage

### Option B: Provision the dashboard automatically

Create `monitoring/grafana/provisioning/dashboards/dashboards.yml`:

```yaml
apiVersion: 1

providers:
  - name: 'ai-net'
    orgId: 1
    folder: 'ai-net'
    type: file
    disableDeletion: false
    options:
      path: /etc/grafana/provisioning/dashboards
```

Copy the dashboard JSON into the provisioning directory:

```bash
cp backend/grafana/ai-net-dashboard.json \
   monitoring/grafana/provisioning/dashboards/ai-net-dashboard.json
```

Then restart Grafana:

```bash
docker compose -f docker-compose.monitoring.yml restart grafana
```

The dashboard will be available automatically on every fresh Grafana deployment — useful for CI environments and bare-metal reprovisioning.

---

## 5. Configuring Alert Notification Channels

Grafana routes alerts to external services via **Contact Points** and **Notification Policies**.

### 5.1 Slack

1. Create an incoming webhook in your Slack workspace: https://api.slack.com/messaging/webhooks
2. In Grafana, go to **Alerting → Contact points → Add contact point**
3. Choose type **Slack**
4. Paste your webhook URL
5. Set **Channel** to `#ai-net-alerts`
6. Click **Test** to verify, then **Save**

```yaml
# Equivalent provisioning config (monitoring/grafana/provisioning/alerting/slack.yml)
apiVersion: 1

contactPoints:
  - orgId: 1
    name: slack-alerts
    receivers:
      - uid: slack-01
        type: slack
        settings:
          url: ${SLACK_WEBHOOK_URL}
          channel: '#ai-net-alerts'
          title: 'ai-net Alert'
          text: '{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}'
```

### 5.2 PagerDuty

1. Create a Grafana integration in PagerDuty and copy the **Integration Key**
2. In Grafana, go to **Alerting → Contact points → Add contact point**
3. Choose type **PagerDuty**
4. Paste your Integration Key
5. Set **Severity** mapping: `critical` → `critical`, `warning` → `warning`
6. Click **Save**

```yaml
# Equivalent provisioning config
contactPoints:
  - orgId: 1
    name: pagerduty-critical
    receivers:
      - uid: pd-01
        type: pagerduty
        settings:
          integrationKey: ${PAGERDUTY_INTEGRATION_KEY}
          severity: critical
```

### 5.3 Email (SMTP)

Configure SMTP in `docker-compose.monitoring.yml` under the `grafana` service environment:

```yaml
environment:
  - GF_SMTP_ENABLED=true
  - GF_SMTP_HOST=smtp.example.com:587
  - GF_SMTP_USER=${SMTP_USER}
  - GF_SMTP_PASSWORD=${SMTP_PASSWORD}
  - GF_SMTP_FROM_ADDRESS=alerts@ai-net.example.com
  - GF_SMTP_FROM_NAME=ai-net Monitoring
```

Then add an email contact point via the Grafana UI or provisioning YAML.

### 5.4 Notification Policies

Set the default routing policy to silence low-severity alerts outside business hours:

1. Go to **Alerting → Notification policies**
2. Edit the **Default policy**
3. Set **Contact point** to `slack-alerts`
4. Add a child policy with matcher `severity = critical` → `pagerduty-critical`

---

## 6. Customizing Alert Thresholds

Different deployment sizes require different thresholds. Edit `monitoring/prometheus/alerts.yml` and reload Prometheus:

```bash
curl -X POST http://localhost:9090/-/reload
```

### Single-node deployment (1 backend instance)

```yaml
# Looser thresholds — single node has higher variance
- alert: HighErrorRate
  expr: >
    sum(rate(http_requests_total{status=~"5.."}[5m]))
    / sum(rate(http_requests_total[5m])) > 0.10  # 10% threshold
  for: 10m

- alert: TaskQueueDepthHigh
  expr: ai_net_task_queue_depth > 50
  for: 15m
```

### Multi-node deployment (3+ backend instances)

```yaml
# Stricter thresholds — aggregated traffic is more stable
- alert: HighErrorRate
  expr: >
    sum(rate(http_requests_total{status=~"5.."}[5m]))
    / sum(rate(http_requests_total[5m])) > 0.02  # 2% threshold
  for: 5m

- alert: TaskQueueDepthHigh
  expr: ai_net_task_queue_depth > 200
  for: 10m

- alert: InstanceDown
  expr: count(up{job="ai-net-backend"} == 0) > 0
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "One or more backend instances are down"
```

### Adjusting Grafana dashboard variable defaults

1. Open the **ai-net Overview** dashboard
2. Click the gear icon → **Variables**
3. Edit the `instance` variable to change the default selected nodes

---

## 7. Loki Log Query Cheatsheet

Open the Loki **Explore** view at http://localhost:3001/explore and select `Loki` as the datasource.

### Query 1 — All backend error logs in the last hour

```logql
{service="backend"} |= "ERROR" | json | line_format "{{.msg}}"
```

### Query 2 — Trace a specific request by correlation ID

```logql
{service="backend"} | json | correlationId="f47ac10b-58cc-4372-a567-0e02b2c3d479"
```

Use this when a user reports a failed request and provides the `correlationId` from the error response.

### Query 3 — Payment failures in the last 24 hours

```logql
{service="backend"} |= "escrow" |= "error" | json level="error"
  | line_format "{{.timestamp}} [{{.correlationId}}] {{.msg}}"
```

### Query 4 — Agent heartbeat timeouts

```logql
{service="backend"} |= "heartbeat" |= "timeout"
  | json
  | line_format "{{.timestamp}} agent={{.agentId}} {{.msg}}"
```

### Query 5 — Soroban / Stellar Horizon connection errors

```logql
{service="backend"} |= "Horizon" |= "error"
  | json
  | line_format "{{.timestamp}} status={{.statusCode}} {{.msg}}"
```

### Counting errors over time (metric query)

```logql
sum(rate({service="backend"} |= "ERROR" [5m])) by (level)
```

Switch to **Metrics** mode in the Explore view to render this as a graph.

---

## 8. Troubleshooting

### Metrics not appearing in Grafana

**Check that Prometheus can reach the backend:**

```bash
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job, health, lastError}'
```

If `health` is `"down"` and `lastError` mentions connection refused, verify that:
1. The backend container is running: `docker compose ps backend`
2. The `targets` in `prometheus.yml` use the Docker service name (`backend:3000`), not `localhost:3000`
3. Both the backend and Prometheus are on the same Docker network

**Check the backend exposes a `/metrics` endpoint:**

```bash
curl -s http://localhost:3000/metrics | head -20
```

If the endpoint returns `404`, the backend has not been instrumented. Check `backend/src/` for Prometheus client initialization.

### Alerts not firing

1. Confirm alert rules loaded: http://localhost:9090/rules
2. Check evaluation errors: http://localhost:9090/alerts
3. Verify Grafana can reach Prometheus:
   ```bash
   docker exec ai-net-grafana wget -qO- http://prometheus:9090/api/v1/query?query=up
   ```
4. Test a contact point manually: **Alerting → Contact points → Test**

### Loki not receiving logs

**Check Promtail is running and tailing the right containers:**

```bash
docker logs ai-net-promtail 2>&1 | tail -30
```

Look for `"tailer: tail routine started"` lines. If absent, verify that:
1. `/var/run/docker.sock` is mounted and accessible
2. The `docker_sd_configs` section in `promtail-config.yml` is correct

**Verify Loki is receiving data:**

```bash
curl -s "http://localhost:3100/loki/api/v1/query?query=%7Bservice%3D%22backend%22%7D" | jq .
```

An empty `result` array means no logs have been ingested for the `service="backend"` label. Check that `relabel_configs` in Promtail maps the Docker Compose service label correctly.

### Grafana dashboard panels show "No data"

1. Verify the Prometheus datasource URL in Grafana → **Configuration → Data sources → Prometheus → Test**
2. Confirm metric names match what the backend exports. Query http://localhost:9090/api/v1/label/__name__/values to list all known metric names.
3. Adjust the dashboard time range to cover the period when data was generated.

### Docker network isolation

If monitoring containers cannot reach `backend:3000`, ensure all services share a network:

```yaml
# Add to docker-compose.monitoring.yml
networks:
  default:
    external: true
    name: ai-net_default
```

The main `docker-compose.yml` creates a network named `ai-net_default` by default. Override this if your compose project name differs.

---

## Related Documentation

- [Node Operators Guide](./NODE_OPERATORS_GUIDE.md) — Hardware specs, secrets management, and systemd daemon setup
- [REST API Reference](./API_REFERENCE.md) — `/health`, `/metrics` endpoints
- [UPTIME_MONITORING.md](./operations/health-and-shutdown.md) — Graceful shutdown and health probe behavior
