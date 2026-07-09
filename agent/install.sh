#!/bin/sh
set -eu

SERVER=""
TOKEN=""
NODE_NAME="$(hostname 2>/dev/null || echo node)"
INTERVAL="3"
PING_INTERVAL="120"
TRAFFIC_RESET_DAY="1"
MODE="websocket"
INSTALL_MODE="auto"
INSTALL_DIR=""
SERVICE_NAME=""
INSTANCE_ID=""
SOURCE_URL=""
BUILD_FROM_SOURCE="0"
BINARY=""
BINARY_URL=""
BINARY_BASE_URL=""
CHECKSUM_URL=""
AUTO_BINARY_URL="0"
DRY_RUN="0"
UNINSTALL="0"
UNINSTALL_ALL="0"
YES="0"
KEEP_FILES="0"
INSTALL_GHPROXY=""
PROXY=""
CF_MONITOR_REPOSITORY="kadidalax/cf-vps-monitor"
CF_MONITOR_BRANCH="main"
CF_MONITOR_RELEASE_TAG=""
CF_MONITOR_RELEASE_BASE="https://github.com/${CF_MONITOR_REPOSITORY}/releases/latest/download"
MOUNT_INCLUDE=""
MOUNT_EXCLUDE=""
NIC_INCLUDE=""
NIC_EXCLUDE=""
AGENT_USER="cf-vps-monitor-agent"
OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"

die() {
  echo "$*" >&2
  exit 1
}

has() {
  command -v "$1" >/dev/null 2>&1
}

usage() {
  cat <<'EOF'
Usage:
  ./install.sh --server https://worker.example.com --token TOKEN [options]
  ./install.sh --uninstall [options]

Options:
  --server URL              Worker URL, required.
  --token TOKEN             Agent token from admin panel. Required.
  --name NAME               Node name, default: hostname.
  --interval SECONDS        Report interval, default: 3.
  --ping-interval SECONDS   Ping task poll interval, default: 120.
  --traffic-reset-day DAY   Monthly traffic reset day, default: 1.
  --mode MODE               websocket or http, default: websocket.
  --instance-id ID          Instance id used for default names and paths.
  --install-mode MODE       auto, system, or user. Default: auto.
  --install-dir DIR         Install directory. Default depends on mode.
  --service-name NAME       system service name, default: cf-vps-monitor-agent-<instance-id>.
  --install-service-name NAME
                            Legacy alias for --service-name.
  --binary PATH             Existing agent binary.
  --binary-url URL          Download a prebuilt agent binary from this URL.
  --binary-base-url URL     Base URL containing architecture-specific prebuilt binaries.
  --checksum-url URL        SHA256SUMS URL for --binary-url verification.
  --release-tag TAG         GitHub release tag used for default binary downloads.
  --build-from-source       Build from GitHub source archive. Requires Go.
  --source-url URL          Source archive used with --build-from-source.
  --proxy URL               Proxy used for binary downloads, for example http://127.0.0.1:10808.
  --mount-include LIST      Comma-separated mountpoint/device patterns included in disk totals.
  --mount-exclude LIST      Comma-separated mountpoint/device patterns excluded from disk totals.
  --nic-include LIST        Comma-separated network interface patterns included in traffic totals.
  --nic-exclude LIST        Comma-separated network interface patterns excluded from traffic totals.
  --disable-web-ssh         Accepted as a legacy no-op option.
  --disable-auto-update     Accepted as a legacy no-op option.
  --ignore-unsafe-cert      Accepted as a legacy no-op option.
  --install-ghproxy URL     GitHub proxy used for default GitHub downloads.
  --dry-run                 Print actions without changing the system.
  --uninstall               Stop and remove this agent.
  --uninstall-all           Remove all system/user mode CF VPS Monitor agents.
  --yes                     Confirm destructive --uninstall-all.
  --keep-files              With --uninstall, keep installed files.
  -h, --help                Show help.
EOF
}

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run]'
    for arg in "$@"; do printf ' %s' "$arg"; done
    printf '\n'
  else
    "$@"
  fi
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

reject_newline() {
  name="$1"
  value="$2"
  nl='
'
  cr="$(printf '\r')"
  case "$value" in
    *"$nl"*|*"$cr"*) die "--${name} must not contain newlines" ;;
  esac
}

normalize_proxy_url() {
  name="$1"
  value="${2%/}"
  [ -n "$value" ] || {
    printf ''
    return
  }
  case "$value" in
    http://*|https://*) ;;
    *) die "${name} must use an http:// or https:// URL." ;;
  esac
  if printf '%s' "$value" | grep -Eq '[[:space:]@?#]'; then
    die "${name} must not contain credentials, query, fragment, or whitespace."
  fi
  printf '%s' "$value"
}

require_https_url() {
  name="$1"
  url="$2"
  [ -z "$url" ] || case "$url" in
    https://*) ;;
    *) die "${name} must use an https:// URL." ;;
  esac
  if [ -n "$url" ] && printf '%s' "$url" | grep -Eq '[[:space:]@?#]'; then
    die "${name} must not contain credentials, query, fragment, or whitespace."
  fi
}

with_github_proxy() {
  url="$1"
  if [ -n "$INSTALL_GHPROXY" ]; then
    printf '%s/%s' "$INSTALL_GHPROXY" "$url"
  else
    printf '%s' "$url"
  fi
}

download_file() {
  url="$1"
  output="$2"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] download ${url} to ${output}"
    return 0
  fi
  if has curl; then
    if [ -n "$PROXY" ]; then
      curl -fsSL --retry 3 --proxy "$PROXY" -o "$output" "$url"
    else
      curl -fsSL --retry 3 -o "$output" "$url"
    fi
  elif has wget; then
    if [ -n "$PROXY" ]; then
      http_proxy="$PROXY" https_proxy="$PROXY" wget -O "$output" "$url"
    else
      wget -O "$output" "$url"
    fi
  elif has fetch; then
    if [ -n "$PROXY" ]; then
      HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" fetch -o "$output" "$url"
    else
      fetch -o "$output" "$url"
    fi
  else
    die "curl, wget, or fetch is required to download files."
  fi
}

sha256_file() {
  file="$1"
  if has sha256sum; then
    sha256sum "$file" | awk '{ print tolower($1) }'
  elif has shasum; then
    shasum -a 256 "$file" | awk '{ print tolower($1) }'
  elif has sha256; then
    sha256 -q "$file" | awk '{ print tolower($1) }'
  else
    die "sha256sum, shasum, or sha256 is required to verify downloaded agent binaries."
  fi
}

write_file() {
  path="$1"
  mode="$2"
  content="$3"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] write ${path} (${mode})"
  else
    printf '%s\n' "$content" > "$path"
    chmod "$mode" "$path"
  fi
}

copy_binary_to() {
  src="$1"
  dst="$2"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] install ${src} ${dst}"
  else
    cp "$src" "$dst"
    chmod 0755 "$dst"
  fi
}

sanitize_instance_id() {
  raw="${1:-default}"
  cleaned="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_.-]+/-/g; s/^-+//; s/-+$//')"
  [ -n "$cleaned" ] || cleaned="default"
  printf '%s' "$cleaned" | cut -c 1-48
}

is_root() {
  [ "$(id -u 2>/dev/null || echo 1)" = "0" ]
}

detect_service_mode() {
  install_mode="$INSTALL_MODE"
  case "$install_mode" in
    auto|system|user) ;;
    *) die "--install-mode must be auto, system, or user." ;;
  esac

  if [ "$install_mode" = "user" ]; then
    printf 'user'
    return
  fi

  if ! is_root; then
    [ "$install_mode" = "auto" ] && {
      printf 'user'
      return
    }
    die "--install-mode system requires root."
  fi

  case "$OS_NAME" in
    darwin)
      printf 'launchctl'
      ;;
    linux)
      if has systemctl; then
        printf 'systemd'
      elif has rc-service || [ -d /etc/init.d ]; then
        printf 'openrc'
      elif [ "$install_mode" = "auto" ]; then
        printf 'user'
      else
        die "systemd or OpenRC is required for --install-mode system on Linux."
      fi
      ;;
    freebsd)
      [ "$install_mode" = "auto" ] && printf 'user' || die "FreeBSD system service is not supported by this installer yet. Use --install-mode user."
      ;;
    *)
      [ "$install_mode" = "auto" ] && printf 'user' || die "Unsupported OS for system install: ${OS_NAME}"
      ;;
  esac
}

set_release_base() {
  if [ -z "$CF_MONITOR_RELEASE_TAG" ]; then
    CF_MONITOR_RELEASE_BASE="https://github.com/${CF_MONITOR_REPOSITORY}/releases/latest/download"
    return
  fi
  if ! printf '%s' "$CF_MONITOR_RELEASE_TAG" | grep -Eq '^[A-Za-z0-9._-]{1,128}$' || printf '%s' "$CF_MONITOR_RELEASE_TAG" | grep -Eq '^-'; then
    die "--release-tag must contain only A-Z, a-z, 0-9, dot, underscore, or dash, and cannot start with dash."
  fi
  CF_MONITOR_RELEASE_BASE="https://github.com/${CF_MONITOR_REPOSITORY}/releases/download/${CF_MONITOR_RELEASE_TAG}"
}

detect_binary_filename() {
  os="$OS_NAME"
  arch="$(uname -m | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    linux|darwin|freebsd) ;;
    *) die "Unsupported OS for prebuilt agent: ${os}" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "Unsupported CPU architecture for prebuilt agent: ${arch}" ;;
  esac
  printf 'cf-vps-monitor-agent-%s-%s' "$os" "$arch"
}

default_binary_url() {
  filename="$(detect_binary_filename)"
  base="${BINARY_BASE_URL:-$CF_MONITOR_RELEASE_BASE}"
  printf '%s/%s' "${base%/}" "$filename"
}

default_checksum_url() {
  base="${BINARY_BASE_URL:-$CF_MONITOR_RELEASE_BASE}"
  printf '%s/SHA256SUMS' "${base%/}"
}

verify_binary_checksum() {
  binary="$1"
  filename="$2"
  checksum_url="$3"
  [ -n "$checksum_url" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] verify SHA256SUMS for ${filename} from ${checksum_url}"
    return 0
  fi
  sums_file="$(mktemp "${TMPDIR:-/tmp}/cf-vps-monitor-agent-sha256.XXXXXX")"
  download_file "$checksum_url" "$sums_file"
  expected="$(awk -v f="$filename" '{name=$2; sub(/^\*/, "", name); sub(/^.*\//, "", name); if (name == f) { print tolower($1); exit }}' "$sums_file")"
  rm -f "$sums_file"
  [ -n "$expected" ] || die "Cannot find ${filename} in SHA256SUMS from ${checksum_url}."
  actual="$(sha256_file "$binary")"
  [ "$actual" = "$expected" ] || die "Checksum verification failed for ${filename}."
}

install_root_dependencies() {
  [ "$DRY_RUN" = "1" ] && return 0
  if has curl || has wget || has fetch; then
    return 0
  fi
  if has apk; then
    run apk add --no-cache ca-certificates curl tar shadow
  elif has apt-get; then
    run apt-get update
    run apt-get install -y ca-certificates curl tar
  elif has dnf; then
    run dnf install -y ca-certificates curl tar shadow-utils
  elif has yum; then
    run yum install -y ca-certificates curl tar shadow-utils
  elif has pacman; then
    run pacman -Sy --needed --noconfirm ca-certificates curl tar shadow
  fi
}

ensure_agent_user() {
  is_root || return 0
  [ "$OS_NAME" = "linux" ] || return 0
  if id -u "$AGENT_USER" >/dev/null 2>&1; then
    return 0
  fi
  if has useradd; then
    run useradd --system --no-create-home --shell /usr/sbin/nologin --user-group "$AGENT_USER"
  elif has adduser && has addgroup; then
    run addgroup -S "$AGENT_USER" || true
    run adduser -S -D -H -s /sbin/nologin -G "$AGENT_USER" "$AGENT_USER"
  else
    die "useradd or adduser/addgroup is required to create the ${AGENT_USER} service account."
  fi
}

resolve_build_dir() {
  source_archive="${SOURCE_ARCHIVE:-$(mktemp "${TMPDIR:-/tmp}/cf-vps-monitor-source.XXXXXX.tar.gz")}"
  source_dir="${SOURCE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/cf-vps-monitor-source.XXXXXX")}"
  SOURCE_ARCHIVE="$source_archive"
  SOURCE_DIR="$source_dir"
  source_url="${SOURCE_URL:-https://github.com/${CF_MONITOR_REPOSITORY}/archive/refs/heads/${CF_MONITOR_BRANCH}.tar.gz}"
  source_url="$(with_github_proxy "$source_url")"
  download_file "$source_url" "$source_archive" >&2
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] tar -xzf ${source_archive} -C ${source_dir}" >&2
    printf '%s' "$source_dir/cf-vps-monitor-${CF_MONITOR_BRANCH}/agent"
    return
  fi
  has tar || die "tar is required to extract the source archive."
  tar -xzf "$source_archive" -C "$source_dir"
  main_go="$(find "$source_dir" -path '*/agent/main.go' -print -quit)"
  [ -n "$main_go" ] || die "Cannot find agent/main.go in source archive: $source_url"
  dirname "$main_go"
}

apply_defaults() {
  BASE_ID="$(sanitize_instance_id "${INSTANCE_ID:-default}")"
  [ -n "$SERVICE_NAME" ] || SERVICE_NAME="cf-vps-monitor-agent-${BASE_ID}"
  if ! printf '%s' "$SERVICE_NAME" | grep -Eq '^[A-Za-z0-9_.@-]+$'; then
    die "--service-name may only contain A-Z, a-z, 0-9, dot, underscore, dash, or @."
  fi

  case "$SERVICE_MODE" in
    user)
      [ -n "${HOME:-}" ] || die "HOME is required for user mode install."
      data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
      config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
      state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
      [ -n "$INSTALL_DIR" ] || INSTALL_DIR="${data_home}/cf-vps-monitor/${BASE_ID}"
      CONFIG_DIR="${config_home}/cf-vps-monitor"
      STATE_DIR="${state_home}/cf-vps-monitor/${BASE_ID}"
      ENV_FILE="${CONFIG_DIR}/${BASE_ID}.env"
      PID_FILE="${STATE_DIR}/agent.pid"
      LOG_FILE="${STATE_DIR}/agent.log"
      ;;
    launchctl)
      [ -n "$INSTALL_DIR" ] || INSTALL_DIR="/usr/local/cf-vps-monitor/${BASE_ID}"
      STATE_DIR="${INSTALL_DIR}/state"
      ENV_FILE=""
      PLIST_FILE="/Library/LaunchDaemons/${SERVICE_NAME}.plist"
      ;;
    openrc)
      [ -n "$INSTALL_DIR" ] || INSTALL_DIR="/opt/cf-vps-monitor/${BASE_ID}"
      STATE_DIR="${INSTALL_DIR}/state"
      ENV_FILE="/etc/conf.d/${SERVICE_NAME}"
      INIT_FILE="/etc/init.d/${SERVICE_NAME}"
      ;;
    systemd)
      [ -n "$INSTALL_DIR" ] || INSTALL_DIR="/opt/cf-vps-monitor/${BASE_ID}"
      STATE_DIR="${INSTALL_DIR}/state"
      ENV_FILE="/etc/${SERVICE_NAME}.env"
      UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
      ;;
  esac
  [ -n "$INSTALL_DIR" ] && [ "$INSTALL_DIR" != "/" ] || die "--install-dir cannot be empty or /."
  RUNNER_FILE="${INSTALL_DIR}/run-agent.sh"
}

env_content() {
  cat <<EOF
CF_MONITOR_SERVER=$(shell_quote "$SERVER")
CF_MONITOR_TOKEN=$(shell_quote "$TOKEN")
CF_MONITOR_NAME=$(shell_quote "$NODE_NAME")
CF_MONITOR_MODE=$(shell_quote "$MODE")
CF_MONITOR_MOUNT_INCLUDE=$(shell_quote "$MOUNT_INCLUDE")
CF_MONITOR_MOUNT_EXCLUDE=$(shell_quote "$MOUNT_EXCLUDE")
CF_MONITOR_NIC_INCLUDE=$(shell_quote "$NIC_INCLUDE")
CF_MONITOR_NIC_EXCLUDE=$(shell_quote "$NIC_EXCLUDE")
CF_MONITOR_TRAFFIC_RESET_DAY=$(shell_quote "$TRAFFIC_RESET_DAY")
CF_MONITOR_TRAFFIC_STATE_FILE=$(shell_quote "${STATE_DIR}/traffic-state.json")
EOF
}

validate_common() {
  [ -n "$SERVICE_NAME" ] || die "--service-name cannot be empty."
  [ "$MODE" = "websocket" ] || [ "$MODE" = "http" ] || die "--mode must be websocket or http."
  if ! printf '%s' "$TRAFFIC_RESET_DAY" | grep -Eq '^[0-9]+$' || [ "$TRAFFIC_RESET_DAY" -lt 1 ] || [ "$TRAFFIC_RESET_DAY" -gt 31 ]; then
    die "--traffic-reset-day must be a number from 1 to 31."
  fi
  for pair in \
    "server:$SERVER" "token:$TOKEN" "name:$NODE_NAME" "mode:$MODE" \
    "mount-include:$MOUNT_INCLUDE" "mount-exclude:$MOUNT_EXCLUDE" \
    "nic-include:$NIC_INCLUDE" "nic-exclude:$NIC_EXCLUDE" \
    "traffic-reset-day:$TRAFFIC_RESET_DAY"
  do
    reject_newline "${pair%%:*}" "${pair#*:}"
  done
}

prepare_binary() {
  if [ -n "$BINARY" ] && { [ -n "$BINARY_URL" ] || [ "$BUILD_FROM_SOURCE" = "1" ]; }; then
    die "Use only one of --binary, --binary-url, or --build-from-source."
  fi
  if [ -n "$BINARY_URL" ] && [ "$BUILD_FROM_SOURCE" = "1" ]; then
    die "Use only one of --binary-url or --build-from-source."
  fi
  require_https_url "--binary-url" "$BINARY_URL"
  require_https_url "--binary-base-url" "$BINARY_BASE_URL"
  require_https_url "--checksum-url" "$CHECKSUM_URL"
  require_https_url "--source-url" "$SOURCE_URL"

  WORK_BIN=""
  if [ -n "$BINARY" ]; then
    [ -f "$BINARY" ] || die "Binary not found: $BINARY"
    WORK_BIN="$BINARY"
    return
  fi

  if [ -z "$BINARY_URL" ] && [ "$BUILD_FROM_SOURCE" != "1" ]; then
    DEFAULT_BINARY_URL="$(default_binary_url)"
    if [ -n "$BINARY_BASE_URL" ]; then
      BINARY_URL="$DEFAULT_BINARY_URL"
      CHECKSUM_URL="${CHECKSUM_URL:-$(default_checksum_url)}"
    else
      BINARY_URL="$(with_github_proxy "$DEFAULT_BINARY_URL")"
      CHECKSUM_URL="$(with_github_proxy "$(default_checksum_url)")"
    fi
    AUTO_BINARY_URL="1"
  fi

  if [ -n "$BINARY_URL" ]; then
    [ -n "$CHECKSUM_URL" ] || [ "$AUTO_BINARY_URL" = "1" ] || die "Custom --binary-url requires --checksum-url for SHA256 verification."
    if [ "$DRY_RUN" = "1" ]; then
      WORK_BIN="${TMPDIR:-/tmp}/cf-vps-monitor-agent.dry-run"
      download_file "$BINARY_URL" "$WORK_BIN"
    else
      WORK_BIN="$(mktemp "${TMPDIR:-/tmp}/cf-vps-monitor-agent.XXXXXX")"
      if download_file "$BINARY_URL" "$WORK_BIN"; then
        verify_binary_checksum "$WORK_BIN" "$(basename "$BINARY_URL")" "$CHECKSUM_URL"
        chmod 0755 "$WORK_BIN"
      elif [ "$AUTO_BINARY_URL" = "1" ]; then
        echo "Prebuilt agent binary was not found at ${BINARY_URL}; falling back to source build." >&2
        rm -f "$WORK_BIN"
        WORK_BIN=""
        BINARY_URL=""
        BUILD_FROM_SOURCE="1"
      else
        rm -f "$WORK_BIN"
        exit 1
      fi
    fi
  fi

  if [ -z "$WORK_BIN" ] && [ "$BUILD_FROM_SOURCE" = "1" ]; then
    [ "$DRY_RUN" = "1" ] || has go || die "Go is required to build the agent from source. Install Go, publish release assets, or pass --binary-url."
    if [ "$DRY_RUN" = "1" ]; then
      WORK_BIN="${TMPDIR:-/tmp}/cf-vps-monitor-agent.dry-run"
      BUILD_DIR="$(resolve_build_dir)"
      echo "[dry-run] cd ${BUILD_DIR} && go build -trimpath -ldflags=-s -w -o ${WORK_BIN} ."
    else
      WORK_BIN="$(mktemp "${TMPDIR:-/tmp}/cf-vps-monitor-agent.XXXXXX")"
      BUILD_DIR="$(resolve_build_dir)"
      (cd "$BUILD_DIR" && go build -trimpath -ldflags="-s -w" -o "$WORK_BIN" .)
    fi
  fi
}

install_systemd() {
  ensure_agent_user
  run mkdir -p "$INSTALL_DIR" "$STATE_DIR"
  copy_binary_to "$WORK_BIN" "$INSTALL_DIR/cf-vps-monitor-agent"
  run chown -R "$AGENT_USER:$AGENT_USER" "$STATE_DIR"
  write_file "$ENV_FILE" "600" "$(env_content)"
  UNIT_CONTENT=$(cat <<EOF
[Unit]
Description=CF VPS Monitor Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${AGENT_USER}
Group=${AGENT_USER}
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/cf-vps-monitor-agent --interval ${INTERVAL} --ping-interval ${PING_INTERVAL} --traffic-reset-day ${TRAFFIC_RESET_DAY}
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=${STATE_DIR}

[Install]
WantedBy=multi-user.target
EOF
)
  write_file "$UNIT_FILE" "644" "$UNIT_CONTENT"
  run systemctl daemon-reload
  run systemctl enable "$SERVICE_NAME"
  run systemctl restart "$SERVICE_NAME"
  echo "Installed ${SERVICE_NAME}."
  echo "Status: systemctl status ${SERVICE_NAME}"
  echo "Logs:   journalctl -u ${SERVICE_NAME} -f"
}

install_openrc() {
  ensure_agent_user
  run mkdir -p "$INSTALL_DIR" "$STATE_DIR" /etc/conf.d /etc/init.d
  copy_binary_to "$WORK_BIN" "$INSTALL_DIR/cf-vps-monitor-agent"
  run chown -R "$AGENT_USER:$AGENT_USER" "$STATE_DIR"
  write_file "$ENV_FILE" "600" "$(env_content)"
  INIT_CONTENT=$(cat <<EOF
#!/sbin/openrc-run
name="CF VPS Monitor Agent"
description="CF VPS Monitor Agent"
command="${INSTALL_DIR}/cf-vps-monitor-agent"
command_args="--interval ${INTERVAL} --ping-interval ${PING_INTERVAL} --traffic-reset-day ${TRAFFIC_RESET_DAY}"
command_user="${AGENT_USER}:${AGENT_USER}"
command_background=true
pidfile="/run/\${RC_SVCNAME}.pid"
directory="${INSTALL_DIR}"
output_log="/var/log/\${RC_SVCNAME}.log"
error_log="/var/log/\${RC_SVCNAME}.log"

depend() {
  need net
}

start_pre() {
  export CF_MONITOR_SERVER CF_MONITOR_TOKEN CF_MONITOR_NAME CF_MONITOR_MODE
  export CF_MONITOR_MOUNT_INCLUDE CF_MONITOR_MOUNT_EXCLUDE CF_MONITOR_NIC_INCLUDE CF_MONITOR_NIC_EXCLUDE
  export CF_MONITOR_TRAFFIC_RESET_DAY CF_MONITOR_TRAFFIC_STATE_FILE
  checkpath -d -m 0755 -o ${AGENT_USER}:${AGENT_USER} "${STATE_DIR}"
}
EOF
)
  write_file "$INIT_FILE" "755" "$INIT_CONTENT"
  run rc-update add "$SERVICE_NAME" default
  run rc-service "$SERVICE_NAME" restart
  echo "Installed ${SERVICE_NAME}."
  echo "Status: rc-service ${SERVICE_NAME} status"
  echo "Logs:   tail -f /var/log/${SERVICE_NAME}.log"
  echo "Note: ICMP ping depends on this system's ping permissions; TCP/HTTP reports are not affected."
}

install_launchctl() {
  run mkdir -p "$INSTALL_DIR" "$STATE_DIR"
  copy_binary_to "$WORK_BIN" "$INSTALL_DIR/cf-vps-monitor-agent"
  RUNNER_CONTENT=$(cat <<EOF
#!/bin/sh
set -eu
$(env_content | sed 's/^/export /')
exec $(shell_quote "${INSTALL_DIR}/cf-vps-monitor-agent") --interval ${INTERVAL} --ping-interval ${PING_INTERVAL} --traffic-reset-day ${TRAFFIC_RESET_DAY}
EOF
)
  write_file "$RUNNER_FILE" "700" "$RUNNER_CONTENT"
  PLIST_CONTENT=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${RUNNER_FILE}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/${SERVICE_NAME}.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/${SERVICE_NAME}.log</string>
</dict>
</plist>
EOF
)
  write_file "$PLIST_FILE" "644" "$PLIST_CONTENT"
  run launchctl bootout system "$PLIST_FILE" || true
  run launchctl bootstrap system "$PLIST_FILE"
  echo "Installed ${SERVICE_NAME}."
  echo "Status: launchctl print system/${SERVICE_NAME}"
  echo "Logs:   tail -f /var/log/${SERVICE_NAME}.log"
}

install_user_autostart() {
  marker="cf-vps-monitor:${BASE_ID}"
  if ! has crontab; then
    echo "crontab not found; agent is started now but reboot autostart is not configured."
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] add crontab @reboot ${INSTALL_DIR}/start.sh # ${marker}"
    return 0
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/cf-vps-monitor-cron.XXXXXX")"
  (crontab -l 2>/dev/null | grep -v "$marker" || true; printf '@reboot %s # %s\n' "$INSTALL_DIR/start.sh" "$marker") > "$tmp"
  crontab "$tmp"
  rm -f "$tmp"
  echo "Autostart: crontab @reboot configured."
}

install_user_mode() {
  run mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR"
  if [ "$DRY_RUN" != "1" ]; then
    chmod 700 "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR"
  fi
  copy_binary_to "$WORK_BIN" "$INSTALL_DIR/cf-vps-monitor-agent"
  write_file "$ENV_FILE" "600" "$(env_content)"

  RUNNER_CONTENT=$(cat <<EOF
#!/bin/sh
set -eu
. $(shell_quote "$ENV_FILE")
export CF_MONITOR_SERVER CF_MONITOR_TOKEN CF_MONITOR_NAME CF_MONITOR_MODE
export CF_MONITOR_MOUNT_INCLUDE CF_MONITOR_MOUNT_EXCLUDE CF_MONITOR_NIC_INCLUDE CF_MONITOR_NIC_EXCLUDE
export CF_MONITOR_TRAFFIC_RESET_DAY CF_MONITOR_TRAFFIC_STATE_FILE
exec $(shell_quote "${INSTALL_DIR}/cf-vps-monitor-agent") --interval ${INTERVAL} --ping-interval ${PING_INTERVAL} --traffic-reset-day ${TRAFFIC_RESET_DAY}
EOF
)
  write_file "$RUNNER_FILE" "700" "$RUNNER_CONTENT"

  START_CONTENT=$(cat <<EOF
#!/bin/sh
set -eu
PID_FILE=$(shell_quote "$PID_FILE")
LOG_FILE=$(shell_quote "$LOG_FILE")
RUNNER=$(shell_quote "$RUNNER_FILE")
if [ -s "\$PID_FILE" ]; then
  pid="\$(cat "\$PID_FILE" 2>/dev/null || true)"
  case "\$pid" in
    ''|*[!0-9]*) ;;
    *) if kill -0 "\$pid" 2>/dev/null; then echo "CF VPS Monitor Agent already running: \$pid"; exit 0; fi ;;
  esac
fi
nohup "\$RUNNER" >> "\$LOG_FILE" 2>&1 &
echo \$! > "\$PID_FILE"
echo "CF VPS Monitor Agent started: \$(cat "\$PID_FILE")"
EOF
)
  write_file "${INSTALL_DIR}/start.sh" "700" "$START_CONTENT"

  STOP_CONTENT=$(cat <<EOF
#!/bin/sh
set -eu
PID_FILE=$(shell_quote "$PID_FILE")
if [ ! -s "\$PID_FILE" ]; then echo "CF VPS Monitor Agent is not running."; exit 0; fi
pid="\$(cat "\$PID_FILE" 2>/dev/null || true)"
case "\$pid" in ''|*[!0-9]*) rm -f "\$PID_FILE"; exit 0 ;; esac
if kill -0 "\$pid" 2>/dev/null; then kill "\$pid"; fi
rm -f "\$PID_FILE"
echo "CF VPS Monitor Agent stopped."
EOF
)
  write_file "${INSTALL_DIR}/stop.sh" "700" "$STOP_CONTENT"

  STATUS_CONTENT=$(cat <<EOF
#!/bin/sh
PID_FILE=$(shell_quote "$PID_FILE")
LOG_FILE=$(shell_quote "$LOG_FILE")
if [ -s "\$PID_FILE" ]; then
  pid="\$(cat "\$PID_FILE" 2>/dev/null || true)"
  if [ -n "\$pid" ] && kill -0 "\$pid" 2>/dev/null; then echo "running: \$pid"; else echo "stopped"; fi
else
  echo "stopped"
fi
[ -f "\$LOG_FILE" ] && tail -n 20 "\$LOG_FILE"
EOF
)
  write_file "${INSTALL_DIR}/status.sh" "700" "$STATUS_CONTENT"

  UNINSTALL_CONTENT=$(cat <<EOF
#!/bin/sh
set -eu
MARKER=$(shell_quote "cf-vps-monitor:${BASE_ID}")
INSTALL_DIR=$(shell_quote "$INSTALL_DIR")
ENV_FILE=$(shell_quote "$ENV_FILE")
STATE_DIR=$(shell_quote "$STATE_DIR")
"\$INSTALL_DIR/stop.sh" >/dev/null 2>&1 || true
if command -v crontab >/dev/null 2>&1; then
  tmp="\$(mktemp "\${TMPDIR:-/tmp}/cf-vps-monitor-cron.XXXXXX")"
  crontab -l 2>/dev/null | grep -v "\$MARKER" > "\$tmp" || true
  crontab "\$tmp" 2>/dev/null || true
  rm -f "\$tmp"
fi
rm -rf "\$INSTALL_DIR" "\$ENV_FILE" "\$STATE_DIR"
echo "CF VPS Monitor Agent user-mode files removed."
EOF
)
  write_file "${INSTALL_DIR}/uninstall.sh" "700" "$UNINSTALL_CONTENT"

  install_user_autostart
  run "${INSTALL_DIR}/start.sh"
  echo "Installed CF VPS Monitor Agent in user mode."
  echo "Install dir: ${INSTALL_DIR}"
  echo "Status:      ${INSTALL_DIR}/status.sh"
  echo "Stop:        ${INSTALL_DIR}/stop.sh"
  echo "Uninstall:   ${INSTALL_DIR}/uninstall.sh"
}

uninstall_user_mode() {
  marker="cf-vps-monitor:${BASE_ID}"
  if [ -x "${INSTALL_DIR}/stop.sh" ]; then
    run "${INSTALL_DIR}/stop.sh" || true
  fi
  if has crontab; then
    if [ "$DRY_RUN" = "1" ]; then
      echo "[dry-run] remove crontab marker ${marker}"
    else
      tmp="$(mktemp "${TMPDIR:-/tmp}/cf-vps-monitor-cron.XXXXXX")"
      crontab -l 2>/dev/null | grep -v "$marker" > "$tmp" || true
      crontab "$tmp" 2>/dev/null || true
      rm -f "$tmp"
    fi
  fi
  if [ "$KEEP_FILES" != "1" ]; then
    run rm -rf "$INSTALL_DIR" "$ENV_FILE" "$STATE_DIR"
  fi
  echo "Uninstalled CF VPS Monitor Agent user-mode instance ${BASE_ID}."
}

uninstall_system() {
  case "$SERVICE_MODE" in
    launchctl)
      run launchctl bootout system "$PLIST_FILE" || true
      run rm -f "$PLIST_FILE"
      ;;
    openrc)
      run rc-service "$SERVICE_NAME" stop || true
      run rc-update del "$SERVICE_NAME" default || true
      run rm -f "$INIT_FILE" "$ENV_FILE"
      ;;
    systemd)
      run systemctl disable --now "$SERVICE_NAME" || true
      run rm -f "$UNIT_FILE" "$ENV_FILE"
      run systemctl daemon-reload
      ;;
    user)
      uninstall_user_mode
      return
      ;;
  esac
  [ "$KEEP_FILES" = "1" ] || run rm -rf "$INSTALL_DIR"
  echo "Uninstalled ${SERVICE_NAME}."
}

uninstall_all_agents() {
  [ "$YES" = "1" ] || die "--uninstall-all requires --yes."
  if [ "$SERVICE_MODE" = "user" ]; then
    data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
    config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
    state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
    [ "$KEEP_FILES" = "1" ] || run rm -rf "${data_home}/cf-vps-monitor" "${config_home}/cf-vps-monitor" "${state_home}/cf-vps-monitor"
    echo "Removed user-mode CF VPS Monitor agent files."
    return
  fi
  if [ "$OS_NAME" = "darwin" ]; then
    for plist in /Library/LaunchDaemons/cf-vps-monitor-agent*.plist; do
      [ -e "$plist" ] || continue
      run launchctl bootout system "$plist" || true
    done
    run rm -f /Library/LaunchDaemons/cf-vps-monitor-agent*.plist
    [ "$KEEP_FILES" = "1" ] || run rm -rf /usr/local/cf-vps-monitor /opt/cf-vps-monitor
  elif [ "$SERVICE_MODE" = "openrc" ]; then
    for init in /etc/init.d/cf-vps-monitor-agent*; do
      [ -e "$init" ] || continue
      name="$(basename "$init")"
      run rc-service "$name" stop || true
      run rc-update del "$name" default || true
    done
    run rm -f /etc/init.d/cf-vps-monitor-agent* /etc/conf.d/cf-vps-monitor-agent*
    [ "$KEEP_FILES" = "1" ] || run rm -rf /opt/cf-vps-monitor
  else
    for unit in /etc/systemd/system/cf-vps-monitor-agent*.service; do
      [ -e "$unit" ] || continue
      run systemctl disable --now "$(basename "$unit")" || true
    done
    run rm -f /etc/systemd/system/cf-vps-monitor-agent*.service /etc/cf-vps-monitor-agent*.env
    [ "$KEEP_FILES" = "1" ] || run rm -rf /opt/cf-vps-monitor
    run systemctl daemon-reload
  fi
  echo "Uninstalled all CF VPS Monitor agent services and files."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -s|--server) SERVER="${2:-}"; shift 2 ;;
    -t|--token) TOKEN="${2:-}"; shift 2 ;;
    -n|--name) NODE_NAME="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --ping-interval) PING_INTERVAL="${2:-}"; shift 2 ;;
    -r|--traffic-reset-day) TRAFFIC_RESET_DAY="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    -i|--instance-id) INSTANCE_ID="${2:-}"; shift 2 ;;
    --install-mode) INSTALL_MODE="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --service-name|--install-service-name) SERVICE_NAME="${2:-}"; shift 2 ;;
    --build-from-source) BUILD_FROM_SOURCE="1"; shift ;;
    --source-url) SOURCE_URL="${2:-}"; shift 2 ;;
    --binary) BINARY="${2:-}"; shift 2 ;;
    --binary-url) BINARY_URL="${2:-}"; shift 2 ;;
    --binary-base-url) BINARY_BASE_URL="${2:-}"; shift 2 ;;
    --checksum-url) CHECKSUM_URL="${2:-}"; shift 2 ;;
    --release-tag) CF_MONITOR_RELEASE_TAG="${2:-}"; shift 2 ;;
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --mount-include) MOUNT_INCLUDE="${2:-}"; shift 2 ;;
    --mount-exclude) MOUNT_EXCLUDE="${2:-}"; shift 2 ;;
    --nic-include) NIC_INCLUDE="${2:-}"; shift 2 ;;
    --nic-exclude) NIC_EXCLUDE="${2:-}"; shift 2 ;;
    --disable-web-ssh|--disable-auto-update|--ignore-unsafe-cert) shift ;;
    --install-ghproxy) INSTALL_GHPROXY="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    --uninstall) UNINSTALL="1"; shift ;;
    --uninstall-all) UNINSTALL_ALL="1"; shift ;;
    --yes|-y) YES="1"; shift ;;
    --keep-files) KEEP_FILES="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

set_release_base
PROXY="$(normalize_proxy_url "--proxy" "$PROXY")"
INSTALL_GHPROXY="$(normalize_proxy_url "--install-ghproxy" "$INSTALL_GHPROXY")"
SERVICE_MODE="$(detect_service_mode)"
apply_defaults

if [ "$UNINSTALL_ALL" = "1" ]; then
  uninstall_all_agents
  exit 0
fi

if [ "$UNINSTALL" = "1" ]; then
  uninstall_system
  exit 0
fi

[ -n "$SERVER" ] && [ -n "$TOKEN" ] || {
  echo "--server and --token are required for install or upgrade." >&2
  usage
  exit 1
}
validate_common

case "$SERVICE_MODE" in
  systemd|openrc|launchctl) install_root_dependencies ;;
esac

prepare_binary

case "$SERVICE_MODE" in
  systemd) install_systemd ;;
  openrc) install_openrc ;;
  launchctl) install_launchctl ;;
  user) install_user_mode ;;
  *) die "Unsupported install mode: ${SERVICE_MODE}" ;;
esac
