#!/usr/bin/env bash
set -euo pipefail

SERVER=""
TOKEN=""
NODE_NAME="$(hostname)"
INTERVAL="3"
PING_INTERVAL="120"
TRAFFIC_RESET_DAY="1"
MODE="websocket"
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
CONTAINER_DISK_TOTAL_BYTES="0"
CONTAINER_DISK_TOTAL_SET="0"
DISK_USAGE_FILE=""
DISK_USAGE_FILE_SET="0"
DISK_USAGE_FILE_PRESENT="0"
NIC_INCLUDE=""
NIC_EXCLUDE=""
DISABLE_WEB_SSH="0"
DISABLE_AUTO_UPDATE="0"
IGNORE_UNSAFE_CERT="0"
PLATFORM_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

usage() {
  cat <<'EOF'
Usage:
  sudo ./install-linux.sh --server https://worker.example.com --token TOKEN [options]
  sudo ./install-linux.sh --uninstall [options]

Options:
  --server URL              Worker URL, required.
  --token TOKEN             Agent token from admin panel. Required.
  --name NAME               Node name, default: hostname.
  --interval SECONDS        Report interval, default: 3.
  --ping-interval SECONDS   Ping task poll interval, default: 120.
  --traffic-reset-day DAY   Monthly traffic reset day, default: 1.
  --mode MODE               websocket or http, default: websocket.
  --instance-id ID          Instance id used for default service and install directory.
  --install-dir DIR         Install directory, default: /opt/cf-vps-monitor/<instance-id>.
  --service-name NAME       systemd service name, default: cf-vps-monitor-agent-<instance-id>.
  --install-service-name NAME
                            Legacy alias for --service-name.
  --binary PATH             Existing agent binary.
  --binary-url URL          Download a prebuilt agent binary from this URL.
  --binary-base-url URL     Base URL containing architecture-specific prebuilt binaries.
  --checksum-url URL        SHA256SUMS URL for --binary-url verification.
  --release-tag TAG         GitHub release tag used for default binary downloads, default: latest published release.
  --build-from-source       Build from local source or GitHub source archive. Requires Go.
  --source-url URL          Source archive used with --build-from-source.
  --proxy URL               Proxy used for --binary-url downloads, for example http://127.0.0.1:10808.
  --mount-include LIST      Comma-separated mountpoint/device patterns included in disk totals.
  --mount-exclude LIST      Comma-separated mountpoint/device patterns excluded from disk totals.
  --container-disk-total-bytes BYTES
                            Container root allocation, 0 for automatic detection.
  --disk-usage-file PATH    Administrator disk cache; empty disables the companion.
  --nic-include LIST        Comma-separated network interface patterns included in traffic totals.
  --nic-exclude LIST        Comma-separated network interface patterns excluded from traffic totals.
  --disable-web-ssh         Accepted as a legacy no-op option.
  --disable-auto-update     Accepted as a legacy no-op option.
  --ignore-unsafe-cert      Accepted as a legacy no-op option.
  --install-ghproxy URL     Accepted as a legacy no-op option.
  --dry-run                 Print actions without changing the system.
  --uninstall               Stop and remove the systemd service and env file.
  --uninstall-all           Stop all cf-vps-monitor-agent* services and remove all installed agent files.
  --yes                     Confirm destructive --uninstall-all.
  --keep-files              With --uninstall, keep the install directory.
  -h, --help                Show help.
EOF
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

is_macos() {
  [[ "$PLATFORM_OS" == "darwin" ]]
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

normalize_proxy_url() {
  local name="$1"
  local value="${2%/}"
  if [[ -z "$value" ]]; then
    printf ''
    return
  fi
  if [[ ! "$value" =~ ^https?://([^/@[:space:]?#]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?(/[^[:space:]?#]*)?$ ]]; then
    echo "${name} must use an http:// or https:// URL without credentials, query, or fragment." >&2
    exit 1
  fi
  printf '%s' "$value"
}

require_https_url() {
  local name="$1"
  local url="$2"
  if [[ -n "$url" && ! "$url" =~ ^https:// ]]; then
    echo "${name} must use an https:// URL." >&2
    exit 1
  fi
}

with_github_proxy() {
  local url="$1"
  local proxy
  proxy="$(normalize_proxy_url "--install-ghproxy" "$INSTALL_GHPROXY")"
  if [[ -n "$proxy" ]]; then
    printf '%s/%s' "$proxy" "$url"
  else
    printf '%s' "$url"
  fi
}

download_file() {
  local url="$1"
  local output="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    if command -v curl >/dev/null 2>&1; then
      local curl_args=(-fsSL --retry 3 -o "$output")
      if [[ -n "$PROXY" ]]; then
        curl_args+=(--proxy "$PROXY")
      fi
      printf '[dry-run] curl'
      printf ' %q' "${curl_args[@]}" "$url"
      printf '\n'
    elif command -v wget >/dev/null 2>&1; then
      local wget_args=(-O "$output")
      if [[ -n "$PROXY" ]]; then
        wget_args+=(--execute "use_proxy=yes" --execute "http_proxy=$PROXY" --execute "https_proxy=$PROXY")
      fi
      printf '[dry-run] wget'
      printf ' %q' "${wget_args[@]}" "$url"
      printf '\n'
    else
      echo "[dry-run] download \"$url\" to \"$output\""
    fi
    return
  fi

  if command -v curl >/dev/null 2>&1; then
    local curl_args=(-fsSL --retry 3 -o "$output")
    if [[ -n "$PROXY" ]]; then
      curl_args+=(--proxy "$PROXY")
    fi
    curl "${curl_args[@]}" "$url"
  elif command -v wget >/dev/null 2>&1; then
    local wget_args=(-O "$output")
    if [[ -n "$PROXY" ]]; then
      wget_args+=(--execute "use_proxy=yes" --execute "http_proxy=$PROXY" --execute "https_proxy=$PROXY")
    fi
    wget "${wget_args[@]}" "$url"
  else
    echo "curl or wget is required to download files." >&2
    exit 1
  fi
}

resolve_build_dir() {
  if [[ -f "$SCRIPT_DIR/main.go" ]]; then
    printf '%s' "$SCRIPT_DIR"
    return
  fi

  local source_archive
  local source_dir
  source_archive="${SOURCE_ARCHIVE:-}"
  source_dir="${SOURCE_DIR:-}"
  if [[ -z "$source_archive" || -z "$source_dir" ]]; then
    source_archive="$(mktemp /tmp/cf-vps-monitor-source.XXXXXX.tar.gz)"
    source_dir="$(mktemp -d /tmp/cf-vps-monitor-source.XXXXXX)"
    SOURCE_ARCHIVE="$source_archive"
    SOURCE_DIR="$source_dir"
  fi

  local source_url="${SOURCE_URL:-https://github.com/${CF_MONITOR_REPOSITORY}/archive/refs/heads/${CF_MONITOR_BRANCH}.tar.gz}"
  source_url="$(with_github_proxy "$source_url")"
  download_file "$source_url" "$source_archive" >&2

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] tar -xzf \"$source_archive\" -C \"$source_dir\"" >&2
    printf '%s' "$source_dir/<detected-agent-directory>"
    return
  fi

  if ! command -v tar >/dev/null 2>&1; then
    echo "tar is required to extract the source archive." >&2
    exit 1
  fi

  tar -xzf "$source_archive" -C "$source_dir"
  local main_go
  main_go="$(find "$source_dir" -path '*/agent/main.go' -print -quit)"
  if [[ -z "$main_go" ]]; then
    echo "Cannot find agent/main.go in source archive: $source_url" >&2
    exit 1
  fi
  dirname "$main_go"
}

detect_binary_filename() {
  local os
  local arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m | tr '[:upper:]' '[:lower:]')"

  case "$os" in
    linux) os="linux" ;;
    darwin) os="darwin" ;;
    *) echo "Unsupported OS for prebuilt agent: $os" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported CPU architecture for prebuilt agent: $arch" >&2; exit 1 ;;
  esac

  printf 'cf-vps-monitor-agent-%s-%s' "$os" "$arch"
}

release_tag_is_safe() (
  LC_ALL=C; export LC_ALL
  release_value="$1"
  [ "${#release_value}" -le 128 ] || exit 1
  case "$release_value" in
    ''|[!A-Za-z0-9_]*|*[!A-Za-z0-9._+-]*|*..*|*.|*.lock) exit 1 ;;
  esac
  # Preserve safe legacy pins; '+' is supported for the release SemVer contract.
  case "$release_value" in *+*) ;; *) exit 0 ;; esac
  release_number='(0|[1-9][0-9]*)'
  release_prerelease='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][A-Za-z0-9-]*)'
  printf '%s\n' "$release_value" | grep -Eq "^v${release_number}\.${release_number}\.${release_number}(-${release_prerelease}(\.${release_prerelease})*)?(\+[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*)?$"
)

set_release_base() {
  if [[ -z "$CF_MONITOR_RELEASE_TAG" ]]; then
    CF_MONITOR_RELEASE_BASE="https://github.com/${CF_MONITOR_REPOSITORY}/releases/latest/download"
    return
  fi
  if ! release_tag_is_safe "$CF_MONITOR_RELEASE_TAG"; then
    echo "--release-tag must be a safe tag of at most 128 ASCII characters; build metadata requires vSemVer." >&2
    exit 1
  fi
  release_path="$(printf '%s' "$CF_MONITOR_RELEASE_TAG" | sed 's/+/%2B/g')"
  CF_MONITOR_RELEASE_BASE="https://github.com/${CF_MONITOR_REPOSITORY}/releases/download/${release_path}"
}

default_binary_url() {
  local filename
  local base="${BINARY_BASE_URL:-$CF_MONITOR_RELEASE_BASE}"
  filename="$(detect_binary_filename)" || exit 1
  printf '%s/%s' "${base%/}" "$filename"
}

default_checksum_url() {
  local base="${BINARY_BASE_URL:-$CF_MONITOR_RELEASE_BASE}"
  printf '%s/SHA256SUMS' "${base%/}"
}

verify_binary_checksum() {
  local binary="$1"
  local filename="$2"
  local checksum_url="$3"
  if [[ -z "$checksum_url" ]]; then
    return
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] verify SHA256SUMS for ${filename} from ${checksum_url}"
    return
  fi
  if ! command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum is required to verify downloaded agent binaries." >&2
    exit 1
  fi

  local sums_file expected actual
  sums_file="$(mktemp /tmp/cf-vps-monitor-agent-sha256.XXXXXX)"
  download_file "$checksum_url" "$sums_file"
  expected="$(awk -v f="$filename" '{name=$2; sub(/^\*/, "", name); sub(/^.*\//, "", name); if (name == f) { print tolower($1); exit }}' "$sums_file")"
  rm -f "$sums_file"
  if [[ -z "$expected" ]]; then
    echo "Cannot find ${filename} in SHA256SUMS from ${checksum_url}." >&2
    exit 1
  fi
  actual="$(sha256sum "$binary" | awk '{ print tolower($1) }')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum verification failed for ${filename}." >&2
    echo "Expected: ${expected}" >&2
    echo "Actual:   ${actual}" >&2
    exit 1
  fi
}

# Keep this block identical in the standalone legacy installer. No marker is executed.
agent_safety_helpers() {
  cat <<'CF_AGENT_SAFETY'
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

agent_service_name_is_safe() (
  LC_ALL=C
  export LC_ALL
  case "$1" in
    ''|.|..|-*|*[!A-Za-z0-9_.@-]*) return 1 ;;
  esac
  return 0
)

systemd_path() {
  printf '%s' "$1" | sed 's/%/%%/g'
}

systemd_word() {
  printf '%s' "$1" | awk '
    BEGIN { printf "\"" }
    { for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1);
        if (c == "\\") printf "\\\\";
        else if (c == "\"") printf "\\\"";
        else if (c == "%") printf "%%%%";
        else printf "%s", c;
      }
    }
    END { printf "\"" }'
}

systemd_exec() {
  # systemd rejects quotes/backslashes in its executable path after unquoting.
  # Keep that path fixed; sh exec preserves the Agent PID and treats $0 literally.
  printf '%s %s' ":/bin/sh -c 'exec \"\$0\" \"\$@\"'" "$(systemd_word "$1")"
}

systemd_env_quote() {
  printf '%s' "$1" | awk '
    BEGIN { printf "\"" }
    { for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1);
        if (c == "\\" || c == "\"" || c == "$" || c == "`") printf "\\%s", c;
        else printf "%s", c;
      }
    }
    END { printf "\"" }'
}

xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

cron_shell_quote() {
  # End the quoted fragment before each percent so a preceding literal
  # backslash cannot consume cron's percent escape.
  shell_quote "$1" | awk '{ for (i = 1; i <= length($0); i++) {
    c = substr($0, i, 1); if (c == "%") printf "\047\\%%\047"; else printf "%s", c;
  } }'
}

agent_config_line() {
  grep -Fqx -- "$2" "$1" || grep -Fqx -- "$3" "$1"
}

agent_systemd_path_decode() {
  awk '{
    decoded = "";
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1);
      if (c == "%") {
        if (substr($0, ++i, 1) != "%") exit 1;
      }
      decoded = decoded c;
    }
    print decoded;
  }'
}

agent_shell_unquote() {
  # Decode only the literal form emitted by shell_quote, without sourcing a file.
  printf '%s\n' "$1" | awk '{
    q = sprintf("%c", 39); escape = q sprintf("%c", 92) q q;
    if (length($0) < 2 || substr($0, 1, 1) != q || substr($0, length($0), 1) != q) exit 1;
    decoded = "";
    for (i = 2; i < length($0); i++) {
      c = substr($0, i, 1);
      if (c == q) {
        if (substr($0, i, 4) != escape) exit 1;
        i += 3;
      }
      decoded = decoded c;
    }
    print decoded;
  }'
}

agent_resource_directory() (
  case "$SERVICE_MODE" in
    systemd)
      [ "$(grep -c '^WorkingDirectory=' "$1")" = 1 ] || exit 1
      sed -n 's/^WorkingDirectory=//p' "$1" | agent_systemd_path_decode ;;
    openrc)
      [ "$(grep -c '^directory=' "$1")" = 1 ] || exit 1
      encoded="$(sed -n 's/^directory=//p' "$1")"
      case "$encoded" in
        \"*\") printf '%s\n' "$encoded" | sed 's/^"//; s/"$//' ;;
        *)
          decoded="$(agent_shell_unquote "$encoded")" || exit 1
          [ "$(shell_quote "$decoded")" = "$encoded" ] || exit 1
          printf '%s\n' "$decoded" ;;
      esac ;;
    launchctl) /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$1" 2>/dev/null ;;
    *) exit 1 ;;
  esac
)

agent_safety_error() { printf '%s\n' "Unsafe Agent instance: $*" >&2; return 1; }

agent_normalize_path() (
  path_value="$1"
  case "$path_value" in
    *'
'*|*"$(printf '\r')"*) agent_safety_error 'paths cannot contain line breaks'; exit 1 ;;
    /*) ;;
    [A-Za-z]:/*)
      case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) agent_safety_error 'an absolute Unix path is required'; exit 1 ;; esac ;;
    *) agent_safety_error 'an absolute path is required'; exit 1 ;;
  esac
  printf '%s\n' "$path_value" | awk '
    { prefix = substr($0, 1, 1) == "/" ? "/" : substr($0, 1, 3);
      rest = substr($0, length(prefix) + 1); count = split(rest, parts, "/"); depth = 0;
      for (i = 1; i <= count; i++) {
        if (parts[i] == "" || parts[i] == ".") continue;
        if (parts[i] == "..") { if (depth > 0) depth--; continue; }
        stack[++depth] = parts[i];
      }
      printf "%s", prefix;
      for (i = 1; i <= depth; i++) printf "%s%s", (i > 1 ? "/" : ""), stack[i];
      printf "\n";
    }'
)

agent_reject_links() (
  link_path="$1"
  while [ -n "$link_path" ]; do
    [ ! -L "$link_path" ] || { agent_safety_error "symbolic link in $1"; exit 1; }
    parent_path="$(dirname "$link_path")"
    [ "$parent_path" != "$link_path" ] || break
    link_path="$parent_path"
  done
)

agent_legacy_owned() (
  [ -f "$INSTALL_DIR/cf-vps-monitor-agent" ] || exit 1
  case "$SERVICE_MODE" in
    user)
      [ -f "$INSTALL_DIR/.cf-vps-monitor-instance" ] && [ ! -L "$INSTALL_DIR/.cf-vps-monitor-instance" ] || exit 1
      [ "$(sed -n '1p' "$INSTALL_DIR/.cf-vps-monitor-instance")" = "$BASE_ID" ] &&
        [ "$(sed -n '2p' "$INSTALL_DIR/.cf-vps-monitor-instance")" = "$ENV_FILE" ] &&
        [ "$(sed -n '3p' "$INSTALL_DIR/.cf-vps-monitor-instance")" = "$STATE_DIR" ] || exit 1
      [ -f "$STATE_DIR/install-dir" ] && [ "$(cat "$STATE_DIR/install-dir")" = "$INSTALL_DIR" ] || exit 1
      [ -f "$ENV_FILE" ] && [ -f "$INSTALL_DIR/run-agent.sh" ] && [ -f "$INSTALL_DIR/stop.sh" ] || exit 1
      grep -Fqx -- ". $(shell_quote "$ENV_FILE")" "$INSTALL_DIR/run-agent.sh" || exit 1
      ;;
    systemd)
      [ -f "$UNIT_FILE" ] && [ ! -L "$UNIT_FILE" ] && [ -f "$ENV_FILE" ] || exit 1
      grep -Fqx 'Description=CF VPS Monitor Agent' "$UNIT_FILE" &&
        agent_config_line "$UNIT_FILE" "WorkingDirectory=$INSTALL_DIR" "WorkingDirectory=$(systemd_path "$INSTALL_DIR/")" &&
        agent_config_line "$UNIT_FILE" "EnvironmentFile=$ENV_FILE" "EnvironmentFile=$(systemd_path "$ENV_FILE")" || exit 1
      [ "$(grep -c '^ExecStart=' "$UNIT_FILE")" = 1 ] || exit 1
      grep -Fq -- "ExecStart=$INSTALL_DIR/cf-vps-monitor-agent --interval " "$UNIT_FILE" ||
        grep -Fq -- "ExecStart=$(systemd_exec "$INSTALL_DIR/cf-vps-monitor-agent") --interval " "$UNIT_FILE" || exit 1
      ;;
    openrc)
      [ -f "$INIT_FILE" ] && [ ! -L "$INIT_FILE" ] && [ -f "$ENV_FILE" ] || exit 1
      grep -Fqx 'name="CF VPS Monitor Agent"' "$INIT_FILE" &&
        agent_config_line "$INIT_FILE" "command=\"$INSTALL_DIR/cf-vps-monitor-agent\"" "command=$(shell_quote "$INSTALL_DIR/cf-vps-monitor-agent")" &&
        agent_config_line "$INIT_FILE" "directory=\"$INSTALL_DIR\"" "directory=$(shell_quote "$INSTALL_DIR")" || exit 1
      ;;
    launchctl)
      [ -f "$PLIST_FILE" ] && [ ! -L "$PLIST_FILE" ] && [ -f "$RUNNER_FILE" ] || exit 1
      agent_config_line "$PLIST_FILE" "  <string>$SERVICE_NAME</string>" "  <string>$(xml_escape "$SERVICE_NAME")</string>" &&
        agent_config_line "$PLIST_FILE" "    <string>$RUNNER_FILE</string>" "    <string>$(xml_escape "$RUNNER_FILE")</string>" &&
        agent_config_line "$PLIST_FILE" "  <string>$INSTALL_DIR</string>" "  <string>$(xml_escape "$INSTALL_DIR")</string>" || exit 1
      ;;
    *) exit 1 ;;
  esac
)

agent_marker_owned() (
  owned_marker="$INSTALL_DIR/.cf-vps-monitor-owned"
  [ -f "$owned_marker" ] && [ ! -L "$owned_marker" ] || exit 1
  [ "$(sed -n '1p' "$owned_marker")" = 'cf-vps-monitor-agent:1' ] &&
    [ "$(sed -n '2p' "$owned_marker")" = "$BASE_ID" ] &&
    [ "$(sed -n '3p' "$owned_marker")" = "$SERVICE_MODE" ] &&
    [ "$(sed -n '4p' "$owned_marker")" = "$SERVICE_NAME" ] &&
    [ "$(sed -n '5p' "$owned_marker")" = "$INSTALL_DIR" ] &&
    [ "$(sed -n '6p' "$owned_marker")" = "$ENV_FILE" ] &&
    [ "$(sed -n '7p' "$owned_marker")" = "$STATE_DIR" ]
)

agent_assert_instance() {
  agent_service_name_is_safe "$SERVICE_NAME" || { agent_safety_error 'invalid service name'; return 1; }
  agent_reject_links "$INSTALL_DIR" || return 1
  INSTALL_DIR="$(agent_normalize_path "$INSTALL_DIR")" || return 1
  case "$INSTALL_DIR" in /|/bin|/sbin|/lib|/lib64|/etc|/usr|/usr/local|/opt|/var|/var/lib|/home|/root|/tmp|/run|/srv|/opt/cf-vps-monitor|/usr/local/cf-vps-monitor)
    agent_safety_error 'shared or protected directory'; return 1 ;; esac
  for protected_path in "$HOME" \
    "${XDG_DATA_HOME:-$HOME/.local/share}" "${XDG_CONFIG_HOME:-$HOME/.config}" "${XDG_STATE_HOME:-$HOME/.local/state}" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/cf-vps-monitor" "${XDG_CONFIG_HOME:-$HOME/.config}/cf-vps-monitor" "${XDG_STATE_HOME:-$HOME/.local/state}/cf-vps-monitor"; do
    [ "$INSTALL_DIR" != "$(agent_normalize_path "$protected_path")" ] || { agent_safety_error 'shared or protected directory'; return 1; }
  done
  case "$INSTALL_DIR" in /etc/*|/bin/*|/sbin/*|/lib/*|/lib64/*|/usr/bin/*|/usr/sbin/*|[A-Za-z]:/)
    agent_safety_error 'system directory'; return 1 ;; esac
  agent_reject_links "$INSTALL_DIR" || return 1
  [ ! -e "$INSTALL_DIR" ] || [ -d "$INSTALL_DIR" ] || { agent_safety_error 'not a directory'; return 1; }
  if [ -n "$ENV_FILE" ]; then
    agent_reject_links "$ENV_FILE" || return 1
    ENV_FILE="$(agent_normalize_path "$ENV_FILE")" || return 1
  fi
  agent_reject_links "$STATE_DIR" || return 1
  STATE_DIR="$(agent_normalize_path "$STATE_DIR")" || return 1
  RUNNER_FILE="$INSTALL_DIR/run-agent.sh"
  if [ -d "$INSTALL_DIR" ]; then
    linked_entry="$(find "$INSTALL_DIR" -type l -print -quit)" || return 1
    [ -z "$linked_entry" ] || { agent_safety_error 'linked descendant'; return 1; }
    entries="$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit)" || return 1
  else entries=''; fi
  owns_existing=0
  if [ "$1" = 1 ] || [ -n "$entries" ]; then
    if [ -e "$INSTALL_DIR/.cf-vps-monitor-owned" ]; then
      agent_marker_owned || { agent_safety_error 'instance marker does not match'; return 1; }
    else
      agent_legacy_owned || { agent_safety_error 'existing directory has no matching instance ownership'; return 1; }
    fi
    owns_existing=1
  fi
  if [ "$owns_existing" = 0 ]; then
    if [ -n "$ENV_FILE" ] && [ -e "$ENV_FILE" ]; then agent_safety_error 'unowned configuration path'; return 1; fi
    if [ -e "$STATE_DIR" ]; then
      [ -d "$STATE_DIR" ] || { agent_safety_error 'unowned state path'; return 1; }
      state_entries="$(find "$STATE_DIR" -mindepth 1 -maxdepth 1 -print -quit)" || return 1
      [ -z "$state_entries" ] || { agent_safety_error 'unowned state path'; return 1; }
    fi
  fi
  resource_file=''
  case "$SERVICE_MODE" in systemd) resource_file="$UNIT_FILE" ;; openrc) resource_file="$INIT_FILE" ;; launchctl) resource_file="$PLIST_FILE" ;; esac
  if [ -n "$resource_file" ] && { [ -e "$resource_file" ] || [ -L "$resource_file" ]; }; then
    agent_reject_links "$resource_file" || return 1
    agent_legacy_owned || { agent_safety_error 'service configuration belongs to another instance'; return 1; }
  fi
}

agent_write_marker() {
  write_file "$INSTALL_DIR/.cf-vps-monitor-owned" 600 "$(printf '%s\n' 'cf-vps-monitor-agent:1' "$BASE_ID" "$SERVICE_MODE" "$SERVICE_NAME" "$INSTALL_DIR" "$ENV_FILE" "$STATE_DIR")"
}

agent_disk_total_valid() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 16 ] && awk -v value="$1" 'BEGIN { exit !(value + 0 <= 1000000000000000) }'
}

agent_disk_file_valid() {
  [ "${#1}" -le 4096 ] || return 1
  case "$1" in
    *'
'*|*"$(printf '\r')"*) return 1 ;;
    ''|/*) return 0 ;;
    *) return 1 ;;
  esac
}

agent_disk_config_value() (
  # Read only these nonsecret assignments as data. Never execute the old file.
  encoded="$(awk -v key="$2" '
    { line = $0; sub(/^[ \t]*export[ \t]+/, "", line);
      if (index(line, key "=") == 1) { value = substr(line, length(key) + 2); found = 1; }
    }
    END { if (!found || length(value) > 8192) exit 1; print value }' "$1")" || exit 1
  case "$encoded" in
    \'*) agent_shell_unquote "$encoded" ;;
    \"*) printf '%s\n' "$encoded" | awk '
      { if (length($0) < 2 || substr($0, length($0), 1) != "\"") exit 1;
        value = "";
        for (i = 2; i < length($0); i++) {
          c = substr($0, i, 1);
          if (c == "\\") {
            c = substr($0, ++i, 1);
            if (i >= length($0) || (c != "\\" && c != "\"" && c != "$" && c != "`")) exit 1;
          } else if (c == "\"" || c == "$" || c == "`") exit 1;
          value = value c;
        }
        print value;
      }' ;;
    *)
      printf '%s\n' "$encoded" | LC_ALL=C grep -Eq '^([0-9]+|/[A-Za-z0-9_./@%+,=-]*)$' || exit 1
      printf '%s\n' "$encoded" ;;
  esac
)

agent_load_disk_options() {
  disk_old_config="${ENV_FILE:-$RUNNER_FILE}"
  if [ -f "$disk_old_config" ] && [ ! -L "$disk_old_config" ]; then
    if [ "${CONTAINER_DISK_TOTAL_SET:-0}" = 0 ]; then
      if disk_old_value="$(agent_disk_config_value "$disk_old_config" CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES)" && agent_disk_total_valid "$disk_old_value"; then
        CONTAINER_DISK_TOTAL_BYTES="$disk_old_value"
      fi
    fi
    if [ "${DISK_USAGE_FILE_SET:-0}" = 0 ]; then
      if disk_old_value="$(agent_disk_config_value "$disk_old_config" CF_MONITOR_DISK_USAGE_FILE)" && agent_disk_file_valid "$disk_old_value"; then
        DISK_USAGE_FILE="$disk_old_value"
        DISK_USAGE_FILE_PRESENT=1
      fi
    fi
  fi
  agent_disk_total_valid "${CONTAINER_DISK_TOTAL_BYTES:-0}" || { printf '%s\n' '--container-disk-total-bytes must be an integer from 0 to 1000000000000000.' >&2; return 1; }
  agent_disk_file_valid "${DISK_USAGE_FILE:-}" || { printf '%s\n' '--disk-usage-file must be empty or an absolute path without line breaks.' >&2; return 1; }
}

agent_root_path_safe() (
  disk_path="$1"
  while :; do
    [ -e "$disk_path" ] && [ ! -L "$disk_path" ] || exit 1
    set -- $(stat -c '%u %a' "$disk_path")
    [ "$#" = 2 ] && [ "$1" = 0 ] || exit 1
    case "$2" in ''|*[!0-7]*) exit 1 ;; esac
    [ "$((0$2 & 0022))" = 0 ] || exit 1
    disk_parent="$(dirname "$disk_path")" || exit 1
    [ "$disk_parent" != "$disk_path" ] || break
    disk_path="$disk_parent"
  done
)

agent_disk_service_paths() {
  DISK_SERVICE_NAME="$SERVICE_NAME-disk-usage"
  DISK_CACHE_DIR="/run/cf-vps-monitor-disk/$SERVICE_NAME"
  case "$SERVICE_MODE" in
    systemd) DISK_SERVICE_FILE="${UNIT_FILE%.service}-disk-usage.service" ;;
    openrc) DISK_SERVICE_FILE="$INIT_FILE-disk-usage" ;;
    *) DISK_SERVICE_FILE='' ;;
  esac
}

agent_disk_service_owned() {
  [ -f "$DISK_SERVICE_FILE" ] && agent_root_path_safe "$DISK_SERVICE_FILE" &&
    [ "$(stat -c %h "$DISK_SERVICE_FILE")" = 1 ] &&
    grep -Fqx '# cf-vps-monitor-disk-usage:1' "$DISK_SERVICE_FILE" &&
    grep -Fqx "# service: $SERVICE_NAME" "$DISK_SERVICE_FILE" &&
    grep -Fqx "# install: $INSTALL_DIR" "$DISK_SERVICE_FILE"
}

agent_stop_disk_collector() {
  agent_disk_service_paths
  DISK_COLLECTOR_BLOCKED=0
  [ -n "$DISK_SERVICE_FILE" ] || return 0
  if [ -e "$DISK_SERVICE_FILE" ] || [ -L "$DISK_SERVICE_FILE" ]; then
    if ! agent_disk_service_owned; then
      printf '%s\n' "Disk collector disabled: unowned service $DISK_SERVICE_NAME was left unchanged." >&2
      DISK_COLLECTOR_BLOCKED=1
      return 0
    fi
    case "$SERVICE_MODE" in
      systemd) run systemctl disable --now "$DISK_SERVICE_NAME" || return 1 ;;
      openrc)
        run rc-service "$DISK_SERVICE_NAME" stop || return 1
        disk_default_services="$(run rc-update show default)" || return 1
        if printf '%s\n' "$disk_default_services" | awk -v service="$DISK_SERVICE_NAME" '$1 == service { found=1 } END { exit !found }'; then
          run rc-update del "$DISK_SERVICE_NAME" default || return 1
        fi ;;
    esac
  fi
}

agent_disk_openrc_content() {
  cat <<EOF
#!/sbin/openrc-run
# cf-vps-monitor-disk-usage:1
# service: $SERVICE_NAME
# install: $INSTALL_DIR
name="CF VPS Monitor Disk Usage"
description="Local container file allocation collector"
command=$(shell_quote "$INSTALL_DIR/cf-vps-monitor-agent")
command_args=$(shell_quote "--disk-usage-collector $(shell_quote "$SERVICE_NAME") --mount-include $(shell_quote "$MOUNT_INCLUDE") --mount-exclude $(shell_quote "$MOUNT_EXCLUDE") --container-disk-total-bytes $CONTAINER_DISK_TOTAL_BYTES")
command_user="root:root"
command_background=true
start_stop_daemon_args="--wait 1000"
pidfile="/run/\${RC_SVCNAME}.pid"
directory="/"
output_log="/var/log/\${RC_SVCNAME}.log"
error_log="/var/log/\${RC_SVCNAME}.log"

start_pre() {
  _cf_disk_log="\$output_log"
  while :; do
    [ ! -L "\$_cf_disk_log" ] || { eerror "Refusing linked disk collector log"; return 1; }
    _cf_disk_parent="\$(dirname "\$_cf_disk_log")" || return 1
    [ "\$_cf_disk_parent" != "\$_cf_disk_log" ] || break
    _cf_disk_log="\$_cf_disk_parent"
  done
  if [ -e "\$output_log" ] && { [ ! -f "\$output_log" ] || [ "\$(stat -c %h "\$output_log")" != 1 ]; }; then
    eerror "Refusing non-regular disk collector log"
    return 1
  fi
  checkpath -f -m 0600 -o root:root "\$output_log" || return 1
}
EOF
}

agent_prepare_disk_collector() {
  DISK_COLLECTOR_ENABLED=0
  agent_disk_service_paths
  [ -n "$DISK_SERVICE_FILE" ] && [ "${OS_NAME:-${PLATFORM_OS:-}}" = linux ] && [ "$(id -u)" = 0 ] || return 0
  [ "${DISK_COLLECTOR_BLOCKED:-0}" = 0 ] || return 0
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' '[dry-run] check whether a protected container disk collector is needed'
    return 0
  fi
  case "$SERVICE_MODE" in
    systemd) [ -d /run/systemd/system ] && [ "$(cat /proc/1/comm 2>/dev/null)" = systemd ] || return 0 ;;
    openrc) [ -x /sbin/openrc-run ] && [ -f /run/openrc/softlevel ] || return 0 ;;
  esac
  if [ "${DISK_USAGE_FILE_SET:-0}" = 1 ] || [ "${DISK_USAGE_FILE_PRESENT:-0}" = 1 ]; then
    [ "$DISK_USAGE_FILE" = "$DISK_CACHE_DIR/usage.json" ] || return 0
  fi
  if ! agent_root_path_safe "$INSTALL_DIR/cf-vps-monitor-agent" ||
    [ ! -f "$INSTALL_DIR/cf-vps-monitor-agent" ] || [ "$(stat -c %h "$INSTALL_DIR/cf-vps-monitor-agent")" != 1 ]; then
    printf '%s\n' 'Disk collector disabled: binary and every parent directory must be root-owned and not writable by ordinary users.' >&2
    return 0
  fi
  if ! agent_root_path_safe "$(dirname "$DISK_SERVICE_FILE")"; then
    printf '%s\n' 'Disk collector disabled: unsafe service directory.' >&2
    return 0
  fi
  if env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$INSTALL_DIR/cf-vps-monitor-agent" --disk-usage-check --mount-include "$MOUNT_INCLUDE" --mount-exclude "$MOUNT_EXCLUDE" --container-disk-total-bytes "$CONTAINER_DISK_TOTAL_BYTES"; then
    :
  else
    disk_check_status=$?
    [ "$disk_check_status" = 3 ] || printf '%s\n' "Disk collector unavailable: scope check failed (exit $disk_check_status)." >&2
    return 0
  fi
  case "$SERVICE_MODE" in
    systemd)
      write_file "$DISK_SERVICE_FILE" 644 "$(cat <<EOF
# cf-vps-monitor-disk-usage:1
# service: $SERVICE_NAME
# install: $INSTALL_DIR
[Unit]
Description=CF VPS Monitor Disk Usage

[Service]
Type=exec
User=root
Group=root
ExecStart=$(systemd_exec "$INSTALL_DIR/cf-vps-monitor-agent") --disk-usage-collector $(systemd_word "$SERVICE_NAME") --mount-include $(systemd_word "$MOUNT_INCLUDE") --mount-exclude $(systemd_word "$MOUNT_EXCLUDE") --container-disk-total-bytes $CONTAINER_DISK_TOTAL_BYTES
Restart=on-failure
RestartSec=30
Nice=19
IOSchedulingClass=best-effort
IOSchedulingPriority=7
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
)" || return 1 ;;
    openrc) write_file "$DISK_SERVICE_FILE" 755 "$(agent_disk_openrc_content)" || return 1 ;;
  esac
  # The needed probe selected only root. The main systemd namespace can add
  # state bind mounts, so make its otherwise-default selection explicit.
  [ -n "$MOUNT_INCLUDE" ] || MOUNT_INCLUDE='/'
  DISK_USAGE_FILE="$DISK_CACHE_DIR/usage.json"
  DISK_COLLECTOR_ENABLED=1
}

agent_start_disk_collector() {
  [ "${DISK_COLLECTOR_ENABLED:-0}" = 1 ] || return 0
  case "$SERVICE_MODE" in
    systemd)
      if run systemctl enable "$DISK_SERVICE_NAME" && run systemctl restart "$DISK_SERVICE_NAME" && run systemctl is-active --quiet "$DISK_SERVICE_NAME"; then return 0; fi ;;
    openrc)
      if run rc-update add "$DISK_SERVICE_NAME" default && run rc-service "$DISK_SERVICE_NAME" restart; then return 0; fi ;;
  esac
  printf '%s\n' "Disk collector failed to start: $DISK_SERVICE_NAME. The Agent remains installed; disk usage is unavailable without a valid cache." >&2
  agent_stop_disk_collector || return 1
}

agent_remove_disk_collector() {
  [ "${OS_NAME:-${PLATFORM_OS:-}}" = linux ] && [ "$(id -u)" = 0 ] || return 0
  agent_stop_disk_collector || return 1
  [ -n "$DISK_SERVICE_FILE" ] && [ "${DISK_COLLECTOR_BLOCKED:-0}" = 0 ] || return 0
  if [ -e "$DISK_SERVICE_FILE" ]; then run rm -f "$DISK_SERVICE_FILE" || return 1; fi
  if [ -e "$DISK_CACHE_DIR" ] || [ -L "$DISK_CACHE_DIR" ]; then
    if [ ! -d "$DISK_CACHE_DIR" ] || ! agent_root_path_safe "$DISK_CACHE_DIR"; then
      printf '%s\n' 'Disk collector cache was left unchanged: unsafe cache directory.' >&2
      return 0
    fi
    for disk_cache_file in "$DISK_CACHE_DIR/usage.json" "$DISK_CACHE_DIR/scan.lock" "$DISK_CACHE_DIR"/.usage-*.tmp; do
      [ -e "$disk_cache_file" ] || [ -L "$disk_cache_file" ] || continue
      case "${disk_cache_file##*/}" in
        usage.json|scan.lock) ;;
        *) printf '%s\n' "${disk_cache_file##*/}" | LC_ALL=C grep -Eq '^\.usage-[0-9a-f]{24}\.tmp$' || continue ;;
      esac
      if [ ! -f "$disk_cache_file" ] || [ "$(stat -c %h "$disk_cache_file")" != 1 ] || ! agent_root_path_safe "$disk_cache_file"; then
        printf '%s\n' "Disk collector cache file was left unchanged: $disk_cache_file" >&2
        continue
      fi
      run rm -f "$disk_cache_file" || return 1
    done
    # Unknown files and other instances are retained, never recursively deleted.
    run rmdir "$DISK_CACHE_DIR" 2>/dev/null || :
  fi
}

agent_remove_owned_system() {
  agent_assert_instance 1 || return 1
  agent_remove_disk_collector || return 1
  case "$SERVICE_MODE" in
    systemd)
      run systemctl disable --now "$SERVICE_NAME" || return 1
      run rm -f "$UNIT_FILE" "$ENV_FILE" || return 1
      run systemctl daemon-reload || return 1 ;;
    openrc)
      run rc-service "$SERVICE_NAME" stop || return 1
      run rc-update del "$SERVICE_NAME" default || return 1
      run rm -f "$INIT_FILE" "$ENV_FILE" || return 1 ;;
    launchctl)
      run launchctl bootout system "$PLIST_FILE" || return 1
      run rm -f "$PLIST_FILE" || return 1 ;;
    *) agent_safety_error 'unknown system service mode'; return 1 ;;
  esac
  if [ "$KEEP_FILES" != 1 ]; then run rm -rf "$INSTALL_DIR" || return 1; fi
  printf '%s\n' "Uninstalled $SERVICE_NAME."
}

agent_remove_prefixed_system_instances() (
  # Names are user configurable. Enumerate resources, then require exact ownership.
  case "$SERVICE_MODE" in
    systemd) set -- /etc/systemd/system/*.service ;;
    openrc) set -- /etc/init.d/* ;;
    launchctl) set -- /Library/LaunchDaemons/*.plist ;;
    *) exit 1 ;;
  esac
  discovered=0; completed=0; skipped=0; failed=0
  for resource in "$@"; do
    [ -e "$resource" ] || [ -L "$resource" ] || continue
    if [ ! -f "$resource" ] || [ -L "$resource" ]; then skipped=$((skipped + 1)); continue; fi
    if (
      case "$SERVICE_MODE" in
        systemd)
          SERVICE_NAME="$(basename "$resource" .service)"; UNIT_FILE="$resource"; ENV_FILE="/etc/$SERVICE_NAME.env"
          ;;
        openrc)
          SERVICE_NAME="$(basename "$resource")"; INIT_FILE="$resource"; ENV_FILE="/etc/conf.d/$SERVICE_NAME"
          ;;
        launchctl)
          SERVICE_NAME="$(basename "$resource" .plist)"; PLIST_FILE="$resource"; ENV_FILE=''
          ;;
      esac
      INSTALL_DIR="$(agent_resource_directory "$resource")" || exit 2
      BASE_ID="$(printf '%s' "$SERVICE_NAME" | sed 's/^cf-vps-monitor-agent-//')"
      if [ -f "$INSTALL_DIR/.cf-vps-monitor-owned" ]; then BASE_ID="$(sed -n '2p' "$INSTALL_DIR/.cf-vps-monitor-owned")"; fi
      STATE_DIR="$INSTALL_DIR/state"; RUNNER_FILE="$INSTALL_DIR/run-agent.sh"
      if ! agent_assert_instance 1; then printf '%s\n' "Skipping unowned service: $SERVICE_NAME" >&2; exit 2; fi
      if agent_remove_owned_system; then exit 0; fi
      printf '%s\n' "Failed to uninstall owned service: $SERVICE_NAME" >&2
      exit 1
    ); then
      discovered=$((discovered + 1)); completed=$((completed + 1))
    else
      result=$?
      if [ "$result" = 2 ]; then skipped=$((skipped + 1))
      else discovered=$((discovered + 1)); failed=$((failed + 1)); fi
    fi
  done
  printf 'Agent uninstall summary: discovered=%s completed=%s skipped=%s failed=%s\n' "$discovered" "$completed" "$skipped" "$failed"
  [ "$failed" = 0 ]
)
CF_AGENT_SAFETY
}
eval "$(agent_safety_helpers)"

sanitize_instance_id() {
  local raw="${1:-}"
  local cleaned
  cleaned="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_.-]+/-/g; s/^-+//; s/-+$//')"
  if [[ -z "$cleaned" ]]; then
    cleaned="default"
  fi
  case "$cleaned" in .|..) echo "--instance-id must not be a dot directory segment." >&2; return 1 ;; esac
  printf '%s' "${cleaned:0:48}"
}

apply_instance_defaults() {
  local base
  base="$(sanitize_instance_id "${INSTANCE_ID:-default}")" || return 1
  BASE_ID="$base"
  if [[ -z "$SERVICE_NAME" ]]; then
    SERVICE_NAME="cf-vps-monitor-agent-${base}"
  fi
  if [[ -z "$INSTALL_DIR" ]]; then
    if is_macos; then
      INSTALL_DIR="/usr/local/cf-vps-monitor/${base}"
    else
      INSTALL_DIR="/opt/cf-vps-monitor/${base}"
    fi
  fi
}

uninstall_all_agents() {
  [[ "$YES" == "1" ]] || { echo '--uninstall-all requires --yes.' >&2; return 1; }
  if is_macos; then SERVICE_MODE=launchctl; else SERVICE_MODE=systemd; fi
  agent_remove_prefixed_system_instances || return 1
}

write_file() {
  local path="$1"
  local mode="$2"
  local content="$3"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] write ${path} (${mode})"
  else
    printf '%s\n' "$content" > "$path"
    chmod "$mode" "$path"
  fi
}

ensure_agent_user() {
  local user="cf-vps-monitor-agent"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] ensure system user ${user}"
    return
  fi
  if id -u "$user" >/dev/null 2>&1; then
    return
  fi
  if ! command -v useradd >/dev/null 2>&1; then
    echo "useradd is required to create the ${user} service account." >&2
    exit 1
  fi
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group "$user"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--server) SERVER="${2:-}"; shift 2 ;;
    -t|--token) TOKEN="${2:-}"; shift 2 ;;
    -n|--name) NODE_NAME="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --ping-interval) PING_INTERVAL="${2:-}"; shift 2 ;;
    -r|--traffic-reset-day) TRAFFIC_RESET_DAY="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    -i|--instance-id) INSTANCE_ID="${2:-}"; shift 2 ;;
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
    --container-disk-total-bytes) CONTAINER_DISK_TOTAL_BYTES="${2:-}"; CONTAINER_DISK_TOTAL_SET=1; shift 2 ;;
    --disk-usage-file) DISK_USAGE_FILE="${2:-}"; DISK_USAGE_FILE_SET=1; shift 2 ;;
    --nic-include) NIC_INCLUDE="${2:-}"; shift 2 ;;
    --nic-exclude) NIC_EXCLUDE="${2:-}"; shift 2 ;;
    --disable-web-ssh) DISABLE_WEB_SSH="1"; shift ;;
    --disable-auto-update) DISABLE_AUTO_UPDATE="1"; shift ;;
    --ignore-unsafe-cert) IGNORE_UNSAFE_CERT="1"; shift ;;
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

if [[ "$DRY_RUN" != "1" && "$(id -u)" -ne 0 ]]; then
  echo "Please run as root, for example: sudo ./install-linux.sh ..." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "1" && ! is_macos ]] && ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required for this installer." >&2
  exit 1
fi

if [[ "$UNINSTALL_ALL" == "1" ]]; then
  uninstall_all_agents
  exit 0
fi

apply_instance_defaults

if ! agent_service_name_is_safe "$SERVICE_NAME"; then
  echo "--service-name must be a safe name using A-Z, a-z, 0-9, dot, underscore, dash, or @; it cannot be a dot segment or start with a dash." >&2
  exit 1
fi

if [[ -z "$INSTALL_DIR" || "$INSTALL_DIR" == "/" ]]; then
  echo "--install-dir cannot be empty or /." >&2
  exit 1
fi

ENV_FILE="/etc/${SERVICE_NAME}.env"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
PLIST_FILE="/Library/LaunchDaemons/${SERVICE_NAME}.plist"
RUNNER_FILE="${INSTALL_DIR}/run-agent.sh"
STATE_DIR="${INSTALL_DIR}/state"
if is_macos; then SERVICE_MODE=launchctl; ENV_FILE=""; else SERVICE_MODE=systemd; fi
agent_assert_instance "$UNINSTALL" || exit 1

if [[ "$UNINSTALL" == "1" ]]; then
  agent_remove_owned_system || exit 1
  exit 0
fi

if [[ -z "$SERVER" || -z "$TOKEN" ]]; then
  echo "--server and --token are required for install or upgrade." >&2
  usage
  exit 1
fi

if [[ "$MODE" != "websocket" && "$MODE" != "http" ]]; then
  echo "--mode must be websocket or http." >&2
  exit 1
fi

agent_load_disk_options || exit 1

if ! [[ "$TRAFFIC_RESET_DAY" =~ ^[0-9]+$ ]] || (( TRAFFIC_RESET_DAY < 1 || TRAFFIC_RESET_DAY > 31 )); then
  echo "--traffic-reset-day must be a number from 1 to 31." >&2
  exit 1
fi

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
WORK_BIN=""

if [[ -n "$BINARY" && ( -n "$BINARY_URL" || "$BUILD_FROM_SOURCE" == "1" ) ]]; then
  echo "Use only one of --binary, --binary-url, or --build-from-source." >&2
  exit 1
fi

if [[ -n "$BINARY_URL" && "$BUILD_FROM_SOURCE" == "1" ]]; then
  echo "Use only one of --binary-url or --build-from-source." >&2
  exit 1
fi

if [[ -n "$BINARY_URL" ]]; then
  require_https_url "--binary-url" "$BINARY_URL"
fi

if [[ -n "$BINARY_BASE_URL" ]]; then
  require_https_url "--binary-base-url" "$BINARY_BASE_URL"
fi

if [[ -n "$CHECKSUM_URL" ]]; then
  require_https_url "--checksum-url" "$CHECKSUM_URL"
fi

if [[ -n "$SOURCE_URL" ]]; then
  require_https_url "--source-url" "$SOURCE_URL"
fi

PROXY="$(normalize_proxy_url "--proxy" "$PROXY")"
INSTALL_GHPROXY="$(normalize_proxy_url "--install-ghproxy" "$INSTALL_GHPROXY")"

if [[ -n "$BINARY" ]]; then
  if [[ ! -f "$BINARY" ]]; then
    echo "Binary not found: $BINARY" >&2
    exit 1
  fi
  WORK_BIN="$BINARY"
else
  if [[ -z "$BINARY_URL" && "$BUILD_FROM_SOURCE" != "1" ]]; then
    DEFAULT_BINARY_URL="$(default_binary_url)" || exit 1
    if [[ -n "$BINARY_BASE_URL" ]]; then
      BINARY_URL="$DEFAULT_BINARY_URL"
      CHECKSUM_URL="${CHECKSUM_URL:-$(default_checksum_url)}"
    else
      if ! BINARY_URL="$(with_github_proxy "$DEFAULT_BINARY_URL")"; then
        exit 1
      fi
      CHECKSUM_URL="$(with_github_proxy "$(default_checksum_url)")"
    fi
    AUTO_BINARY_URL="1"
  fi
fi

if [[ -n "$BINARY_URL" ]]; then
  if [[ -z "$CHECKSUM_URL" && "$AUTO_BINARY_URL" != "1" ]]; then
    echo "Custom --binary-url requires --checksum-url for SHA256 verification." >&2
    exit 1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    WORK_BIN="/tmp/cf-vps-monitor-agent.dry-run"
    download_file "$BINARY_URL" "$WORK_BIN"
  else
    WORK_BIN="$(mktemp /tmp/cf-vps-monitor-agent.XXXXXX)"
    if download_file "$BINARY_URL" "$WORK_BIN"; then
      verify_binary_checksum "$WORK_BIN" "$(basename "$BINARY_URL")" "$CHECKSUM_URL"
      chmod 0755 "$WORK_BIN"
    elif [[ "$AUTO_BINARY_URL" == "1" ]]; then
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

if [[ -z "$WORK_BIN" && "$BUILD_FROM_SOURCE" == "1" ]]; then
  if [[ "$DRY_RUN" != "1" ]] && ! command -v go >/dev/null 2>&1; then
    echo "Go is required to build the agent from source after the prebuilt binary was unavailable. Install Go, publish release assets, or pass --binary-url." >&2
    exit 1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    WORK_BIN="/tmp/cf-vps-monitor-agent.dry-run"
    BUILD_DIR="$(resolve_build_dir)"
    echo "[dry-run] cd \"$BUILD_DIR\" && go build -trimpath -ldflags=\"-s -w\" -o \"$WORK_BIN\" ."
  else
    WORK_BIN="$(mktemp /tmp/cf-vps-monitor-agent.XXXXXX)"
    BUILD_DIR="$(resolve_build_dir)"
    (cd "$BUILD_DIR" && go build -trimpath -ldflags="-s -w" -o "$WORK_BIN" .)
  fi
fi

if ! is_macos; then
  agent_load_disk_options || exit 1
  agent_stop_disk_collector || exit 1
  ensure_agent_user
fi
run mkdir -p "$INSTALL_DIR"
run install -m 0755 "$WORK_BIN" "$INSTALL_DIR/cf-vps-monitor-agent"
agent_prepare_disk_collector || exit 1
run mkdir -p "$STATE_DIR"
if ! is_macos; then
  run chown -R cf-vps-monitor-agent:cf-vps-monitor-agent "$STATE_DIR"
fi

reject_env_value() {
  local name="$1"
  local value="$2"
  case "$value" in
    *$'\n'*|*$'\r'*)
      echo "--${name} must not contain newlines" >&2
      exit 1
      ;;
  esac
}

reject_env_value "server" "$SERVER"
reject_env_value "token" "$TOKEN"
reject_env_value "name" "$NODE_NAME"
reject_env_value "mode" "$MODE"
reject_env_value "mount-include" "$MOUNT_INCLUDE"
reject_env_value "mount-exclude" "$MOUNT_EXCLUDE"
reject_env_value "nic-include" "$NIC_INCLUDE"
reject_env_value "nic-exclude" "$NIC_EXCLUDE"
reject_env_value "traffic-reset-day" "$TRAFFIC_RESET_DAY"

if is_macos; then
  if [[ "$DRY_RUN" != "1" ]] && ! command -v launchctl >/dev/null 2>&1; then
    echo "launchctl is required for macOS installation." >&2
    exit 1
  fi

  RUNNER_CONTENT=$(cat <<EOF
#!/usr/bin/env bash
set -e
export CF_MONITOR_SERVER=$(shell_quote "$SERVER")
export CF_MONITOR_TOKEN=$(shell_quote "$TOKEN")
export CF_MONITOR_NAME=$(shell_quote "$NODE_NAME")
export CF_MONITOR_MODE=$(shell_quote "$MODE")
export CF_MONITOR_MOUNT_INCLUDE=$(shell_quote "$MOUNT_INCLUDE")
export CF_MONITOR_MOUNT_EXCLUDE=$(shell_quote "$MOUNT_EXCLUDE")
export CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES=$(shell_quote "$CONTAINER_DISK_TOTAL_BYTES")
export CF_MONITOR_DISK_USAGE_FILE=$(shell_quote "$DISK_USAGE_FILE")
export CF_MONITOR_NIC_INCLUDE=$(shell_quote "$NIC_INCLUDE")
export CF_MONITOR_NIC_EXCLUDE=$(shell_quote "$NIC_EXCLUDE")
export CF_MONITOR_TRAFFIC_RESET_DAY=$(shell_quote "$TRAFFIC_RESET_DAY")
export CF_MONITOR_TRAFFIC_STATE_FILE=$(shell_quote "${STATE_DIR}/traffic-state.json")
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
  <string>$(xml_escape "$SERVICE_NAME")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$RUNNER_FILE")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$INSTALL_DIR")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "/var/log/$SERVICE_NAME.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "/var/log/$SERVICE_NAME.log")</string>
</dict>
</plist>
EOF
)
  write_file "$PLIST_FILE" "644" "$PLIST_CONTENT"
  agent_write_marker
  run launchctl bootout system "$PLIST_FILE" || true
  run launchctl bootstrap system "$PLIST_FILE"
  echo "Installed ${SERVICE_NAME}."
  echo "Status: launchctl print system/${SERVICE_NAME}"
  echo "Logs:   tail -f /var/log/${SERVICE_NAME}.log"
  exit 0
fi

ENV_CONTENT=$(cat <<EOF
CF_MONITOR_SERVER=$(systemd_env_quote "$SERVER")
CF_MONITOR_TOKEN=$(systemd_env_quote "$TOKEN")
CF_MONITOR_NAME=$(systemd_env_quote "$NODE_NAME")
CF_MONITOR_MODE=$(systemd_env_quote "$MODE")
CF_MONITOR_MOUNT_INCLUDE=$(systemd_env_quote "$MOUNT_INCLUDE")
CF_MONITOR_MOUNT_EXCLUDE=$(systemd_env_quote "$MOUNT_EXCLUDE")
CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES=$(systemd_env_quote "$CONTAINER_DISK_TOTAL_BYTES")
CF_MONITOR_DISK_USAGE_FILE=$(systemd_env_quote "$DISK_USAGE_FILE")
CF_MONITOR_NIC_INCLUDE=$(systemd_env_quote "$NIC_INCLUDE")
CF_MONITOR_NIC_EXCLUDE=$(systemd_env_quote "$NIC_EXCLUDE")
CF_MONITOR_TRAFFIC_RESET_DAY=$(systemd_env_quote "$TRAFFIC_RESET_DAY")
CF_MONITOR_TRAFFIC_STATE_FILE=$(systemd_env_quote "$STATE_DIR/traffic-state.json")
EOF
)
write_file "$ENV_FILE" "600" "$ENV_CONTENT"

UNIT_CONTENT=$(cat <<EOF
[Unit]
Description=CF VPS Monitor Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cf-vps-monitor-agent
Group=cf-vps-monitor-agent
EnvironmentFile=$(systemd_path "$ENV_FILE")
WorkingDirectory=$(systemd_path "$INSTALL_DIR/")
ExecStart=$(systemd_exec "$INSTALL_DIR/cf-vps-monitor-agent") --interval ${INTERVAL} --ping-interval ${PING_INTERVAL} --traffic-reset-day ${TRAFFIC_RESET_DAY}
Restart=always
RestartSec=5
# Allow ICMP ping for the unprivileged service user without granting broad root privileges.
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
ReadWritePaths=$(systemd_word "$STATE_DIR")

[Install]
WantedBy=multi-user.target
EOF
)
write_file "$UNIT_FILE" "644" "$UNIT_CONTENT"
agent_write_marker

run systemctl daemon-reload
run systemctl enable "$SERVICE_NAME"
run systemctl restart "$SERVICE_NAME"
agent_start_disk_collector || exit 1

echo "Installed ${SERVICE_NAME}."
echo "Status: systemctl status ${SERVICE_NAME}"
echo "Logs:   journalctl -u ${SERVICE_NAME} -f"
