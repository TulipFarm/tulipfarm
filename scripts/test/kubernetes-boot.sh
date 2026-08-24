#!/usr/bin/env bash
# End-to-end boot check for the Kubernetes target.
#
# STATUS: community. This caller is written and syntax-checked, but it has NOT yet been run to a
# green result in CI, so the `kubernetes` target stays `tier: community`. Promoting it to
# `supported` means wiring this into `.github/workflows/container.yml` behind a `kind` cluster and
# proving it reaches `/readyz` — see the design contract, §7.2 check 5. Until then, do not mark the
# target supported: `deploy/deploy.txt` derives its "verified targets" list from the tier, and a
# supported target that was never booted makes that list lie.
#
# It reuses the shared boot harness exactly as compose-parity.sh does: it overrides log capture and
# teardown with Kubernetes commands, then polls the same HTTP readiness probe. There is no official
# chart yet, so the workloads below are minimal raw manifests grounded in deploy/contract.yml — the
# same ports, health paths, and durable state the generated values.yaml describes.
#
# Env:
#   TF_PORT=<port>   local port to bind the app port-forward (default: 8099)
#   KIND_CLUSTER=<name>  kind cluster name (default: tulipfarm-boot-$$)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOOT_LABEL="k8s"
# shellcheck source=scripts/test/lib/boot-harness.sh
. "${REPO_ROOT}/scripts/test/lib/boot-harness.sh"

IMAGE="ghcr.io/tulipfarm/tulipfarm:ci"
PORT="${TF_PORT:-8099}"
CLUSTER="${KIND_CLUSTER:-tulipfarm-boot-$$}"
NAMESPACE="tulipfarm"
PF_PID=""

# The Kubernetes half the harness delegates: reach for logs and tear down only what was created.
boot_capture_logs() {
  kubectl --context "kind-${CLUSTER}" -n "$NAMESPACE" get pods -o wide 2>/dev/null || true
  kubectl --context "kind-${CLUSTER}" -n "$NAMESPACE" logs -l app=app --tail=200 2>/dev/null || true
}
boot_teardown() {
  [ -n "$PF_PID" ] && kill "$PF_PID" >/dev/null 2>&1 || true
  kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
}

boot_make_workspace
boot_install_cleanup_trap

require_command kubectl
require_command kind
require_command curl
require_command openssl

log "creating kind cluster ${CLUSTER}…"
kind create cluster --name "$CLUSTER" --wait 120s
kubectl config use-context "kind-${CLUSTER}"

log "loading ${IMAGE} into the cluster…"
kind load docker-image "$IMAGE" --name "$CLUSTER"

log "applying namespace and instance secrets…"
kubectl create namespace "$NAMESPACE"
kubectl -n "$NAMESPACE" create secret generic tulipfarm-secrets \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=JWT_SECRET="$(openssl rand -base64 32)" \
  --from-literal=WEBHOOK_SIGNING_SECRET="$(openssl rand -base64 32)"

log "applying PostgreSQL 17 (pgvector), the three workloads, and their Services…"
kubectl -n "$NAMESPACE" apply -f - <<'YAML'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: tulipfarm-data
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: tulipfarm-soul
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: pgvector/pgvector:pg17
          env:
            - { name: POSTGRES_PASSWORD, value: tulipfarm }
            - { name: POSTGRES_DB, value: tulipfarm }
          ports: [{ containerPort: 5432 }]
          readinessProbe:
            exec: { command: ["pg_isready", "-U", "postgres"] }
            initialDelaySeconds: 5
---
apiVersion: v1
kind: Service
metadata: { name: postgres }
spec:
  selector: { app: postgres }
  ports: [{ port: 5432, targetPort: 5432 }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: app } }
  template:
    metadata: { labels: { app: app } }
    spec:
      securityContext: { fsGroup: 1000 }
      containers:
        - name: app
          image: ghcr.io/tulipfarm/tulipfarm:ci
          env:
            - { name: NODE_ENV, value: production }
            - { name: PORT, value: "8080" }
            - { name: PUBLIC_URL, value: http://localhost:8099 }
            - { name: SOUL_PATH, value: /opt/tulipfarm/soul }
            - { name: TF_DATA_DIR, value: /data }
            - { name: DATABASE_URL, value: postgresql://postgres:tulipfarm@postgres:5432/tulipfarm }
            - { name: ENCRYPTION_KEY, valueFrom: { secretKeyRef: { name: tulipfarm-secrets, key: ENCRYPTION_KEY } } }
            - { name: JWT_SECRET, valueFrom: { secretKeyRef: { name: tulipfarm-secrets, key: JWT_SECRET } } }
            - { name: WEBHOOK_SIGNING_SECRET, valueFrom: { secretKeyRef: { name: tulipfarm-secrets, key: WEBHOOK_SIGNING_SECRET } } }
          ports: [{ containerPort: 8080 }]
          startupProbe:
            httpGet: { path: /readyz, port: 8080 }
            failureThreshold: 60
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /livez, port: 8080 }
          readinessProbe:
            httpGet: { path: /readyz, port: 8080 }
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: soul, mountPath: /opt/tulipfarm/soul }
      volumes:
        - { name: data, persistentVolumeClaim: { claimName: tulipfarm-data } }
        - { name: soul, persistentVolumeClaim: { claimName: tulipfarm-soul } }
---
apiVersion: v1
kind: Service
metadata: { name: app }
spec:
  selector: { app: app }
  ports: [{ port: 8080, targetPort: 8080 }]
YAML

log "waiting for the app rollout…"
kubectl -n "$NAMESPACE" rollout status deployment/app --timeout=600s

log "port-forwarding the app Service to :${PORT}…"
kubectl -n "$NAMESPACE" port-forward svc/app "${PORT}:8080" >/dev/null 2>&1 &
PF_PID=$!

log "asserting /readyz and /livez on :${PORT}…"
boot_wait_for_http "http://localhost:${PORT}/readyz"
boot_check_http "http://localhost:${PORT}/livez"

log "PASS — the Kubernetes workloads booted and report ready"
