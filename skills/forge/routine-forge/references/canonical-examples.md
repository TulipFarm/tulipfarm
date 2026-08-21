# Routine & Trigger Canonical Examples

Every Routine and Trigger published to the Soul must conform to `apiVersion: tulipfarm.ai/v1`.

## General Rules & Constraints

- Routine and Trigger documents are separate canonical Soul definitions, committed together atomically via `routine_forge`.
- `metadata.id`: fresh UUID (`8f14e...` / `11111111-1111-4111-8111-111111111111`).
- `metadata.slug`: lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), matching the Routine or Trigger name.
- `metadata.schemaVersion`: `1`
- `metadata.authoredVersion`: `1` (integer, incremented when updating).
- `metadata.lifecycle`: `"published"`
- All State names (`start`, state `name`, `transition`, branch conditions `transition`, `body`, `forState`, etc.) must match `^[A-Za-z][A-Za-z0-9_]*$`: letters, digits, and underscores only (**no hyphens**). PascalCase or snake_case is standard.

---

## 1. Minimal Routine with Manual Trigger

### Routine Document
```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 11111111-1111-4111-8111-111111111111
  slug: daily-report
  displayName: Daily Report Generation
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: operations
  start: RunReport
  states:
    - name: RunReport
      type: tool
      toolRef:
        name: record_search
        version: "1"
      action: record_search
      input:
        type: report
      end: true
```

### Trigger Document
```yaml
apiVersion: tulipfarm.ai/v1
kind: Trigger
metadata:
  id: 22222222-2222-4222-8222-222222222222
  slug: daily-report-manual
  displayName: Manual Trigger for Daily Report
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  type: manual
  routineRef:
    name: daily-report
    version: "1"
  eventType: routine.manual
  eventVersion: 1
  backgroundIdentity:
    principalKind: service
    principalId: routine-runner
  deduplication:
    key: daily-report-manual
```

---

## 2. Scheduled Cron Routine with Branching & Approvals

### Routine Document
```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 33333333-3333-4333-8333-333333333333
  slug: stale-ticket-sweep
  displayName: Stale Ticket Sweep
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: support-ops
  start: FindStaleTickets
  states:
    - name: FindStaleTickets
      type: tool
      toolRef:
        name: record_search
        version: "1"
      action: record_search
      input:
        type: ticket
        filter: "status == 'open' && updatedAt < now - 7d"
      transition: EvaluateTickets

    - name: EvaluateTickets
      type: agent
      agentRef:
        name: support-triage
        version: "1"
      input:
        tickets: "${states.FindStaleTickets.output.records}"
      output:
        type: object
        required: [shouldClose, ticketIds, reason]
        properties:
          shouldClose:
            type: boolean
          ticketIds:
            type: array
            items:
              type: string
          reason:
            type: string
      transition: RouteDecision

    - name: RouteDecision
      type: branch
      conditions:
        - condition: "${states.EvaluateTickets.output.shouldClose} == true"
          transition: RequestClosureApproval
      default:
        end: true

    - name: RequestClosureApproval
      type: approval
      approverRoles:
        - support-lead
        - admin
      transition: CloseStaleTickets

    - name: CloseStaleTickets
      type: tool
      toolRef:
        name: record_update
        version: "1"
      action: record_update
      input:
        type: ticket
        ids: "${states.EvaluateTickets.output.ticketIds}"
        patch:
          status: closed
          closureReason: "${states.EvaluateTickets.output.reason}"
      end: true
```

### Cron Trigger Document
```yaml
apiVersion: tulipfarm.ai/v1
kind: Trigger
metadata:
  id: 44444444-4444-4444-8444-444444444444
  slug: stale-ticket-sweep-cron
  displayName: Nightly Stale Ticket Sweep Cron
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  type: cron
  expression: "0 2 * * *"
  timezone: "UTC"
  routineRef:
    name: stale-ticket-sweep
    version: "1"
  eventType: routine.cron
  eventVersion: 1
  backgroundIdentity:
    principalKind: service
    principalId: routine-runner
  deduplication:
    key: "stale-ticket-sweep-${scheduledTime}"
  schedule:
    missedRunPolicy: run_once
    overlapPolicy: skip
```

---

## 3. Webhook Triggered Automation

### Routine Document
```yaml
apiVersion: tulipfarm.ai/v1
kind: Routine
metadata:
  id: 55555555-5555-4555-8555-555555555555
  slug: webhook-issue-triage
  displayName: Webhook Issue Triage
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  owner: engineering
  start: ReadWebhookPayload
  states:
    - name: ReadWebhookPayload
      type: tool
      toolRef:
        name: github.issue.read
        version: "1.0.0"
      action: github.issue.read
      destination: github
      credentialRef: secret://integrations/github/app
      input:
        repository: "${trigger.repository}"
        issueNumber: "${trigger.issueNumber}"
      transition: AnalyzeIssue

    - name: AnalyzeIssue
      type: agent
      agentRef:
        name: issue-classifier
        version: "1"
      input:
        issue: "${states.ReadWebhookPayload.output}"
      output:
        type: object
        required: [labels, reply]
        properties:
          labels:
            type: array
            items:
              type: string
          reply:
            type: string
      transition: ApplyLabels

    - name: ApplyLabels
      type: tool
      toolRef:
        name: github.issue.label
        version: "1.0.0"
      action: github.issue.label
      destination: github
      credentialRef: secret://integrations/github/app
      input:
        repository: "${trigger.repository}"
        issueNumber: "${trigger.issueNumber}"
        labels: "${states.AnalyzeIssue.output.labels}"
      end: true
```

### Webhook Trigger Document
```yaml
apiVersion: tulipfarm.ai/v1
kind: Trigger
metadata:
  id: 66666666-6666-4666-8666-666666666666
  slug: github-issues-webhook
  displayName: GitHub Issues Webhook Trigger
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  type: webhook
  provider: github
  routineRef:
    name: webhook-issue-triage
    version: "1"
  eventType: github.issues.opened
  eventVersion: 1
  verification:
    method: hmac_sha256
    secretRef: secret://integrations/github/webhook-secret
    signatureHeader: X-Hub-Signature-256
  backgroundIdentity:
    principalKind: service
    principalId: routine-runner
  deduplication:
    key: "github-issue-${trigger.deliveryId}"
```

---

## 4. Interval Trigger Example

```yaml
apiVersion: tulipfarm.ai/v1
kind: Trigger
metadata:
  id: 77777777-7777-4777-8777-777777777777
  slug: sync-every-15m
  displayName: Sync Every 15 Minutes
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: published
spec:
  type: interval
  everyMs: 900000
  routineRef:
    name: daily-report
    version: "1"
  eventType: routine.interval
  eventVersion: 1
  backgroundIdentity:
    principalKind: service
    principalId: routine-runner
  deduplication:
    key: "daily-report-interval-${scheduledTime}"
  schedule:
    missedRunPolicy: skip
    overlapPolicy: skip
```

---

## 5. State Types Reference & Patterns

### `tool`
Calls an exposed or platform tool:
```yaml
name: SendNotification
type: tool
toolRef:
  name: send_slack_message
  version: "1"
action: send_slack_message
input:
  channel: "#general"
  text: "Routine completed."
end: true
```

### `agent`
Delegates structured reasoning to an Agent:
```yaml
name: TriageStep
type: agent
agentRef:
  name: triage-agent
  version: "1"
input:
  summary: "${states.FetchStep.output}"
output:
  type: object
  required: [priority]
  properties:
    priority:
      type: string
      enum: [low, medium, high]
transition: NextStep
```

### `branch`
Routes conditionally based on prior state output:
```yaml
name: CheckPriority
type: branch
conditions:
  - condition: "${states.TriageStep.output.priority} == 'high'"
    transition: EscalateImmediately
  - condition: "${states.TriageStep.output.priority} == 'medium'"
    transition: StandardNotification
default:
  transition: LogLowPriority
```

### `approval`
Gated human authorization step:
```yaml
name: AwaitApproval
type: approval
approverRoles:
  - ops-lead
  - admin
transition: DeployChanges
```

### `wait`
Durable timer or external event pause:
```yaml
name: DelayOneHour
type: wait
waitFor:
  kind: timer
  durationMs: 3600000
transition: NextCheck
```

### `foreach`
Fan-out across an array of items:
```yaml
name: ProcessBatch
type: foreach
items: "${states.FindRecords.output.items}"
body: ProcessSingleRecord
maxItems: 100
maxConcurrency: 5
transition: SummaryStep
```

### Error Handling & Retries
```yaml
name: ResilientStep
type: tool
toolRef:
  name: record_search
  version: "1"
action: record_search
input:
  type: ticket
retry:
  maxAttempts: 3
  backoffMs: 1000
  multiplier: 2
onError:
  - errorRef: RateLimitError
    transition: DelayAndRetry
  - errorRef: "*"
    end: true
transition: NextState
```

---

## 6. How to Invoke `routine_forge`

Pass the routine `name`, the canonical Routine as `definition`, and all Triggers in the `triggers` array:

```json
{
  "name": "daily-report",
  "definition": {
    "apiVersion": "tulipfarm.ai/v1",
    "kind": "Routine",
    "metadata": {
      "id": "11111111-1111-4111-8111-111111111111",
      "slug": "daily-report",
      "displayName": "Daily Report",
      "schemaVersion": 1,
      "authoredVersion": 1,
      "lifecycle": "published"
    },
    "spec": {
      "owner": "operations",
      "start": "RunReport",
      "states": [
        {
          "name": "RunReport",
          "type": "tool",
          "toolRef": { "name": "record_search", "version": "1" },
          "action": "record_search",
          "input": { "type": "report" },
          "end": true
        }
      ]
    }
  },
  "triggers": [
    {
      "apiVersion": "tulipfarm.ai/v1",
      "kind": "Trigger",
      "metadata": {
        "id": "22222222-2222-4222-8222-222222222222",
        "slug": "daily-report-manual",
        "displayName": "Manual Trigger",
        "schemaVersion": 1,
        "authoredVersion": 1,
        "lifecycle": "published"
      },
      "spec": {
        "type": "manual",
        "routineRef": { "name": "daily-report", "version": "1" },
        "eventType": "routine.manual",
        "eventVersion": 1,
        "backgroundIdentity": {
          "principalKind": "service",
          "principalId": "routine-runner"
        },
        "deduplication": {
          "key": "daily-report-manual"
        }
      }
    }
  ]
}
```
