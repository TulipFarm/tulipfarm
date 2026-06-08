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

# Native-lane pins (overridable). Release assets are published by the CI workflows
# .github/workflows/native-bundle.yml and native-app.yml.
GH_REPO="${TF_GH_REPO:-tulipfarm/tulipfarm}"
PG_BUNDLE_TAG="${TF_PG_BUNDLE_TAG:-native-bundle-v1}"   # tulipfarm-pg17-pgvector-<os>-<arch>.tar.gz
APP_TAG="${TF_APP_TAG:-native-app-v1}"                  # tulipfarm-app.tar.gz
NODE_VERSION="${TF_NODE_VERSION:-24.14.0}"
SERVICE_USER="${TF_SERVICE_USER:-tulipfarm}"            # macOS uses _tulipfarm (Apple convention)

# State set during detection — defaulted so set -u never trips on an unset path.
OS=""; ARCH=""; ENGINE=""; PKG=""; LANE=""; PUBLIC_URL=""; PUBLIC_IP_DETECTED=0

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

# URL-encode a string (for the unix-socket dir in the native lane's DATABASE_URL).
urlencode() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

# sha256 of a file, portable across coreutils (sha256sum) and macOS (shasum).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Download $1 (url) to $2, then verify against the .sha256 sidecar at $1.sha256.
download_verified() {
  local url="$1" dest="$2" want
  log "Downloading $(basename "$dest")…"
  $SUDO curl -fsSL "$url" -o "$dest" || die "download failed: $url"
  want="$(curl -fsSL "${url}.sha256" 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "$want" ]; then
    [ "$(sha256_of "$dest")" = "$want" ] || die "checksum mismatch for $(basename "$dest")"
  else
    warn "no .sha256 sidecar for $(basename "$dest") — skipping integrity check"
  fi
}

# Run a command as the service user (root drops privileges; non-root assumed = that user).
as_service_user() {
  if [ "$(id -u)" -eq 0 ]; then $SUDO -u "$SERVICE_USER" "$@"; else "$@"; fi
}

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
# Self-contained, socket-isolated stack under $INSTALL_DIR — never touches a system
# Postgres. Postgres listens on a unix socket only (listen_addresses=''), runs as a
# non-root service user, supervised by systemd (Linux) / launchd (macOS).
#
# NOTE: the relocatable PG17+pgvector bundle + app tarball are produced by CI
# (.github/workflows/native-bundle.yml, native-app.yml) and published as release
# assets. This path is exercised in CI / on real hosts, not in the dev sandbox.
NATIVE_RUNTIME() { printf '%s/runtime' "$INSTALL_DIR"; }
NATIVE_DATA()    { printf '%s/data'    "$INSTALL_DIR"; }
NATIVE_RUN()     { printf '%s/run'     "$INSTALL_DIR"; }
NATIVE_APP()     { printf '%s/app'     "$INSTALL_DIR"; }

require_native_tools() {
  local t
  for t in curl tar openssl; do
    command -v "$t" >/dev/null 2>&1 || die "native lane needs '${t}' on PATH"
  done
}

# Create the non-root service user Postgres + the app run as (PG refuses to run as root).
ensure_service_user() {
  if [ "$OS" = darwin ]; then
    SERVICE_USER="_tulipfarm"
    if ! dscl . -read "/Users/${SERVICE_USER}" >/dev/null 2>&1; then
      log "Creating macOS service user ${SERVICE_USER}…"
      local uid
      uid="$(dscl . -list /Users UniqueID | awk '{print $2}' | sort -n | awk '$1>=200 && $1<400{u=$1} END{print (u?u+1:250)}')"
      $SUDO dscl . -create "/Users/${SERVICE_USER}"
      $SUDO dscl . -create "/Users/${SERVICE_USER}" UserShell /usr/bin/false
      $SUDO dscl . -create "/Users/${SERVICE_USER}" UniqueID "$uid"
      $SUDO dscl . -create "/Users/${SERVICE_USER}" PrimaryGroupID 1
      $SUDO dscl . -create "/Users/${SERVICE_USER}" RealName "TulipFarm Service"
    fi
  else
    SERVICE_USER="tulipfarm"
    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
      log "Creating system service user ${SERVICE_USER}…"
      $SUDO useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
        || $SUDO adduser --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    fi
  fi
}

# Fetch + atomically install the relocatable PG17+pgvector bundle (skip if same revision).
fetch_pg_bundle() {
  local asset url tmp want_rev have_rev
  asset="tulipfarm-pg17-pgvector-${OS}-${ARCH}.tar.gz"
  url="https://github.com/${GH_REPO}/releases/download/${PG_BUNDLE_TAG}/${asset}"
  want_rev="$PG_BUNDLE_TAG"
  have_rev="$($SUDO cat "$(NATIVE_RUNTIME)/BUNDLE_REVISION" 2>/dev/null || true)"
  if [ "$have_rev" = "$want_rev" ]; then log "Postgres bundle ${want_rev} already installed"; return; fi
  tmp="$(mktemp -d)"
  download_verified "$url" "${tmp}/pg.tgz"
  $SUDO rm -rf "$(NATIVE_RUNTIME).new"
  $SUDO mkdir -p "$(NATIVE_RUNTIME).new"
  $SUDO tar -xzf "${tmp}/pg.tgz" -C "$(NATIVE_RUNTIME).new" --strip-components=0
  printf '%s\n' "$want_rev" | $SUDO tee "$(NATIVE_RUNTIME).new/BUNDLE_REVISION" >/dev/null
  # Preserve a sibling node/ install across bundle swaps.
  [ -d "$(NATIVE_RUNTIME)/node" ] && $SUDO mv "$(NATIVE_RUNTIME)/node" "$(NATIVE_RUNTIME).new/node"
  $SUDO rm -rf "$(NATIVE_RUNTIME)"
  $SUDO mv "$(NATIVE_RUNTIME).new" "$(NATIVE_RUNTIME)"
  rm -rf "$tmp"
}

# Fetch the pinned Node runtime from nodejs.org (verified against SHASUMS256.txt).
fetch_node() {
  local nodedir tarball url tmp want
  nodedir="$(NATIVE_RUNTIME)/node"
  if [ -x "${nodedir}/bin/node" ] && [ "$("${nodedir}/bin/node" -v 2>/dev/null)" = "v${NODE_VERSION}" ]; then
    log "Node v${NODE_VERSION} already installed"; return
  fi
  tarball="node-v${NODE_VERSION}-${OS}-${ARCH}.tar.gz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  tmp="$(mktemp -d)"
  $SUDO curl -fsSL "$url" -o "${tmp}/node.tgz" || die "node download failed: $url"
  want="$(curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" 2>/dev/null | awk -v f="$tarball" '$2==f{print $1}')"
  [ -n "$want" ] && { [ "$(sha256_of "${tmp}/node.tgz")" = "$want" ] || die "node checksum mismatch"; }
  $SUDO rm -rf "$nodedir"; $SUDO mkdir -p "$nodedir"
  $SUDO tar -xzf "${tmp}/node.tgz" -C "$nodedir" --strip-components=1
  rm -rf "$tmp"
}

# Fetch + atomically install the app payload (server.cjs + built SPA + prod
# node_modules). Per-(os,arch) because node_modules holds compiled native addons.
fetch_app() {
  local url tmp
  url="https://github.com/${GH_REPO}/releases/download/${APP_TAG}/tulipfarm-app-${OS}-${ARCH}.tar.gz"
  tmp="$(mktemp -d)"
  download_verified "$url" "${tmp}/app.tgz"
  $SUDO rm -rf "$(NATIVE_APP).new"; $SUDO mkdir -p "$(NATIVE_APP).new"
  $SUDO tar -xzf "${tmp}/app.tgz" -C "$(NATIVE_APP).new" --strip-components=0
  $SUDO rm -rf "$(NATIVE_APP)"; $SUDO mv "$(NATIVE_APP).new" "$(NATIVE_APP)"
  rm -rf "$tmp"
}

# Refuse to run an existing PGDATA against a different Postgres major version
# (INST-010 fail-loud — never auto-pg_upgrade, never risk corruption).
guard_pg_major() {
  $SUDO test -f "$(NATIVE_DATA)/PG_VERSION" || return 0
  local data_major bundle_major
  data_major="$($SUDO cat "$(NATIVE_DATA)/PG_VERSION")"
  bundle_major="$("$(NATIVE_RUNTIME)/bin/postgres" --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  if [ -n "$bundle_major" ] && [ "$data_major" != "$bundle_major" ]; then
    die "PGDATA is PostgreSQL ${data_major} but the bundle is ${bundle_major}.
A major-version upgrade is required and is NOT done automatically. Back up first:
  ${INSTALL_DIR}/runtime/bin/pg_dumpall -h ${INSTALL_DIR}/run > backup.sql
then re-init with the new bundle and restore. (Set TF_PG_MAJOR_UPGRADE=1 once a
guided helper ships.)"
  fi
}

# initdb once; configure socket-only listening. Never re-init existing PGDATA.
init_pgdata() {
  if $SUDO test -f "$(NATIVE_DATA)/PG_VERSION"; then
    log "Existing PGDATA — keeping it (update mode)"
    return
  fi
  log "Initializing the database cluster…"
  as_service_user "$(NATIVE_RUNTIME)/bin/initdb" -D "$(NATIVE_DATA)" -U "$SERVICE_USER" \
    --auth-local=trust --auth-host=reject --encoding=UTF8 >/dev/null
  $SUDO tee -a "$(NATIVE_DATA)/postgresql.conf" >/dev/null <<EOF

# TulipFarm: socket-only, isolated from any system Postgres.
listen_addresses = ''
unix_socket_directories = '$(NATIVE_RUN)'
EOF
}

write_env_native() {
  if $SUDO test -f "${INSTALL_DIR}/.env"; then
    log "Existing .env found — preserving secrets (update mode)"; return
  fi
  detect_public_url
  local sockenc; sockenc="$(urlencode "$(NATIVE_RUN)")"
  log "Generating secrets + .env (PUBLIC_URL=${PUBLIC_URL})"
  $SUDO tee "${INSTALL_DIR}/.env" >/dev/null <<EOF
PUBLIC_URL=${PUBLIC_URL}
PORT=${PORT}
DATABASE_URL=postgresql://${SERVICE_USER}@/${SERVICE_USER}?host=${sockenc}
ENCRYPTION_KEY=$(gen_secret)
JWT_SECRET=$(gen_secret)
WEBHOOK_SIGNING_SECRET=$(gen_secret)
SOUL_PATH=${INSTALL_DIR}/soul
WEB_DIST=$(NATIVE_APP)/apps/web/build/client
NODE_ENV=production
SETUP_MODE=wizard
EOF
  $SUDO chmod 600 "${INSTALL_DIR}/.env"
  # The app must create the app database on first boot if absent.
  as_service_user "$(NATIVE_RUNTIME)/bin/createdb" -h "$(NATIVE_RUN)" "$SERVICE_USER" 2>/dev/null || true
}

# An env-loading wrapper so systemd and launchd share one start mechanism.
write_app_wrapper() {
  $SUDO tee "$(NATIVE_APP)/run-app.sh" >/dev/null <<EOF
#!/usr/bin/env bash
set -a; . "${INSTALL_DIR}/.env"; set +a
exec "$(NATIVE_RUNTIME)/node/bin/node" "$(NATIVE_APP)/server.cjs"
EOF
  $SUDO chmod +x "$(NATIVE_APP)/run-app.sh"
}

chown_tree() {
  $SUDO chown -R "$SERVICE_USER" "$(NATIVE_DATA)" "$(NATIVE_RUN)" "$INSTALL_DIR/soul" 2>/dev/null || true
}

install_supervisors_linux() {
  log "Installing systemd units…"
  $SUDO tee /etc/systemd/system/tulipfarm-postgres.service >/dev/null <<EOF
[Unit]
Description=TulipFarm PostgreSQL
After=network.target
[Service]
User=${SERVICE_USER}
ExecStart=$(NATIVE_RUNTIME)/bin/postgres -D $(NATIVE_DATA)
Restart=always
RuntimeDirectory=tulipfarm
[Install]
WantedBy=multi-user.target
EOF
  $SUDO tee /etc/systemd/system/tulipfarm-app.service >/dev/null <<EOF
[Unit]
Description=TulipFarm App
After=tulipfarm-postgres.service
Requires=tulipfarm-postgres.service
[Service]
User=${SERVICE_USER}
ExecStartPre=$(NATIVE_RUNTIME)/bin/pg_isready -h $(NATIVE_RUN) -t 30
ExecStart=$(NATIVE_APP)/run-app.sh
Restart=always
[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now tulipfarm-postgres.service
  $SUDO systemctl enable --now tulipfarm-app.service
}

install_supervisors_macos() {
  log "Installing launchd daemons…"
  $SUDO tee /Library/LaunchDaemons/sh.tulipfarm.postgres.plist >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>sh.tulipfarm.postgres</string>
  <key>UserName</key><string>${SERVICE_USER}</string>
  <key>ProgramArguments</key>
  <array><string>$(NATIVE_RUNTIME)/bin/postgres</string><string>-D</string><string>$(NATIVE_DATA)</string></array>
  <key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
</dict></plist>
EOF
  $SUDO tee /Library/LaunchDaemons/sh.tulipfarm.app.plist >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>sh.tulipfarm.app</string>
  <key>UserName</key><string>${SERVICE_USER}</string>
  <key>ProgramArguments</key><array><string>$(NATIVE_APP)/run-app.sh</string></array>
  <key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
</dict></plist>
EOF
  $SUDO launchctl bootout system/sh.tulipfarm.postgres 2>/dev/null || true
  $SUDO launchctl bootout system/sh.tulipfarm.app 2>/dev/null || true
  $SUDO launchctl bootstrap system /Library/LaunchDaemons/sh.tulipfarm.postgres.plist
  $SUDO launchctl bootstrap system /Library/LaunchDaemons/sh.tulipfarm.app.plist
}

run_native_lane() {
  require_native_tools
  $SUDO mkdir -p "$INSTALL_DIR" "$(NATIVE_RUN)" "$INSTALL_DIR/soul"
  ensure_service_user
  fetch_pg_bundle
  fetch_node
  fetch_app
  guard_pg_major
  init_pgdata
  write_env_native
  write_app_wrapper
  chown_tree
  if [ "$OS" = darwin ]; then install_supervisors_macos; else install_supervisors_linux; fi
  wait_health
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
  if [ -n "${ENGINE:-}" ]; then
    ( cd "${INSTALL_DIR}" && $SUDO ${ENGINE} compose logs --tail 40 app ) || true
  elif [ "$OS" = darwin ]; then
    warn "Inspect: sudo launchctl print system/sh.tulipfarm.app"
  else
    $SUDO journalctl -u tulipfarm-app.service --no-pager -n 40 2>/dev/null || true
  fi
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
