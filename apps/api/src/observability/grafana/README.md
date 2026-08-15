# Grafana Cloud assets — TulipFarm AI Observability

Ready-made dashboard + alert rules for the metrics TulipFarm pushes to Grafana Cloud over OTLP.

## 1. Enable the export

In your soul repo, create `observability.config.yaml`:

```yaml
enabled: true
retention_days: 90
spend_alert_usd: 50
otlp:
  endpoint: https://otlp-gateway-<region>.grafana.net/otlp
  instance_id: "<your-grafana-cloud-instance-id>"
  token: env://GRAFANA_OTLP_TOKEN # or a secret ref managed in Operate → Business → Secrets
```

The `token` is a secret reference — set `GRAFANA_OTLP_TOKEN` in the environment, or store it via
**Operate → Business → Secrets** and reference it here. Restart the API to start the exporter.

## 2. Import the dashboard

Grafana → Dashboards → New → Import → upload [`dashboard.json`](./dashboard.json). Pick your Grafana
Cloud Prometheus (Mimir) data source when prompted.

## 3. Load the alert rules

[`alerts.yaml`](./alerts.yaml) is in Prometheus/Mimir ruler format. Load it via the Mimir ruler
(`mimirtool rules load`) or recreate the rules in Grafana Alerting against your Prometheus data
source. Tune thresholds to your workload.

These rules are optional. `spend_alert_usd` is enforced by the instance itself — the API schedules
an hourly check and the Worker reports a breach to the operator log — so the spend ceiling works
with none of this set up. The threshold in `alerts.yaml` is separate and must be edited there.

## Exported metrics (all cumulative counters)

| Metric | Labels | Meaning |
| --- | --- | --- |
| `llm_calls_total` | model, provider, tier, status | One per model step (`status` = ok/fallback/error) |
| `llm_tokens_total` | model | Input + output tokens |
| `llm_cost_usd_total` | model | Frozen USD cost (priced models only) |
| `tool_calls_total` | tool_name, status | One per tool invocation |
| `turns_total` | status | One per chat turn (ok/error/blocked) |
| `job_runs_total` | queue, status | One per background job run |

Labels are bounded by design — high-cardinality ids (conversation/user/call) are never metric
labels; use the in-app dashboard or traces to drill into individual conversations.

## Traces (Tempo)

When export is enabled, TulipFarm also pushes one trace per chat turn over OTLP to Tempo: a root
`turn` span with child `llm_call` / `tool_call` spans (durations, model/provider, status). Open the
Tempo data source in Grafana to inspect individual turns; the in-app **Operate → Health →
Observability → Recent turns** drill-down shows the same timeline without leaving TulipFarm.
