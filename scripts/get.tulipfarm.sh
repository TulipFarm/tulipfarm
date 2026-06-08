#!/usr/bin/env bash
# TulipFarm one-line installer.
#   curl -fsSL https://get.tulipfarm.sh | sudo bash
#
# One OS-branched script (INST-002/INST-002b). Re-running updates in place
# (preserves .env + the chosen lane). Self-contained so it works when piped to
# bash with no local files.
#
#   Linux : detect docker/podman -> OCI. If none -> install Podman -> OCI.
#   macOS : detect docker/podman -> OCI. If none -> prompt (Podman | Native);
#           no TTY -> Native. Override anywhere with TF_RUNTIME=podman|native.
set -euo pipefail

INSTALL_DIR="${TF_INSTALL_DIR:-/opt/tulipfarm}"
BASE_URL="${TF_BASE_URL:-https://raw.githubusercontent.com/tulipfarm/tulipfarm/main}"
PORT="${TF_PORT:-8080}"

# ─────────────────────────────── common helpers ───────────────────────────────
log()  { printf '\033[0;32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m⚠\033[0m  %s\n' "$*"; }
die()  { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=""
detect_sudo() {
  [ "$(id -u)" -eq 0 ] && { SUDO=""; return; }
  command -v sudo >/dev/null 2>&1 && { SUDO="sudo"; return; }
  die "need root or sudo to write ${INSTALL_DIR}"
}

gen_secret() { openssl rand -base64 32; }
gen_pw()     { openssl rand -hex 16; }

# Fetch a repo file into place — from a local checkout (TF_LOCAL_SRC, for dev/CI)
# or via curl from BASE_URL (the curl|bash path).
fetch_file() {
  local rel="$1" dest="$2"
  if [ -n "${TF_LOCAL_SRC:-}" ]; then
    $SUDO cp "${TF_LOCAL_SRC}/${rel}" "$dest"
  else
    $SUDO curl -fsSL "${BASE_URL}/${rel}" -o "$dest"
  fi
}

# ──────────────────────────────── detection ───────────────────────────────────
detect_os_arch() {
  case "$(uname -s)" in
    Linux)  OS=linux ;;
    Darwin) OS=darwin ;;
    *) die "unsupported OS: $(uname -s) — on Windows run this inside WSL2" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

# ENGINE = docker | podman | "" — a container engine with a working compose subcommand.
detect_engine() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ENGINE=docker
  elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    ENGINE=podman
  else
    ENGINE=""
  fi
}

# PKG = apt-get|dnf|zypper|pacman|apk|"" — the host package manager.
detect_pkg_mgr() {
  local m
  for m in apt-get dnf zypper pacman apk; do
    command -v "$m" >/dev/null 2>&1 && { PKG="$m"; return; }
  done
  PKG=""
}

# True when an interactive terminal is reachable (curl|bash leaves stdin as the
# script, so we probe /dev/tty directly rather than [ -t 0 ]).
have_tty() {
  [ -e /dev/tty ] || return 1
  { true </dev/tty; } 2>/dev/null
}

# PUBLIC_URL + PUBLIC_IP_DETECTED from the host's default-route IP (loopback->localhost).
detect_public_url() {
  local ip="" iface
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null \
      | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')" || true
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

# ───────────────────────────── lane selection ─────────────────────────────────
prompt_mac_lane() {
  {
    printf '\nNo container runtime found. How should TulipFarm run?\n'
    printf '  [1] Podman  — containers (installs Podman; needs a Linux VM on macOS)\n'
    printf '  [2] Native  — isolated binaries, no VM (recommended on macOS)\n'
    printf 'Choose [1/2] (default 2): '
  } >/dev/tty
  local choice=""
  read -r choice </dev/tty || choice=""
  case "$choice" in
    1) LANE=oci ;;
    *) LANE=native ;;
  esac
}

select_lane() {
  # 1. Update path: stick with the remembered lane, never re-prompt.
  if $SUDO test -f "${INSTALL_DIR}/.lane"; then
    LANE="$($SUDO cat "${INSTALL_DIR}/.lane")"
    log "Updating existing install (${LANE} lane)"
    return
  fi
  # 2. Explicit override.
  if [ -n "${TF_RUNTIME:-}" ]; then
    case "$TF_RUNTIME" in
      docker|podman|oci) LANE=oci ;;
      native)            LANE=native ;;
      *) die "unknown TF_RUNTIME='${TF_RUNTIME}' (expected docker|podman|native)" ;;
    esac
    return
  fi
  # 3. Auto-select.
  detect_engine
  if [ -n "$ENGINE" ]; then LANE=oci; return; fi
  if [ "$OS" = linux ]; then LANE=oci; return; fi   # Linux: auto-install Podman in the OCI lane
  # macOS, no engine present:
  if have_tty; then
    prompt_mac_lane
  else
    LANE=native
    log "No container runtime and no interactive terminal — defaulting to the native lane."
  fi
}

# ─────────────────────────────── OCI lane ─────────────────────────────────────
install_podman_linux() {
  detect_pkg_mgr
  [ -n "$PKG" ] || die "no supported package manager (apt/dnf/zypper/pacman/apk) — install Docker or Podman manually"
  log "No container engine found — installing Podman via ${PKG}…"
  case "$PKG" in
    apt-get) $SUDO apt-get update -y && $SUDO apt-get install -y podman podman-compose ;;
    dnf)     $SUDO dnf install -y podman podman-compose ;;
    zypper)  $SUDO zypper --non-interactive install podman podman-compose ;;
    pacman)  $SUDO pacman -Sy --noconfirm podman podman-compose ;;
    apk)     $SUDO apk add podman podman-compose ;;
  esac
}

ensure_engine() {
  detect_engine
  [ -n "$ENGINE" ] && return
  [ "$OS" = linux ] || die "no container engine on macOS — choose the native lane or install Podman/Docker"
  install_podman_linux
  detect_engine
  [ -n "$ENGINE" ] || die "could not provision a working container engine + compose"
}

write_env_oci() {
  if $SUDO test -f "${INSTALL_DIR}/.env"; then
    log "Existing .env found — preserving secrets (update mode)"
    return
  fi
  detect_public_url
  log "Generating secrets + .env (PUBLIC_URL=${PUBLIC_URL})"
  $SUDO tee "${INSTALL_DIR}/.env" >/dev/null <<EOF
PUBLIC_URL=${PUBLIC_URL}
HOST_PORT=${PORT}
POSTGRES_PASSWORD=$(gen_pw)
ENCRYPTION_KEY=$(gen_secret)
JWT_SECRET=$(gen_secret)
WEBHOOK_SIGNING_SECRET=$(gen_secret)
SETUP_MODE=wizard
EOF
  $SUDO chmod 600 "${INSTALL_DIR}/.env"
}

run_oci_lane() {
  ensure_engine
  log "Using container engine: ${ENGINE}"
  local COMPOSE="${ENGINE} compose"
  $SUDO mkdir -p "${INSTALL_DIR}"
  fetch_file docker-compose.yml "${INSTALL_DIR}/docker-compose.yml"
  fetch_file .env.example "${INSTALL_DIR}/.env.example" || true
  write_env_oci
  log "Pulling images and starting the stack…"
  ( cd "${INSTALL_DIR}" && $SUDO $COMPOSE pull 2>/dev/null || true )
  ( cd "${INSTALL_DIR}" && $SUDO $COMPOSE up -d ) || die "compose up failed"
  wait_health
}

# ────────────────────────────── native lane ───────────────────────────────────
run_native_lane() {
  # Implemented in a later release (relocatable PG17+pgvector bundle, socket
  # isolation, launchd/systemd). Until then, fail with a clear pointer.
  die "The native lane is not available in this build yet.
Use a container engine instead:
  • Linux: re-run — Podman is installed automatically.
  • macOS: install Docker Desktop or Podman, then re-run, or set TF_RUNTIME=podman."
}

# ────────────────────────────── health wait ───────────────────────────────────
wait_health() {
  local host_port url
  host_port="$($SUDO grep -E '^HOST_PORT=' "${INSTALL_DIR}/.env" 2>/dev/null | cut -d= -f2- || echo "${PORT}")"
  url="$($SUDO grep -E '^PUBLIC_URL=' "${INSTALL_DIR}/.env" 2>/dev/null | cut -d= -f2- || echo "http://localhost:${PORT}")"
  log "Waiting for TulipFarm to become healthy…"
  local _
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:${host_port}/health" >/dev/null 2>&1; then
      log "TulipFarm is up: ${url}"
      if [ "${PUBLIC_IP_DETECTED:-0}" = "1" ]; then
        warn "Reachable on a public IP over HTTP with no TLS — complete setup NOW"
        warn "(the first visitor becomes admin) and put a reverse proxy in front for production."
      fi
      log "Open ${url}/setup to finish setup."
      return 0
    fi
    sleep 3
  done
  warn "Health check timed out. Recent logs:"
  ( cd "${INSTALL_DIR}" && $SUDO ${ENGINE} compose logs --tail 40 app ) || true
  die "TulipFarm did not become healthy — see logs above."
}

# ──────────────────────────────────── main ────────────────────────────────────
main() {
  detect_sudo
  detect_os_arch
  log "TulipFarm installer — ${OS}/${ARCH}, install dir ${INSTALL_DIR}"
  select_lane
  case "$LANE" in
    oci)    run_oci_lane ;;
    native) run_native_lane ;;
    *)      die "internal: unknown lane '${LANE}'" ;;
  esac
  # Remember the lane only after a successful first install.
  $SUDO mkdir -p "${INSTALL_DIR}"
  printf '%s\n' "$LANE" | $SUDO tee "${INSTALL_DIR}/.lane" >/dev/null
}

main "$@"
