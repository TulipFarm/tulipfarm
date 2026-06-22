#!/usr/bin/env bash
# TulipFarm one-line installer — OCI lane (Docker/Podman + Compose v2).
# Spec: specs/INSTALLATION.md INST-002/003, AC-001. Native lane is deferred.
#
#   curl -fsSL https://raw.githubusercontent.com/TulipFarm/tulipfarm/main/scripts/get.tulipfarm.sh | sudo bash
#
# Detects/installs a container engine, fetches docker-compose.yml + .env.example,
# generates bootstrap secrets (zero questions), brings the 2-service stack up, polls
# /health, and prints the setup-wizard URL. Re-running = update (preserves .env, PGDATA).
#
# Overrides (env):
#   TF_BASE_URL   raw base URL for fetched files (default: GitHub raw; later get.tulipfarm.site)
#   TF_REF        git ref under TF_BASE_URL (default: main)
#   TF_VERSION    app image tag → TULIPFARM_VERSION (default: latest)
#   TF_INSTALL_DIR install dir (default: /opt/tulipfarm)
#   TF_PORT / HOST_PORT  host port to publish (default: 8080)
#   TF_RUNTIME    force engine: docker | podman
#   TF_LOCAL_SRC  copy compose/.env.example from a local repo instead of curl (testing)
set -euo pipefail

# ---- config (all overridable) ------------------------------------------------
TF_BASE_URL="${TF_BASE_URL:-https://raw.githubusercontent.com/TulipFarm/tulipfarm}"
TF_REF="${TF_REF:-main}"
TF_VERSION="${TF_VERSION:-latest}"
INSTALL_DIR="${TF_INSTALL_DIR:-/opt/tulipfarm}"
PORT="${TF_PORT:-${HOST_PORT:-8080}}"
TF_RUNTIME="${TF_RUNTIME:-}"
TF_LOCAL_SRC="${TF_LOCAL_SRC:-}"

# ---- logging -----------------------------------------------------------------
log()  { printf '\033[0;32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m⚠\033[0m  %s\n' "$*"; }
die()  { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

# ---- privilege ---------------------------------------------------------------
SUDO=""
detect_sudo() {
  # No privilege needed when the install dir (or its parent) is already writable.
  local probe="$INSTALL_DIR"
  [ -d "$probe" ] || probe="$(dirname "$probe")"
  if [ -w "$probe" ]; then SUDO=""; return; fi
  [ "$(id -u)" -eq 0 ] && { SUDO=""; return; }
  command -v sudo >/dev/null 2>&1 && { SUDO="sudo"; return; }
  die "need root or sudo to write ${INSTALL_DIR} — re-run with sudo"
}

# ---- detection ---------------------------------------------------------------
OS=""
detect_os() {
  case "$(uname -s)" in
    Linux)  OS=linux ;;
    Darwin) OS=darwin ;;
    *) die "unsupported OS: $(uname -s) — on Windows run inside WSL2 (see scripts/install.ps1)" ;;
  esac
}

ENGINE=""
has_engine() { command -v "$1" >/dev/null 2>&1 && "$1" compose version >/dev/null 2>&1; }
detect_engine() {
  if [ -n "$TF_RUNTIME" ]; then
    has_engine "$TF_RUNTIME" || die "TF_RUNTIME=${TF_RUNTIME} but '${TF_RUNTIME} compose' is unavailable"
    ENGINE="$TF_RUNTIME"; return
  fi
  if has_engine docker; then ENGINE=docker; return; fi
  if has_engine podman; then ENGINE=podman; return; fi
  ENGINE=""
}

detect_pkg_mgr() {
  local m
  for m in apt-get dnf zypper pacman apk; do
    command -v "$m" >/dev/null 2>&1 && { echo "$m"; return; }
  done
  echo ""
}

install_podman_linux() {
  local pkg; pkg="$(detect_pkg_mgr)"
  [ -n "$pkg" ] || die "no supported package manager (apt/dnf/zypper/pacman/apk) — install Docker or Podman manually, then re-run"
  log "No container engine found — installing Podman via ${pkg}…"
  case "$pkg" in
    apt-get) $SUDO apt-get update -y && $SUDO apt-get install -y podman podman-compose ;;
    dnf)     $SUDO dnf install -y podman podman-compose ;;
    zypper)  $SUDO zypper --non-interactive install podman podman-compose ;;
    pacman)  $SUDO pacman -Sy --noconfirm podman podman-compose ;;
    apk)     $SUDO apk add podman podman-compose ;;
  esac
  has_engine podman || die "Podman install did not yield a working 'podman compose'"
  ENGINE=podman
}

ensure_engine() {
  detect_engine
  if [ -z "$ENGINE" ]; then
    if [ "$OS" = linux ]; then
      install_podman_linux
    else
      die "no container engine found — on macOS install Docker Desktop or Podman, then re-run (the native lane is not yet available)"
    fi
  fi
  log "Using container engine: ${ENGINE}"
}

# ---- file acquisition --------------------------------------------------------
fetch_file() {
  local rel="$1" dest="$2"
  if [ -n "$TF_LOCAL_SRC" ]; then
    $SUDO cp "${TF_LOCAL_SRC}/${rel}" "$dest"
  else
    $SUDO curl -fsSL "${TF_BASE_URL}/${TF_REF}/${rel}" -o "$dest"
  fi
}

# ---- secrets + .env ----------------------------------------------------------
gen_secret() { openssl rand -base64 32; }
# URL-safe (no /+= so it embeds in DATABASE_URL without escaping).
gen_pw()     { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32; }

PUBLIC_URL=""
PUBLIC_IP_DETECTED=0
detect_public_url() {
  local ip="" iface
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')" || true
  fi
  if [ -z "$ip" ] && command -v route >/dev/null 2>&1; then  # macOS
    iface="$(route -n get 1.1.1.1 2>/dev/null | awk '/interface:/{print $2}')" || true
    [ -n "$iface" ] && ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  fi
  if [ -n "$ip" ] && [ "$ip" != "127.0.0.1" ]; then
    PUBLIC_URL="http://${ip}:${PORT}"; PUBLIC_IP_DETECTED=1
  else
    PUBLIC_URL="http://localhost:${PORT}"; PUBLIC_IP_DETECTED=0
  fi
}

write_env() {
  # Update mode: a real prior install has BOTH .env and .lane. Preserve secrets/PGDATA.
  if $SUDO test -f "${INSTALL_DIR}/.env" && $SUDO test -f "${INSTALL_DIR}/.lane"; then
    log "Existing install found — preserving .env (update mode)"
    return
  fi
  need openssl
  detect_public_url
  # Generate into vars first so `set -e` catches a failed openssl (a failure inside the
  # heredoc would be masked by tee's exit status).
  local pw enc jwt webhook
  pw="$(gen_pw)"; enc="$(gen_secret)"; jwt="$(gen_secret)"; webhook="$(gen_secret)"
  log "Generating secrets + .env (PUBLIC_URL=${PUBLIC_URL})"
  # Create mode-600 BEFORE writing so secrets are never briefly world-readable.
  $SUDO install -m 600 /dev/null "${INSTALL_DIR}/.env"
  $SUDO tee "${INSTALL_DIR}/.env" >/dev/null <<EOF
PUBLIC_URL=${PUBLIC_URL}
CORS_ORIGIN=${PUBLIC_URL}
HOST_PORT=${PORT}
TULIPFARM_VERSION=${TF_VERSION}
COMPOSE_PROFILES=bundled
EXTERNAL_DATASTORE=false
POSTGRES_PASSWORD=${pw}
DATABASE_URL=postgresql://tulipfarm:${pw}@postgres:5432/tulipfarm
ENCRYPTION_KEY=${enc}
JWT_SECRET=${jwt}
WEBHOOK_SIGNING_SECRET=${webhook}
SETUP_MODE=wizard
EOF
}

# Authoritative PORT (health poll) + PUBLIC_URL (final message) read back from .env —
# correct in both fresh and update (preserved-.env) modes.
load_runtime_info() {
  local p u
  p="$($SUDO grep -E '^HOST_PORT=' "${INSTALL_DIR}/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  u="$($SUDO grep -E '^PUBLIC_URL=' "${INSTALL_DIR}/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  [ -n "$p" ] && PORT="$p"
  [ -n "$u" ] && PUBLIC_URL="$u"
}

# ---- compose -----------------------------------------------------------------
# shellcheck disable=SC2086  # $SUDO may be empty and $ENGINE is a bare word — both must split
compose() { ( cd "$INSTALL_DIR" && $SUDO $ENGINE compose "$@" ); }

bring_up() {
  log "Pulling images and starting the stack…"
  compose pull || warn "image pull failed (rate limit / unpublished tag) — trying cached images"
  compose up -d || die "compose up failed — see logs above"
}

wait_health() {
  log "Waiting for TulipFarm to become healthy…"
  local _
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
      log "TulipFarm is up."
      if [ "$PUBLIC_IP_DETECTED" = "1" ]; then
        warn "Reachable on a public IP over HTTP with no TLS — complete setup NOW"
        warn "(the first visitor becomes admin) and put a reverse proxy in front for production."
      fi
      log "Open ${PUBLIC_URL} to finish setup (create the first admin)."
      return 0
    fi
    sleep 3
  done
  warn "Health check timed out. Recent logs:"
  compose logs --tail 40 app || true
  die "TulipFarm did not become healthy — see logs above."
}

# ---- main --------------------------------------------------------------------
main() {
  need curl
  detect_os
  detect_sudo
  ensure_engine
  $SUDO mkdir -p "$INSTALL_DIR"
  fetch_file docker-compose.yml "${INSTALL_DIR}/docker-compose.yml"
  fetch_file .env.example "${INSTALL_DIR}/.env.example" || true
  write_env
  printf 'oci\n' | $SUDO tee "${INSTALL_DIR}/.lane" >/dev/null
  load_runtime_info
  bring_up
  wait_health
}

main "$@"
