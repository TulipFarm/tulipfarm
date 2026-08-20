#!/usr/bin/env bash
# TulipFarm production uninstaller for one-line and Compose installations.
#
#   curl -fsSL https://tulipfarm.site/uninstall.sh | bash
#
# Permanently removes the TulipFarm Compose project, its named volumes (Postgres,
# Soul, generated secrets, backups, and stored files), locally cached TulipFarm application
# images, and the installer-managed directory. Docker/Podman itself and external
# datastores are never removed.
#
# Overrides:
#   TF_INSTALL_DIR   installer directory (default: /opt/tulipfarm)
#   TF_RUNTIME       restrict cleanup to docker or podman (default: inspect both)
#   TF_PROJECT_NAME  Compose project name (default: marker value, then tulipfarm)
#
# Non-interactive use:
#   curl -fsSL https://tulipfarm.site/uninstall.sh | bash -s -- --yes
set -uo pipefail

INSTALL_DIR="${TF_INSTALL_DIR:-/opt/tulipfarm}"
RUNTIME_OVERRIDE="${TF_RUNTIME:-}"
PROJECT_OVERRIDE="${TF_PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-}}"
PROJECT_NAME=""
ASSUME_YES=false
TTY_INPUT="${TF_TTY_INPUT:-/dev/tty}"
TTY_OUTPUT="${TF_TTY_OUTPUT:-/dev/tty}"
FS_SUDO=""
ERRORS=0
RUNTIMES_CLEANED=0
PROJECT_IMAGE_IDS=()

log() { printf '\033[0;32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m⚠\033[0m  %s\n' "$*" >&2; }
fail() {
  printf '\033[0;31m✗\033[0m %s\n' "$*" >&2
  ERRORS=$((ERRORS + 1))
}
die() {
  printf '\033[0;31m✗\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    "TulipFarm production uninstaller" \
    "" \
    "Usage:" \
    "  uninstall.sh [--yes]" \
    "" \
    "Options:" \
    "  -y, --yes   skip the typed confirmation (destructive)" \
    "  -h, --help  show this help"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -y | --yes) ASSUME_YES=true ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown option: $1 (use --help for usage)" ;;
    esac
    shift
  done
}

ensure_privilege_helper() {
  if [ "$(id -u)" -eq 0 ]; then
    FS_SUDO=""
    return
  fi
  if [ -e "$INSTALL_DIR" ] && [ -w "$INSTALL_DIR" ]; then
    FS_SUDO=""
    return
  fi
  if [ ! -e "$INSTALL_DIR" ] && [ -w "$(dirname "$INSTALL_DIR")" ]; then
    FS_SUDO=""
    return
  fi
  command -v sudo >/dev/null 2>&1 \
    || die "need root or sudo to remove ${INSTALL_DIR}"
  FS_SUDO="sudo"
}

fs() {
  if [ -n "$FS_SUDO" ]; then
    "$FS_SUDO" "$@"
  else
    "$@"
  fi
}

read_marker_value() {
  local key="$1" marker="${INSTALL_DIR}/.tulipfarm-install"
  [ -f "$marker" ] || return 0
  fs grep -E "^${key}=" "$marker" 2>/dev/null | head -1 | cut -d= -f2- || true
}

resolve_project_name() {
  local marked
  marked="$(read_marker_value compose-project)"
  PROJECT_NAME="${PROJECT_OVERRIDE:-${marked:-tulipfarm}}"
  [[ "$PROJECT_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] \
    || die "unsafe Compose project name: ${PROJECT_NAME}"
}

validate_install_dir() {
  local original="$INSTALL_DIR"
  [ -n "$INSTALL_DIR" ] || die "refusing an empty TF_INSTALL_DIR"
  case "$INSTALL_DIR" in
    /*) ;;
    *) INSTALL_DIR="${PWD}/${INSTALL_DIR}" ;;
  esac

  [ ! -L "$INSTALL_DIR" ] \
    || die "refusing to recursively remove symlinked install directory: ${original}"

  if [ -d "$INSTALL_DIR" ]; then
    INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)" \
      || die "cannot resolve install directory: ${original}"
  fi

  case "$INSTALL_DIR" in
    / | /bin | /etc | /home | /opt | /root | /sbin | /tmp | /usr | /var | "$HOME")
      die "refusing unsafe install directory: ${INSTALL_DIR}"
      ;;
  esac
}

is_managed_install_dir() {
  local marker="${INSTALL_DIR}/.tulipfarm-install"
  local compose_file="${INSTALL_DIR}/docker-compose.yml"
  if [ -f "$marker" ] \
    && fs grep -qx "managed-by=tulipfarm-installer" "$marker" 2>/dev/null; then
    return 0
  fi
  [ -f "$compose_file" ] \
    && fs grep -q "ghcr.io/tulipfarm/tulipfarm:" "$compose_file" 2>/dev/null
}

validate_managed_install_dir() {
  [ ! -e "$INSTALL_DIR" ] || is_managed_install_dir \
    || die "refusing unrecognized install directory: ${INSTALL_DIR}"
}

validate_runtime_override() {
  case "$RUNTIME_OVERRIDE" in
    "" | docker | podman) ;;
    *) die "TF_RUNTIME must be docker or podman, got: ${RUNTIME_OVERRIDE}" ;;
  esac
}

confirm_uninstall() {
  local reply
  $ASSUME_YES && return 0

  printf '\n'
  warn "This permanently deletes the TulipFarm instance and cannot be undone."
  printf 'The purge includes:\n'
  printf '  • Compose project: %s (containers and networks)\n' "$PROJECT_NAME"
  printf '  • Named volumes: PostgreSQL, Soul, generated secrets, local backups, and stored files\n'
  printf '  • TulipFarm application images and unshared images used by this project\n'
  printf '  • Install directory: %s (including .env files)\n' "$INSTALL_DIR"
  printf '\nDocker/Podman itself and externally managed databases are not removed.\n\n'

  if ! { exec 8<"$TTY_INPUT"; } 2>/dev/null \
    || ! { exec 9>"$TTY_OUTPUT"; } 2>/dev/null; then
    die "no interactive terminal available; inspect the script, then re-run with --yes"
  fi
  printf "Type 'uninstall tulipfarm' to continue: " >&9
  IFS= read -r reply <&8 || die "could not read confirmation"
  exec 8<&-
  exec 9>&-
  [ "$reply" = "uninstall tulipfarm" ] || die "confirmation did not match; nothing was removed"
}

runtime() {
  local engine="$1"
  shift
  if "$engine" info >/dev/null 2>&1; then
    "$engine" "$@"
    return
  fi
  if [ -n "$FS_SUDO" ] && "$FS_SUDO" "$engine" info >/dev/null 2>&1; then
    "$FS_SUDO" "$engine" "$@"
    return
  fi
  return 127
}

runtime_is_available() {
  local engine="$1"
  command -v "$engine" >/dev/null 2>&1 || return 1
  runtime "$engine" info >/dev/null 2>&1
}

remember_image_id() {
  local candidate="$1" existing
  [ -n "$candidate" ] || return 0
  for existing in "${PROJECT_IMAGE_IDS[@]:-}"; do
    [ "$existing" = "$candidate" ] && return 0
  done
  PROJECT_IMAGE_IDS+=("$candidate")
}

collect_project_image_ids() {
  local engine="$1" container image_id
  while IFS= read -r container; do
    [ -n "$container" ] || continue
    image_id="$(runtime "$engine" inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
    remember_image_id "$image_id"
  done < <(
    runtime "$engine" ps -aq \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true
  )
}

remove_project_containers() {
  local engine="$1" id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    runtime "$engine" rm -f "$id" >/dev/null 2>&1 \
      || fail "${engine}: could not remove project container ${id}"
  done < <(
    runtime "$engine" ps -aq \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true
  )
}

remove_project_volumes() {
  local engine="$1" id suffix
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    runtime "$engine" volume rm "$id" >/dev/null 2>&1 \
      || fail "${engine}: could not remove project volume ${id}"
  done < <(
    runtime "$engine" volume ls -q \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true
  )

  # Some Podman Compose releases do not preserve Docker's project labels. These
  # exact fallback names are the only volumes declared by TulipFarm's Compose file.
  for suffix in tulipfarm-postgres tulipfarm-soul tulipfarm-data tulipfarm-bucket; do
    id="${PROJECT_NAME}_${suffix}"
    if runtime "$engine" volume inspect "$id" >/dev/null 2>&1; then
      runtime "$engine" volume rm "$id" >/dev/null 2>&1 \
        || fail "${engine}: could not remove project volume ${id}"
    fi
  done
}

remove_project_networks() {
  local engine="$1" id fallback="${PROJECT_NAME}_default"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    runtime "$engine" network rm "$id" >/dev/null 2>&1 \
      || fail "${engine}: could not remove project network ${id}"
  done < <(
    runtime "$engine" network ls -q \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true
  )
  if runtime "$engine" network inspect "$fallback" >/dev/null 2>&1; then
    runtime "$engine" network rm "$fallback" >/dev/null 2>&1 \
      || fail "${engine}: could not remove project network ${fallback}"
  fi
}

remove_tulipfarm_images() {
  local engine="$1" reference image_id
  while IFS= read -r reference; do
    case "$reference" in
      ghcr.io/tulipfarm/tulipfarm:*)
        runtime "$engine" image rm "$reference" >/dev/null 2>&1 \
          || fail "${engine}: could not remove TulipFarm image ${reference}"
        ;;
    esac
  done < <(runtime "$engine" image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)

  # Remove the bundled PostgreSQL image too when no other container uses it. A
  # shared third-party image is left intact rather than disrupting another stack.
  for image_id in "${PROJECT_IMAGE_IDS[@]:-}"; do
    [ -n "$image_id" ] || continue
    if runtime "$engine" image inspect "$image_id" >/dev/null 2>&1; then
      runtime "$engine" image rm "$image_id" >/dev/null 2>&1 \
        || warn "${engine}: kept shared image ${image_id} because another reference uses it"
    fi
  done
}

verify_runtime_clean() {
  local engine="$1" remaining reference suffix
  remaining="$(
    runtime "$engine" ps -aq \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true
  )"
  [ -z "$remaining" ] || fail "${engine}: TulipFarm project containers remain"

  remaining="$(
    runtime "$engine" volume ls -q \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true
  )"
  [ -z "$remaining" ] || fail "${engine}: TulipFarm project volumes remain"

  remaining="$(
    runtime "$engine" network ls -q \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true
  )"
  [ -z "$remaining" ] || fail "${engine}: TulipFarm project networks remain"

  for suffix in tulipfarm-postgres tulipfarm-soul tulipfarm-data tulipfarm-bucket; do
    runtime "$engine" volume inspect "${PROJECT_NAME}_${suffix}" >/dev/null 2>&1 \
      && fail "${engine}: TulipFarm volume ${PROJECT_NAME}_${suffix} remains"
  done

  while IFS= read -r reference; do
    case "$reference" in
      ghcr.io/tulipfarm/tulipfarm:*)
        fail "${engine}: TulipFarm image ${reference} remains"
        ;;
    esac
  done < <(runtime "$engine" image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)
}

clean_runtime() {
  local engine="$1"
  log "Removing TulipFarm artifacts from ${engine}…"
  PROJECT_IMAGE_IDS=()
  collect_project_image_ids "$engine"
  remove_project_containers "$engine"
  remove_project_volumes "$engine"
  remove_project_networks "$engine"
  remove_tulipfarm_images "$engine"
  verify_runtime_clean "$engine"
  RUNTIMES_CLEANED=$((RUNTIMES_CLEANED + 1))
}

clean_runtimes() {
  local engine candidates
  candidates="${RUNTIME_OVERRIDE:-docker podman}"

  for engine in $candidates; do
    if command -v "$engine" >/dev/null 2>&1; then
      if runtime_is_available "$engine"; then
        clean_runtime "$engine"
      else
        fail "${engine} is installed but its engine is not accessible"
      fi
    fi
  done
  [ "$RUNTIMES_CLEANED" -gt 0 ] \
    || fail "no accessible Docker or Podman engine; container artifacts could not be verified"
}

remove_install_dir() {
  [ -e "$INSTALL_DIR" ] || return 0
  if ! is_managed_install_dir; then
    fail "refusing to remove unrecognized directory ${INSTALL_DIR}"
    return
  fi
  log "Removing installer files and environment from ${INSTALL_DIR}…"
  fs rm -rf -- "$INSTALL_DIR" || fail "could not remove ${INSTALL_DIR}"
}

verify_install_dir_clean() {
  [ ! -e "$INSTALL_DIR" ] || fail "install directory remains: ${INSTALL_DIR}"
}

main() {
  parse_args "$@"
  validate_install_dir
  ensure_privilege_helper
  resolve_project_name
  validate_runtime_override
  validate_managed_install_dir
  confirm_uninstall
  clean_runtimes
  if [ "$ERRORS" -eq 0 ]; then
    remove_install_dir
    verify_install_dir_clean
  else
    warn "Retaining ${INSTALL_DIR} so the uninstall can be retried safely."
  fi

  printf '\n'
  if [ "$ERRORS" -gt 0 ]; then
    die "uninstall incomplete (${ERRORS} cleanup error(s)); review the messages above"
  fi
  log "TulipFarm was completely removed from this host."
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" = "$0" ]]; then
  main "$@"
fi
