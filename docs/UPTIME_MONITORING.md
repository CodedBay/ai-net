# Uptime Monitoring & Status Page

This document describes the external uptime monitoring setup for all ai-net production and staging endpoints, alerting configuration, and incident response procedure.

**Resolves [#123](https://github.com/Chrisnec265/ai-net/issues/123)**

---

## Status Page

🟢 **Public Status Page**: [https://status.ai-net.app](https://status.ai-net.app)

> If you are setting up monitoring for the first time, configure your monitoring tool (see below) and update this URL with your actual status page URL.

Incident history is retained for **90 days**.

---

## Monitored Endpoints

| Endpoint | URL | Check Interval | Method |
|---|---|---|---|
| Backend API Health | `https://api.ai-net.app/health` | Every **1 minute** | HTTP GET — expect `200` |
| Frontend | `https://app.ai-net.app/` | Every **5 minutes** | HTTP GET — expect `200` |
| Stellar Horizon | `https://horizon-testnet.stellar.org/fee_stats` | Every **5 minutes** | HTTP GET — expect `200` |
| Venice AI Connectivity | `https://api.venice.ai/api/v1/models` | Every **5 minutes** | HTTP GET — expect `200`/`401` (connectivity check, not auth) |

---

## Recommended Tools

Choose **one** of the following options. The self-hosted Uptime Kuma option is recommended for teams that want full control and zero cost.

### Option A — Uptime Kuma (Self-Hosted, Recommended)

[Uptime Kuma](https://github.com/louislam/uptime-kuma) is a free, open-source monitoring tool with a built-in status page.

#### Docker Compose Setup

Add the following service to `docker-compose.yml`:

```yaml
services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    container_name: uptime-kuma
    volumes:
      - uptime-kuma-data:/app/data
    ports:
      - "3001:3001"
    restart: unless-stopped

volumes:
  uptime-kuma-data:
```

Then access the dashboard at `http://localhost:3001` and configure the monitors below.

#### Monitor Configuration (Uptime Kuma)

Import this configuration via the Uptime Kuma backup/restore feature, or configure manually:

```json
{
  "monitors": [
    {
      "name": "Backend API — /health",
      "type": "http",
      "url": "https://api.ai-net.app/health",
      "interval": 60,
      "retryInterval": 30,
      "maxretries": 1,
      "method": "GET",
      "expectedKeyword": null,
      "statuspageSlug": "ai-net"
    },
    {
      "name": "Frontend",
      "type": "http",
      "url": "https://app.ai-net.app/",
      "interval": 300,
      "retryInterval": 60,
      "maxretries": 1,
      "method": "GET",
      "statuspageSlug": "ai-net"
    },
    {
      "name": "Stellar Horizon — fee_stats",
      "type": "http",
      "url": "https://horizon-testnet.stellar.org/fee_stats",
      "interval": 300,
      "retryInterval": 60,
      "maxretries": 2,
      "method": "GET",
      "statuspageSlug": "ai-net"
    },
    {
      "name": "Venice AI — Connectivity",
      "type": "http",
      "url": "https://api.venice.ai/api/v1/models",
      "interval": 300,
      "retryInterval": 60,
      "maxretries": 2,
      "method": "GET",
      "acceptedStatuscodes": ["200-299", "401"],
      "statuspageSlug": "ai-net"
    }
  ]
}
```

### Option B — UptimeRobot (Managed SaaS)

[UptimeRobot](https://uptimerobot.com) offers a free tier with 5-minute checks.

1. Create a free account at [uptimerobot.com](https://uptimerobot.com).
2. Add monitors for each endpoint in the table above.
3. Enable the public status page and add the URL to this document and the README.

**Limitations**: Free tier only supports 5-minute intervals. For 1-minute checks on the backend health endpoint, use the paid tier ($7/month) or switch to Uptime Kuma.

### Option C — Better Uptime (Managed SaaS)

[Better Uptime](https://betteruptime.com) offers 1-minute checks, on-call scheduling, and a branded status page.

1. Sign up at [betteruptime.com](https://betteruptime.com).
2. Add monitors for all endpoints.
3. Configure the on-call escalation policy.
4. Publish the status page and add the URL to this document and the README.

---

## Alerting Configuration

### Alert Trigger

Alerts fire when a monitor is down for **more than 2 minutes** (i.e., 2 consecutive failed checks for 1-minute monitors, or 1 failed check for 5-minute monitors).

### Notification Channels

Configure **both** channels below for redundancy.

#### Email Alerts

| Setting | Value |
|---|---|
| Recipients | `team@ai-net.app` (or your team's email) |
| Subject format | `[ai-net] DOWN: <monitor name>` |
| Recovery notification | ✅ Enabled |

#### Slack/Discord Alerts

For Uptime Kuma:

1. Go to **Settings → Notifications → Add Notification**.
2. Choose **Slack** or **Discord**.
3. Paste your incoming webhook URL.
4. Test the notification.
5. Assign the notification to all monitors.

**Slack webhook URL**: Store in `SLACK_WEBHOOK_URL` environment variable (never commit to source control).

**Alert message format:**

```
🔴 [DOWN] Backend API — /health
Duration: 3 minutes
URL: https://api.ai-net.app/health
Status: Connection timeout
```

```
✅ [RECOVERED] Backend API — /health
Downtime: 5 minutes
URL: https://api.ai-net.app/health
```

---

## Status Page Configuration

### Setting Up the Status Page (Uptime Kuma)

1. Navigate to **Status Pages** in the Uptime Kuma sidebar.
2. Click **New Status Page**.
3. Set slug to `ai-net` (accessible at `http://your-host:3001/status/ai-net`).
4. Add all four monitors to the status page.
5. Configure the page title: **ai-net Network Status**.
6. Enable **incident history** for 90 days.
7. (Optional) Set a custom domain: `status.ai-net.app`.

### Incident History

All incidents are automatically logged on the status page with:
- Start time and end time
- Affected monitor(s)
- Downtime duration
- Root cause (add manually in the incident description)

---

## Incident Response Procedure

When an alert fires:

### Immediate (0–5 minutes)

1. Acknowledge the alert in Slack (react with 👀 to signal you are investigating).
2. Check the status page for the affected endpoint(s).
3. Check the backend health endpoint directly: `curl -s https://api.ai-net.app/health | jq .`

### Investigation (5–15 minutes)

4. Check backend logs: `docker compose logs backend --tail=100`
5. Check container status: `docker compose ps`
6. Check Stellar Horizon status: `curl -s https://horizon-testnet.stellar.org/fee_stats | jq .`
7. Check Venice AI status: [status.venice.ai](https://status.venice.ai) (if Venice is affected)

### Escalation

8. If not resolved within 15 minutes, escalate to the on-call maintainer.
9. Post a status page incident update with preliminary root cause.

### Resolution

10. Once resolved, mark the incident as resolved on the status page.
11. Add a root cause note to the status page incident.
12. Post a brief retrospective in `#incidents` Slack within 24 hours.

---

## Staging Endpoint Monitoring

Apply the same monitoring configuration to staging endpoints with a separate status page:

| Endpoint | Staging URL |
|---|---|
| Backend API | `https://staging-api.ai-net.app/health` |
| Frontend | `https://staging.ai-net.app/` |

---

## README Badge

Add this badge to the top of `README.md` once your status page is live:

```markdown
[![Status](https://img.shields.io/uptimerobot/status/<monitor-id>.svg?label=status)](https://status.ai-net.app)
```

Or for Uptime Kuma with `kuma-badge` (requires the API endpoint to be public):

```markdown
[![Status](https://status.ai-net.app/api/badge/<monitor-id>/status)](https://status.ai-net.app)
```

---

## Related

- Health endpoint: `backend/src/index.ts` (GET `/health`)
- Docker Compose stack: `docker-compose.yml`
- Backup & DR docs: `docs/DATABASE_BACKUP_DR.md`
- Node Operators Guide: `docs/NODE_OPERATORS_GUIDE.md`
