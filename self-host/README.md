# Self-hosted stack

[`compose.yaml`](compose.yaml) runs TulipFarm on one machine with Docker Compose 2.20
or later. Full guides live at [docs.tulipfarm.ai](https://docs.tulipfarm.ai).

```sh
cp self-host/.env.example self-host/.env   # then fill in the values
cd self-host && docker compose up -d --build --wait
```

## Temporal

The stack runs Temporal (server, UI, and the schema and namespace jobs built from
[`infra/temporal/admin`](../infra/temporal/admin)) under the Compose profile
`temporal`. `.env.example` turns it on with `COMPOSE_PROFILES=temporal`.

To use your own Temporal server or Temporal Cloud instead, set in `self-host/.env`:

```sh
COMPOSE_PROFILES=                          # no bundled Temporal services
TEMPORAL_ADDRESS=temporal.example.com:7233
TEMPORAL_NAMESPACE=tulipfarm               # must already exist
TEMPORAL_UI_URL=                           # your Temporal UI URL, or empty to skip its health probe
```

The api, worker, and storage-worker then start without waiting for the bundled
namespace job. For Temporal Cloud, also set `TEMPORAL_TLS=true` and
`TEMPORAL_API_KEY` to a namespace-scoped key. All Temporal clients and both worker
connections use these settings. With both unset, local and self-hosted connections
keep their existing plaintext, unauthenticated behavior. `TEMPORAL_TLS=false`
explicitly disables TLS; other non-empty values are rejected.

`TEMPORAL_API_KEY_FILE` can read the key from a mounted file instead. The path is
inside each container; mount the file read-only into api, worker and storage-worker
using a Compose override. Do not set a direct value and a different file value.

## Public web

Agent web search and page reads are off unless `FIRECRAWL_ENDPOINT` is set. It
takes the origin of a Firecrawl-compatible API that serves
`POST /v2/search` and `POST /v2/scrape`. That service fetches URLs
that agents choose, so it must not be able to reach your internal network: run it
on an isolated network with egress to the public internet only.

For Firecrawl Cloud, set `FIRECRAWL_ENDPOINT=https://api.firecrawl.dev` and
`FIRECRAWL_API_KEY` (or `FIRECRAWL_API_KEY_FILE`, mounted into api and worker).
Requests send the key as a Bearer token, never in the body or URL. Health uses
authenticated `GET /v2/team/credit-usage`, which reads usage without fetching pages
or spending scrape credits. Keyless self-hosted services keep the `GET /health`
probe. Both probes require 2xx and reject redirects.

## Health

The API health route is **`/v1/health`**, not `/health`. It returns 200 only when
configured dependencies respond, including an ordinary worker workflow.
`/v1/health/live` is a dependency-free liveness check. Set `TEMPORAL_UI_URL=`
to omit the Temporal UI check when using a service without a reachable UI.
`storageMaintenance` is checked only with `WORKSPACE_STORAGE_CAPABILITY=isolated-v1`;
unset, empty or `disabled` omits it.

## Managed Postgres

`pnpm self-host:setup --out /private/generated` also works outside Compose against
plain or managed Postgres, including RDS. Set `TULIPFARM_DATABASE_ADMIN_URL`
(or its `_FILE` form) to the master/admin URL and the
`TULIPFARM_OBJECT_STORAGE_*` settings shown by `pnpm self-host:setup --help`.
The admin needs authority to create roles and databases, grant role membership,
and install pgvector (`vector` >= 0.8.0). The server must provide that extension.
Setup creates roles, databases, extensions, migrations, restricted storage and
email logins, and the bucket. Keep the generated state and env files private;
reruns reuse the same keys and passwords. URL query parameters, including TLS,
are preserved in scoped login URLs.

This path does not use Azure CLI credentials. Database CLI operations also default
to `DATABASE_PROVIDER=postgres`; only explicit `DATABASE_PROVIDER=azure` enables
Azure server management. See [database operations](../apps/database/README.md).

## Upgrades

Setup applies application migrations on every start. Workspace storage has a
second stream, the common workspace migrations, that runs only after every
service is on the new release: older services refuse a workspace upgraded past
what they know. Until it runs, creating a workspace fails and existing
workspaces keep their old tables. After `docker compose up -d --build --wait`
finishes, run:

```sh
cd self-host && docker compose run --rm --entrypoint node setup \
  --env-file=/setup/storage-worker.env apps/database/src/cli.ts workspace-rollout --env local
```

It applies the stream to every ready workspace and is safe to rerun. Outside
Compose, run `pnpm db workspace-rollout --env local` with
`WORKSPACE_PROVISIONING_DATABASE_URL` set.

## Email transport

No email provider is required to start the API or worker. Leave `EMAIL_PROVIDER`,
`ACS_CONNECTION_STRING`, and `SMTP_HOST` unset to disable delivery. A generated
email database URL alone does not turn delivery on.

For any SMTP service, including Amazon SES SMTP, set `EMAIL_PROVIDER=smtp`,
`SMTP_HOST`, `SMTP_FROM_ADDRESS`, `SMTP_USER`, and `SMTP_PASSWORD` (or
`SMTP_PASSWORD_FILE` on the worker). Port 587 with `SMTP_SECURE=false` and
`SMTP_REQUIRE_TLS=true` uses STARTTLS; port 465 with `SMTP_SECURE=true` uses TLS
from the start. No ACS credentials are needed. The worker also needs its
restricted `EMAIL_DELIVERY_DATABASE_URL` and email encryption keys, which setup
generates. Set `EMAIL_PROVIDER=smtp` on the API as well so password reset email
is offered; keep the SMTP password only on the worker.

## Web app

The web image is built by Compose and calls the API on the same origin, so it needs
no API URL of its own. One optional build setting in `self-host/.env` changes it:
`TULIPFARM_SUPPORT_EMAIL` shows a support address on the Help page. Unset hides
the contact section.

Rebuild the web image after changing it: `docker compose up -d --build web`.

## Sign-in methods

`AUTH_METHODS` lists the sign-in methods to allow, separated by commas:

| Method       | Needs                                                      |
| ------------ | ---------------------------------------------------------- |
| `password`   | Nothing. Email and password.                               |
| `magic-link` | An email transport (SMTP or Azure Communication Services). |
| `google`     | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.             |

Leave it unset to allow email links when an email transport is configured and
Google when its keys are set. Password sign-in is off unless listed. A listed method
whose credentials are missing stays off, and the api logs a warning at startup. The
login and sign-up pages show only the allowed methods, and say so when none is set up.
Restart the api after changing it: `docker compose up -d api`.

### Password sign-in

An instance without an email transport can use email and password sign-in: set
`AUTH_METHODS=password` (add `google` to keep Google) in `self-host/.env` and
restart the api. The login and sign-up pages then ask for a password.

- Anyone who can reach the instance can create an account, as with email links.
  Workspaces still join by invitation. Without email, invitations show a link to
  copy and send yourself.
- Passwords are 8 to 128 characters. Each client gets 10 password attempts a minute
  and each address 10 every 15 minutes, and Turnstile applies when it is configured.
- People change their password under **Account**, which signs out their other
  devices.
- With an email transport, **Forgot password?** emails a reset link. Without one,
  an administrator prints a one-time link that works for an hour:

  ```sh
  docker compose exec api node --env-file=/run/tulipfarm/api.env dist/auth-reset-password.js you@company.com
  ```

  From a source checkout, the same command is `pnpm auth:reset-password you@company.com`.

- People who signed up with an email link or Google have no password. They set one
  with a reset link. An email link sign-in proves the address, so it removes a
  password set by someone whose address was never confirmed.

## Image recognition

TulipFarm reads the text in images with a model whose catalog entry declares
`"imageInput": true`. It does this for images in Knowledge documents, in files
attached to chat, and in task inputs. Without the workspace `images` flag, the
model is the catalog's `document-vision` role. With the flag, it is the image
reader a workspace admin picks in image settings, which defaults to that role.
Turning the flag on or off needs no migration.

Recognitions are stored per workspace in `tf_knowledge_recognitions`, keyed by
image hash, model and prompt version. Changing the model or prompt reads images
again. Each row records the file it was read from. The Knowledge sweep deletes,
oldest first, rows older than a day whose file is no longer held by Files, a
live chat attachment or a Knowledge revision. Each image costs
Knowledge ingestion credits of the workspace. When credits run out, that image
is reported as not read and the rest of the file continues. If no model reads
images, or the admin turns recognition off, images are reported as unread
(`ocr-unavailable`).

## Telemetry

The api, worker, and storage-worker can export OpenTelemetry traces, metrics, and
logs over OTLP/HTTP (protobuf) to any backend: your own OpenTelemetry Collector,
Grafana Cloud, Honeycomb, New Relic, SigNoz, Jaeger, or a Datadog Agent. Export is
off unless `CLOUD_TELEMETRY_ENABLED=true`, and it runs only in the production
images. Nothing is sent to TulipFarm.

Only reviewed data leaves the process: spans keep allowlisted attributes, drop
events, and keep links without their attributes; logs carry allowlisted fields, and
errors carry reviewed codes instead of messages. The same rules apply whatever the backend.

| Setting                                               | Purpose                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CLOUD_TELEMETRY_OTLP_ENDPOINT`                       | Base URL. `/v1/traces`, `/v1/metrics`, and `/v1/logs` are appended.                                        |
| `CLOUD_TELEMETRY_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | Full URL for one signal, used as-is instead of the base URL.                                               |
| `CLOUD_TELEMETRY_OTLP_AUTHORIZATION`                  | Optional `Authorization` value, such as `Basic <base64>` or `Bearer <token>`.                              |
| `CLOUD_TELEMETRY_OTLP_HEADERS`                        | Optional headers as `name=value,name2=value2`, values percent-encoded, as in `OTEL_EXPORTER_OTLP_HEADERS`. |
| `CLOUD_TELEMETRY_{TRACES,METRICS,LOGS}_ENABLED`       | `false` stops one signal. All three are on by default.                                                     |
| `CLOUD_TELEMETRY_SAMPLE_RATIO`                        | Share of new traces to keep, `0` to `1`. Default `0.1`.                                                    |
| `CLOUD_TELEMETRY_JOB_SAMPLE_RATIO`                    | Share of new background `job.*` traces to keep, `0` to `1`. Default `0.01`.                                |
| `CLOUD_TELEMETRY_ENVIRONMENT`                         | `deployment.environment` and the `environment` metric label, such as `staging`. Default `production`.      |
| `CLOUD_TELEMETRY_OTLP_ALLOW_HTTP`                     | `true` allows plain `http` to a public host.                                                               |

Endpoints must use `https`. Plain `http` works without `CLOUD_TELEMETRY_OTLP_ALLOW_HTTP`
for `localhost`, private IP addresses, and single-label, `.local`, or `.internal`
host names, such as a collector in this stack. URLs must not contain credentials,
a query, or a fragment; put credentials in the authorization or header settings.
Both are secrets: they are never logged, and `CLOUD_TELEMETRY_OTLP_AUTHORIZATION_FILE`
and `CLOUD_TELEMETRY_OTLP_HEADERS_FILE` read them from files. Invalid settings stop
export and log `telemetry_configuration_invalid` with the setting name only; each
service logs `telemetry_export` with `outcome` `sent` once per signal when export works.

Standard `OTEL_*` variables do not turn export on or choose its endpoint or sampling,
so variables injected for other processes cannot redirect it. The OpenTelemetry
exporter itself still reads `OTEL_EXPORTER_OTLP_HEADERS` (added under the TulipFarm
headers), `OTEL_EXPORTER_OTLP_COMPRESSION`, and the `OTEL_EXPORTER_OTLP_CERTIFICATE`,
`_CLIENT_CERTIFICATE` and `_CLIENT_KEY` files for a private CA or mutual TLS.

Restart the services after changing these settings: `docker compose up -d api worker storage-worker`.

### Sampling

Sampling is decided once, when a trace starts, without a collector. Child spans
and the worker spans of a Temporal workflow follow their parent's decision.

- Chat replies are always kept. The send request that starts a reply is always
  sampled, and the reply continues its trace through the worker and model calls.
  A reply started by the background sweep gets its own `chat.turn` root, linked
  to the sweep span.
- Background `job.*` sweeps use `CLOUD_TELEMETRY_JOB_SAMPLE_RATIO`. Every run,
  sampled or not, still logs failures and counts runs and durations in metrics.
- Every other new trace uses `CLOUD_TELEMETRY_SAMPLE_RATIO`.

Each log line with a `trace_id` also has `trace_sampled` (`true` or `false`). Only
sampled trace ids exist in the trace backend.

### Find a chat reply's trace

Telemetry never carries chat or conversation ids. Each reply instead stores the
trace id of its latest attempt, and whether it was sampled, on its turn record.
An operator with the workspace provisioning credential looks it up from the chat URL:

```sh
WORKSPACE_PROVISIONING_DATABASE_URL=... \
  pnpm db chat-traces --env local --chat 'https://app.example.com/<workspace>/chat/<chat-id>'
```

It prints each turn's id, sequence, status, attempts, times, `traceId` and
`traceSampled`, never message content. Add `--workspace <id>` to skip searching
every ready workspace. Open `traceId` in your trace backend. A turn from before
this change, or one that has not started, has no trace id.

### OpenTelemetry Collector in this stack

Add the collector next to `compose.yaml` in `self-host/compose.override.yaml`,
which Compose reads automatically:

```yaml
services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.140.0
    restart: unless-stopped
    volumes: ['./otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro']
```

Configure it in `self-host/otel-collector.yaml`, then forward to any backend from there:

```yaml
receivers:
  otlp:
    protocols:
      http: { endpoint: 0.0.0.0:4318 }
processors:
  batch: {}
exporters:
  otlphttp:
    endpoint: https://otlp.example.com # your backend
service:
  pipelines:
    traces: { receivers: [otlp], processors: [batch], exporters: [otlphttp] }
    metrics: { receivers: [otlp], processors: [batch], exporters: [otlphttp] }
    logs: { receivers: [otlp], processors: [batch], exporters: [otlphttp] }
```

```sh
CLOUD_TELEMETRY_ENABLED=true
CLOUD_TELEMETRY_OTLP_ENDPOINT=http://otel-collector:4318
```

A Datadog Agent with OTLP ingest over HTTP enabled works the same way:
`CLOUD_TELEMETRY_OTLP_ENDPOINT=http://datadog-agent:4318`.

### Honeycomb

```sh
CLOUD_TELEMETRY_ENABLED=true
CLOUD_TELEMETRY_OTLP_ENDPOINT=https://api.honeycomb.io   # https://api.eu1.honeycomb.io in the EU
CLOUD_TELEMETRY_OTLP_HEADERS=x-honeycomb-team=<ingest key>
```

Honeycomb stores metrics in a dataset; add `,x-honeycomb-dataset=tulipfarm-metrics`
or set `CLOUD_TELEMETRY_METRICS_ENABLED=false`.

### New Relic

```sh
CLOUD_TELEMETRY_ENABLED=true
CLOUD_TELEMETRY_OTLP_ENDPOINT=https://otlp.nr-data.net   # https://otlp.eu01.nr-data.net in the EU
CLOUD_TELEMETRY_OTLP_HEADERS=api-key=<license key>
```

### Grafana Cloud

```sh
CLOUD_TELEMETRY_ENABLED=true
CLOUD_TELEMETRY_OTLP_ENDPOINT=https://otlp-gateway-<zone>.grafana.net/otlp
CLOUD_TELEMETRY_OTLP_AUTHORIZATION='Basic <base64 of instance-id:token>'
```
