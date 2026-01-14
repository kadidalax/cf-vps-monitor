#!/bin/bash

# cf-vps-monitor - Cloudflare Worker VPS监控脚本
# 版本: 1.1.0
# 支持所有常见Linux系统，无需root权限

set -euo pipefail

# 初始化系统类型变量
OS=$(uname -s)
export OS

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 全局变量 - 集中式文件管理
SCRIPT_DIR="$HOME/.cf-vps-monitor"
CONFIG_FILE="$SCRIPT_DIR/config/config"
LOG_FILE="$SCRIPT_DIR/logs/monitor.log"
PID_FILE="$SCRIPT_DIR/run/monitor.pid"
SERVICE_FILE="$SCRIPT_DIR/bin/vps-monitor-service.sh"
INSTALL_MANIFEST="$SCRIPT_DIR/system/install.manifest"

# 默认配置
DEFAULT_INTERVAL=10
DEFAULT_WORKER_URL=""
DEFAULT_SERVER_ID=""
DEFAULT_API_KEY=""

# 打印带颜色的消息
print_message() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

# 日志函数（环境适配）
log() {
    local message="$1"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $message" >> "$LOG_FILE"

    # 只在非服务模式下输出到控制台（避免重复日志）
    if [[ "${SERVICE_MODE:-false}" != "true" ]]; then
        echo "[$timestamp] $message"
    fi
}

# 错误处理
error_exit() {
    local message="$1"
    print_message "$RED" "错误: $message"
    log "ERROR: $message"
    exit 1
}

# 检查命令是否存在
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# ==================== 系统兼容性层 ====================

# 检测systemd可用性
is_systemd_available() {
    command_exists systemctl && systemctl --version >/dev/null 2>&1
}

# 检测用户级systemd可用性
is_user_systemd_available() {
    if is_root_user; then
        is_systemd_available
    else
        is_systemd_available && \
        [[ -n "${XDG_RUNTIME_DIR:-}" ]] && \
        systemctl --user --version >/dev/null 2>&1
    fi
}

# 跨平台sed命令
safe_sed() {
    local pattern="$1"
    local file="$2"
    if [[ "$OS" == "FreeBSD" ]] || [[ "$OS" == "Darwin" ]]; then
        sed -i '' "$pattern" "$file" 2>/dev/null || true
    else
        sed -i "$pattern" "$file" 2>/dev/null || true
    fi
}

# 安全的systemctl命令
safe_systemctl() {
    if is_systemd_available; then
        systemctl "$@" 2>/dev/null || true
    else
        return 1
    fi
}

# 检查系统资源（防止fork错误）
check_system_resources() {
    # 检查进程数限制（特别针对FreeBSD）
    local max_proc=$(ulimit -u 2>/dev/null || echo "1024")
    local current_proc=$(ps aux 2>/dev/null | wc -l || echo "100")

    if [[ $current_proc -gt $((max_proc * 80 / 100)) ]]; then
        print_message "$YELLOW" "警告: 进程数接近限制 ($current_proc/$max_proc)"
        if [[ "$OS" == "FreeBSD" ]]; then
            print_message "$CYAN" "FreeBSD建议: 增加用户进程限制或稍后重试"
        fi
        return 1
    fi
    return 0
}

# 验证PID有效性
validate_pid() {
    local pid="$1"
    [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$pid" != "$$" ]] && kill -0 "$pid" 2>/dev/null
}

# 获取进程命令行（FreeBSD兼容）
get_process_command() {
    local pid="$1"

    if [[ "$OS" == "FreeBSD" ]]; then
        # FreeBSD兼容语法
        ps -p "$pid" -o command 2>/dev/null | tail -n +2 | head -1 || echo "unknown"
    else
        # Linux标准语法
        ps -p "$pid" -o cmd= 2>/dev/null || echo "unknown"
    fi
}

# 统一的监控进程检测函数（精确检测）
find_monitor_processes() {
    local pids=""

    # 层次1: PID文件检测（最可靠）
    if [[ -f "$PID_FILE" ]]; then
        local file_pid=$(cat "$PID_FILE" 2>/dev/null)
        if validate_pid "$file_pid"; then
            pids="$file_pid"
        fi
    fi

    # 层次2: 精确脚本路径匹配
    if [[ -z "$pids" ]] && [[ -f "${SERVICE_FILE:-}" ]]; then
        if [[ "$OS" == "FreeBSD" ]]; then
            pids=$(ps axww | grep "$SERVICE_FILE" | grep -v grep | awk '{print $1}')
        else
            pids=$(ps aux | grep "$SERVICE_FILE" | grep -v grep | awk '{print $2}')
        fi
    fi

    # 层次3: 验证所有PID并确认命令行
    local valid_pids=""
    for pid in $pids; do
        if validate_pid "$pid"; then
            local cmd=$(get_process_command "$pid")
            # 确认命令行确实包含我们的脚本
            if [[ "$cmd" =~ (vps-monitor-service|cf-vps-monitor) ]]; then
                valid_pids="$valid_pids $pid"
            fi
        fi
    done

    echo "$valid_pids" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//'
}

# 检查监控服务是否运行
is_monitor_running() {
    local pids=$(find_monitor_processes)
    [[ -n "$pids" ]]
}

# 获取用户类型描述
get_user_type_description() {
    if is_root_user; then
        echo "系统管理员"
    else
        echo "普通用户"
    fi
}

# 简洁的监控服务诊断
diagnose_monitor_service() {
    print_message "$CYAN" "=== 监控服务诊断 ==="

    # 检查关键文件
    print_message "$BLUE" "文件状态:"
    [[ -f "$SERVICE_FILE" ]] && print_message "$GREEN" "  ✓ 服务脚本存在" || print_message "$RED" "  ✗ 服务脚本不存在"
    [[ -f "$CONFIG_FILE" ]] && print_message "$GREEN" "  ✓ 配置文件存在" || print_message "$RED" "  ✗ 配置文件不存在"
    [[ -d "$(dirname "$LOG_FILE")" ]] && print_message "$GREEN" "  ✓ 日志目录存在" || print_message "$RED" "  ✗ 日志目录不存在"

    # 显示相关进程（FreeBSD优化）
    print_message "$BLUE" "相关进程:"
    if [[ "$OS" == "FreeBSD" ]]; then
        local processes=$(ps axww | grep -E "(monitor|vps)" | grep -v grep | grep -v diagnose)
    else
        local processes=$(ps aux | grep -E "(monitor|vps)" | grep -v grep | grep -v diagnose)
    fi

    if [[ -n "$processes" ]]; then
        echo "$processes"
    else
        print_message "$YELLOW" "  无相关进程"
    fi

    print_message "$CYAN" "===================="
}

# 移除所有自启动设置
remove_autostart_settings() {
    print_message "$BLUE" "移除自启动设置..."

    local removed_count=0

    # 1. 移除systemd服务
    local service_path
    if is_root_user; then
        service_path="/etc/systemd/system/cf-vps-monitor.service"
    else
        service_path="$HOME/.config/systemd/user/cf-vps-monitor.service"
    fi

    if [[ -f "$service_path" ]] && is_systemd_available; then
        local systemd_cmd="systemctl"
        [[ ! $(is_root_user) ]] && systemd_cmd="systemctl --user"

        $systemd_cmd stop cf-vps-monitor.service 2>/dev/null || true
        $systemd_cmd disable cf-vps-monitor.service 2>/dev/null || true
        rm -f "$service_path"
        $systemd_cmd daemon-reload 2>/dev/null || true
        print_message "$GREEN" "  ✓ systemd服务已移除"
        removed_count=$((removed_count + 1))
    fi

    # 2. 移除crontab条目
    if command_exists crontab; then
        local current_crontab=$(crontab -l 2>/dev/null || echo "")
        if echo "$current_crontab" | grep -q "cf-vps-monitor"; then
            echo "$current_crontab" | grep -v "cf-vps-monitor" | crontab - 2>/dev/null
            print_message "$GREEN" "  ✓ crontab自启动已移除"
            removed_count=$((removed_count + 1))
        fi
    fi

    # 3. 移除shell profile自启动（FreeBSD兼容）
    local profile_files=(".bashrc" ".bash_profile" ".profile")
    for profile in "${profile_files[@]}"; do
        local profile_path="$HOME/$profile"
        if [[ -f "$profile_path" ]] && grep -q "cf-vps-monitor auto-start" "$profile_path" 2>/dev/null; then
            # FreeBSD兼容的sed语法
            if [[ "$OS" == "FreeBSD" ]] || [[ "$OS" == "Darwin" ]]; then
                sed -i '' '/# === cf-vps-monitor auto-start BEGIN ===/,/# === cf-vps-monitor auto-start END ===/d' "$profile_path" 2>/dev/null
            else
                sed -i '/# === cf-vps-monitor auto-start BEGIN ===/,/# === cf-vps-monitor auto-start END ===/d' "$profile_path" 2>/dev/null
            fi
            print_message "$GREEN" "  ✓ 已从 $profile 移除自启动代码"
            removed_count=$((removed_count + 1))
            break
        fi
    done

    # 显示结果
    if [[ $removed_count -gt 0 ]]; then
        print_message "$GREEN" "✓ 已移除 $removed_count 种自启动设置"
    else
        print_message "$YELLOW" "未找到需要移除的自启动设置"
    fi
}

# 添加自启动设置
add_autostart_settings() {
    print_message "$BLUE" "配置自启动设置..."

    local added_count=0

    # 1. 尝试配置systemd服务
    local service_path
    if is_root_user; then
        service_path="/etc/systemd/system/cf-vps-monitor.service"
    else
        service_path="$HOME/.config/systemd/user/cf-vps-monitor.service"
    fi

    if is_systemd_available && [[ ! -f "$service_path" ]]; then
        # 创建服务目录
        mkdir -p "$(dirname "$service_path")" 2>/dev/null

        # 创建systemd服务文件
        cat > "$service_path" << EOF
[Unit]
Description=CF VPS Monitor Service
After=network.target

[Service]
Type=simple
ExecStart=$SERVICE_FILE
Restart=always
RestartSec=10
User=$USER
WorkingDirectory=$HOME

[Install]
WantedBy=default.target
EOF

        local systemd_cmd="systemctl"
        [[ ! $(is_root_user) ]] && systemd_cmd="systemctl --user"

        $systemd_cmd daemon-reload 2>/dev/null || true
        $systemd_cmd enable cf-vps-monitor.service 2>/dev/null || true
        print_message "$GREEN" "  ✓ systemd服务已配置"
        added_count=$((added_count + 1))
    fi

    # 2. 配置crontab自启动
    if command_exists crontab; then
        local current_crontab=$(crontab -l 2>/dev/null || echo "")
        if ! echo "$current_crontab" | grep -q "cf-vps-monitor"; then
            local crontab_entry="@reboot sleep 30 && pgrep -f 'cf-vps-monitor|vps-monitor-service' >/dev/null || $SERVICE_FILE"
            (echo "$current_crontab"; echo "$crontab_entry") | crontab - 2>/dev/null
            print_message "$GREEN" "  ✓ crontab自启动已配置"
            added_count=$((added_count + 1))
        fi
    fi

    # 3. 配置shell profile自启动
    local profile="$HOME/.bashrc"
    if [[ -f "$profile" ]] && ! grep -q "cf-vps-monitor auto-start" "$profile" 2>/dev/null; then
        cat >> "$profile" << EOF
# === cf-vps-monitor auto-start BEGIN ===
# VPS监控服务自启动检测 (最后保障)
if [ -n "\$PS1" ] && [ "\$TERM" != "dumb" ]; then
    if ! pgrep -f 'cf-vps-monitor|vps-monitor-service' >/dev/null 2>&1; then
        (sleep 5 && nohup "$SERVICE_FILE" >/dev/null 2>&1 &) &
    fi
fi
# === cf-vps-monitor auto-start END ===
EOF
        print_message "$GREEN" "  ✓ shell profile自启动已配置"
        added_count=$((added_count + 1))
    fi

    # 显示结果
    if [[ $added_count -gt 0 ]]; then
        print_message "$GREEN" "✓ 已配置 $added_count 种自启动设置"
    else
        print_message "$YELLOW" "自启动设置已存在，无需重复配置"
    fi
}

# 统一的命令接口
get_system_command() {
    local cmd_type="$1"
    local fallback="${2:-}"

    case "$cmd_type" in
        "memory_info")
            if [[ "$OS" == "FreeBSD" ]] || [[ "$OS" == "OpenBSD" ]] || [[ "$OS" == "NetBSD" ]]; then
                echo "sysctl"
            elif [[ -f /proc/meminfo ]]; then
                echo "proc"
            elif command_exists free; then
                echo "free"
            else
                echo "$fallback"
            fi
            ;;
        "disk_usage")
            if command_exists df; then
                echo "df"
            elif command_exists du; then
                echo "du"
            else
                echo "$fallback"
            fi
            ;;
        "network_stats")
            if [[ -f /proc/net/dev ]]; then
                echo "proc"
            elif command_exists netstat; then
                echo "netstat"
            elif command_exists ss; then
                echo "ss"
            else
                echo "$fallback"
            fi
            ;;
        "process_info")
            if command_exists ps; then
                echo "ps"
            elif [[ -d /proc ]]; then
                echo "proc"
            else
                echo "$fallback"
            fi
            ;;
        "cpu_info")
            if [[ "$OS" == "FreeBSD" ]] || [[ "$OS" == "OpenBSD" ]] || [[ "$OS" == "NetBSD" ]]; then
                echo "sysctl"
            elif [[ -f /proc/stat ]]; then
                echo "proc"
            elif command_exists top; then
                echo "top"
            elif command_exists vmstat; then
                echo "vmstat"
            else
                echo "$fallback"
            fi
            ;;
        *)
            echo "$fallback"
            ;;
    esac
}

# 跨平台的命令执行
execute_system_command() {
    local cmd_type="$1"
    local command_method="$2"
    shift 2
    local args=("$@")

    case "$cmd_type:$command_method" in
        "memory_info:sysctl")
            sysctl vm.stats.vm 2>/dev/null || sysctl hw.physmem hw.usermem 2>/dev/null
            ;;
        "memory_info:proc")
            cat /proc/meminfo 2>/dev/null
            ;;
        "memory_info:free")
            free -b 2>/dev/null || free 2>/dev/null
            ;;
        "disk_usage:df")
            df -B1 "${args[@]}" 2>/dev/null || df "${args[@]}" 2>/dev/null
            ;;
        "network_stats:proc")
            cat /proc/net/dev 2>/dev/null
            ;;
        "network_stats:netstat")
            netstat -i 2>/dev/null
            ;;
        "cpu_info:sysctl")
            sysctl kern.cp_time 2>/dev/null
            ;;
        "cpu_info:proc")
            cat /proc/stat 2>/dev/null
            ;;
        "cpu_info:top")
            timeout 3 top -bn1 2>/dev/null | head -10
            ;;
        "cpu_info:vmstat")
            timeout 3 vmstat 1 2 2>/dev/null | tail -1
            ;;
        *)
            return 1
            ;;
    esac
}

# 检测系统信息（优化版 - 减少fork操作）
detect_system() {
    # 一次性获取系统基本信息（减少fork）
    local system_info=$(uname -srm)
    IFS=' ' read -r OS KERNEL_VERSION ARCH <<< "$system_info"

    # FreeBSD特殊优化（避免不必要的检测）
    if [[ "$OS" == "FreeBSD" ]]; then
        IS_CONTAINER="false"
        CONTAINER_TYPE="none"
        VIRTUALIZATION="none"
        VER=$(echo "$KERNEL_VERSION" | cut -d'-' -f1)
        DISTRO_ID="freebsd"
        DISTRO_NAME="FreeBSD"
        print_message "$GREEN" "检测到系统: FreeBSD $VER"
    elif [[ "$OS" == "Darwin" ]]; then
        IS_CONTAINER="false"
        CONTAINER_TYPE="none"
        VIRTUALIZATION="none"
        VER=$(sw_vers -productVersion 2>/dev/null || echo "$KERNEL_VERSION")
        DISTRO_ID="macos"
        DISTRO_NAME="macOS"
        print_message "$GREEN" "检测到系统: macOS $VER"
    else
        # Linux系统的简化检测
        IS_CONTAINER="false"
        CONTAINER_TYPE="none"
        VIRTUALIZATION="none"

        # 简化的容器检测（只检查明显标志）
        if [[ -f /.dockerenv ]]; then
            IS_CONTAINER="true"
            CONTAINER_TYPE="docker"
        fi

        # 简化的发行版检测
        if [[ -f /etc/os-release ]]; then
            local os_info=$(cat /etc/os-release 2>/dev/null)
            DISTRO_ID=$(echo "$os_info" | grep '^ID=' | cut -d= -f2 | tr -d '"' || echo "linux")
            VER=$(echo "$os_info" | grep '^VERSION_ID=' | cut -d= -f2 | tr -d '"' || echo "unknown")
            DISTRO_NAME=$(echo "$os_info" | grep '^NAME=' | cut -d= -f2 | tr -d '"' || echo "Linux")
        else
            DISTRO_ID="linux"
            VER="unknown"
            DISTRO_NAME="Linux"
        fi

        print_message "$GREEN" "检测到系统: $DISTRO_NAME $VER"
    fi

    # 确保变量在全局可用
    export OS ARCH KERNEL_VERSION VER DISTRO_ID DISTRO_NAME
    export IS_CONTAINER CONTAINER_TYPE VIRTUALIZATION
}

# 检测包管理器（增强版）
detect_package_manager() {
    PKG_MANAGER=""
    PKG_INSTALL=""
    PKG_UPDATE=""
    PKG_SEARCH=""
    PKG_INFO=""

    # 根据系统类型和发行版检测包管理器
    case "$OS" in
        FreeBSD|OpenBSD|NetBSD)
            if command_exists pkg; then
                PKG_MANAGER="pkg"
                PKG_INSTALL="pkg install -y"
                PKG_UPDATE="pkg update"
                PKG_SEARCH="pkg search"
                PKG_INFO="pkg info"
            elif command_exists pkg_add && [[ "$OS" == "OpenBSD" ]]; then
                PKG_MANAGER="pkg_add"
                PKG_INSTALL="pkg_add"
                PKG_UPDATE="pkg_add -u"
                PKG_SEARCH="pkg_info -Q"
                PKG_INFO="pkg_info"
            fi
            ;;
        Darwin)
            if command_exists brew; then
                PKG_MANAGER="brew"
                PKG_INSTALL="brew install"
                PKG_UPDATE="brew update"
                PKG_SEARCH="brew search"
                PKG_INFO="brew info"
            elif command_exists port; then
                PKG_MANAGER="port"
                PKG_INSTALL="port install"
                PKG_UPDATE="port selfupdate"
                PKG_SEARCH="port search"
                PKG_INFO="port info"
            fi
            ;;
        Linux|*)
            # 按优先级和发行版特性检测包管理器
            if command_exists apt-get; then
                PKG_MANAGER="apt-get"
                PKG_INSTALL="apt-get install -y"
                PKG_UPDATE="apt-get update"
                PKG_SEARCH="apt-cache search"
                PKG_INFO="apt-cache show"
            elif command_exists apt; then
                PKG_MANAGER="apt"
                PKG_INSTALL="apt install -y"
                PKG_UPDATE="apt update"
                PKG_SEARCH="apt search"
                PKG_INFO="apt show"
            elif command_exists dnf; then
                PKG_MANAGER="dnf"
                PKG_INSTALL="dnf install -y"
                PKG_UPDATE="dnf update -y"
                PKG_SEARCH="dnf search"
                PKG_INFO="dnf info"
            elif command_exists yum; then
                PKG_MANAGER="yum"
                PKG_INSTALL="yum install -y"
                PKG_UPDATE="yum update -y"
                PKG_SEARCH="yum search"
                PKG_INFO="yum info"
            elif command_exists zypper; then
                PKG_MANAGER="zypper"
                PKG_INSTALL="zypper install -y"
                PKG_UPDATE="zypper refresh"
                PKG_SEARCH="zypper search"
                PKG_INFO="zypper info"
            elif command_exists pacman; then
                PKG_MANAGER="pacman"
                PKG_INSTALL="pacman -S --noconfirm"
                PKG_UPDATE="pacman -Sy"
                PKG_SEARCH="pacman -Ss"
                PKG_INFO="pacman -Si"
            elif command_exists apk; then
                PKG_MANAGER="apk"
                PKG_INSTALL="apk add"
                PKG_UPDATE="apk update"
                PKG_SEARCH="apk search"
                PKG_INFO="apk info"
            elif command_exists emerge; then
                PKG_MANAGER="emerge"
                PKG_INSTALL="emerge"
                PKG_UPDATE="emerge --sync"
                PKG_SEARCH="emerge --search"
                PKG_INFO="emerge --info"
            elif command_exists xbps-install; then
                PKG_MANAGER="xbps"
                PKG_INSTALL="xbps-install -y"
                PKG_UPDATE="xbps-install -S"
                PKG_SEARCH="xbps-query -Rs"
                PKG_INFO="xbps-query -R"
            elif command_exists swupd; then
                PKG_MANAGER="swupd"
                PKG_INSTALL="swupd bundle-add"
                PKG_UPDATE="swupd update"
                PKG_SEARCH="swupd search"
                PKG_INFO="swupd bundle-info"
            elif command_exists nix-env; then
                PKG_MANAGER="nix"
                PKG_INSTALL="nix-env -i"
                PKG_UPDATE="nix-channel --update"
                PKG_SEARCH="nix-env -qa"
                PKG_INFO="nix-env -qa --description"
            elif command_exists snap; then
                PKG_MANAGER="snap"
                PKG_INSTALL="snap install"
                PKG_UPDATE="snap refresh"
                PKG_SEARCH="snap find"
                PKG_INFO="snap info"
            elif command_exists flatpak; then
                PKG_MANAGER="flatpak"
                PKG_INSTALL="flatpak install -y"
                PKG_UPDATE="flatpak update -y"
                PKG_SEARCH="flatpak search"
                PKG_INFO="flatpak info"
            fi
            ;;
    esac

    if [[ -n "$PKG_MANAGER" ]]; then
        print_message "$GREEN" "检测到包管理器: $PKG_MANAGER"
    else
        print_message "$YELLOW" "警告: 未检测到支持的包管理器，将尝试手动安装依赖"
    fi

    # 导出变量供其他函数使用
    export PKG_MANAGER PKG_INSTALL PKG_UPDATE PKG_SEARCH PKG_INFO
}

# 检查并安装依赖（无需root权限的方法）
install_dependencies() {
    print_message "$BLUE" "检查系统依赖..."
    
    local missing_deps=()
    
    # 检查必需的命令
    if ! command_exists curl; then
        missing_deps+=("curl")
    fi
    
    if ! command_exists bc; then
        missing_deps+=("bc")
    fi
    
    # 检查可选的命令
    local optional_missing=()
    if ! command_exists ifstat; then
        optional_missing+=("ifstat")
    fi
    if ! command_exists jq; then
        optional_missing+=("jq")
    fi

    # 报告可选依赖状态
    if [[ ${#optional_missing[@]} -gt 0 ]]; then
        print_message "$YELLOW" "可选依赖未安装: ${optional_missing[*]}"
        print_message "$YELLOW" "这些依赖缺失不会影响基本功能，但可能限制某些特性"
    fi

    if [[ ${#missing_deps[@]} -eq 0 ]]; then
        print_message "$GREEN" "所有必需依赖已安装"
        return 0
    fi

    print_message "$YELLOW" "缺少必需依赖: ${missing_deps[*]}"

    # 根据不同发行版调整包名
    local adjusted_deps=()
    for dep in "${missing_deps[@]}"; do
        case "$dep" in
            "bc")
                if [[ "$DISTRO_ID" == "alpine" ]]; then
                    adjusted_deps+=("bc")
                else
                    adjusted_deps+=("bc")
                fi
                ;;
            "curl")
                adjusted_deps+=("curl")
                ;;
            *)
                adjusted_deps+=("$dep")
                ;;
        esac
    done

    # 尝试安装依赖
    if [[ -n "$PKG_MANAGER" ]]; then
        if command_exists sudo && sudo -n true 2>/dev/null; then
            print_message "$BLUE" "尝试使用sudo安装依赖..."
            # 先更新包列表（对于某些包管理器）
            if [[ "$PKG_MANAGER" == "apt-get" ]] || [[ "$PKG_MANAGER" == "apt" ]]; then
                sudo $PKG_UPDATE
            fi

            for dep in "${adjusted_deps[@]}"; do
                print_message "$BLUE" "安装 $dep..."
                if ! sudo $PKG_INSTALL "$dep"; then
                    print_message "$YELLOW" "警告: 无法安装 $dep"
                fi
            done
        else
            print_message "$YELLOW" "需要sudo权限安装依赖，请手动执行:"
            print_message "$CYAN" "  sudo $PKG_INSTALL ${adjusted_deps[*]}"
        fi
    else
        print_message "$YELLOW" "未检测到包管理器，请手动安装依赖"
        print_message "$CYAN" "常见安装命令:"
        print_message "$CYAN" "  Ubuntu/Debian: sudo apt-get install ${adjusted_deps[*]}"
        print_message "$CYAN" "  CentOS/RHEL: sudo yum install ${adjusted_deps[*]}"
        print_message "$CYAN" "  Fedora: sudo dnf install ${adjusted_deps[*]}"
        print_message "$CYAN" "  Alpine: sudo apk add ${adjusted_deps[*]}"
    fi

    # 简化的依赖检查
    if ! command_exists curl && ! command_exists wget; then
        print_message "$RED" "错误: curl和wget都不可用"
        print_message "$CYAN" "请安装curl或wget后重试"
        return 1
    fi

    if ! command_exists bc; then
        print_message "$YELLOW" "警告: bc未安装，某些计算功能可能受限"
    fi
    
    print_message "$GREEN" "依赖检查完成"
}





# 创建集中式目录结构
create_directories() {
    print_message "$BLUE" "创建集中式目录结构..."

    # 创建主目录和子目录
    mkdir -p "$SCRIPT_DIR"/{bin,config,logs,tmp,cache,run,system/{templates,backups}} || error_exit "无法创建目录结构"

    # 创建安装清单文件
    touch "$INSTALL_MANIFEST"

    # 设置临时目录环境变量
    export TMPDIR="$SCRIPT_DIR/tmp"

    print_message "$GREEN" "✓ 集中式目录结构创建完成"
    print_message "$CYAN" "  主目录: $SCRIPT_DIR"
}

# 加载配置
load_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        source "$CONFIG_FILE"
    else
        WORKER_URL=$(echo "$DEFAULT_WORKER_URL" | tr -d ' \n\r')
        SERVER_ID=$(echo "$DEFAULT_SERVER_ID" | tr -d ' \n\r')
        API_KEY=$(echo "$DEFAULT_API_KEY" | tr -d ' \n\r')
        INTERVAL="$DEFAULT_INTERVAL"
    fi
}

# 记录安装项到安装清单
record_installation() {
    local type="$1"    # 文件类型
    local path="$2"    # 文件路径
    local action="$3"  # 执行的操作
    local backup="$4"  # 备份信息

    echo "$type:$path:$action:$backup" >> "$INSTALL_MANIFEST"
}

# 保存配置
save_config() {
    # 确保保存前清理空白字符
    WORKER_URL=$(echo "$WORKER_URL" | tr -d ' \n\r')
    SERVER_ID=$(echo "$SERVER_ID" | tr -d ' \n\r')
    API_KEY=$(echo "$API_KEY" | tr -d ' \n\r')
    
    cat > "$CONFIG_FILE" << EOF
# VPS监控配置文件
WORKER_URL="$WORKER_URL"
SERVER_ID="$SERVER_ID"
API_KEY="$API_KEY"
INTERVAL="$INTERVAL"
EOF
    print_message "$GREEN" "配置已保存到 $CONFIG_FILE"
}

# 获取CPU使用率
get_cpu_usage() {
    local cpu_usage
    local cpu_load

    # FreeBSD系统
    if [[ "$OS" == "FreeBSD" ]]; then
        # 使用sysctl获取CPU使用率
        if command_exists sysctl; then
            local cpu_idle=$(sysctl -n kern.cp_time 2>/dev/null | awk '{print $5}' 2>/dev/null || echo "0")
            local cpu_total=$(sysctl -n kern.cp_time 2>/dev/null | awk '{sum=0; for(i=1;i<=NF;i++) sum+=$i; print sum}' 2>/dev/null || echo "0")

            # 确保获取到有效数值
            cpu_idle=$(sanitize_integer "$cpu_idle" "0")
            cpu_total=$(sanitize_integer "$cpu_total" "0")

            if [[ $cpu_total -gt 0 && $cpu_idle -le $cpu_total ]]; then
                cpu_usage=$(echo "scale=1; 100 - ($cpu_idle * 100 / $cpu_total)" | bc 2>/dev/null || echo "0")
                # 确保cpu_usage是有效的数字
                cpu_usage=$(sanitize_number "$cpu_usage" "0")
            else
                cpu_usage="0"
            fi
        else
            cpu_usage="0"
        fi

        # FreeBSD负载平均值
        local load1="0" load5="0" load15="0"
        if command_exists sysctl; then
            load1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}' 2>/dev/null || echo "0")
            load5=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $3}' 2>/dev/null || echo "0")
            load15=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $4}' 2>/dev/null || echo "0")

            # 清理负载数值
            load1=$(sanitize_number "$load1" "0")
            load5=$(sanitize_number "$load5" "0")
            load15=$(sanitize_number "$load15" "0")
        fi

        cpu_load="$load1,$load5,$load15"
    else
        # Linux系统 - 多种方法提高兼容性
        cpu_usage="0"

        # 方法1: 使用/proc/stat（最准确的方法）
        if [[ -f /proc/stat ]]; then
            local cpu_line=$(head -n1 /proc/stat 2>/dev/null)
            if [[ -n "$cpu_line" ]]; then
                local cpu_times=($cpu_line)
                if [[ ${#cpu_times[@]} -ge 8 ]]; then
                    local idle=${cpu_times[4]}
                    local iowait=${cpu_times[5]:-0}
                    local total=0

                    # 计算总CPU时间（user + nice + system + idle + iowait + irq + softirq + steal）
                    for i in {1..7}; do
                        if [[ -n "${cpu_times[i]}" && "${cpu_times[i]}" =~ ^[0-9]+$ ]]; then
                            total=$((total + cpu_times[i]))
                        fi
                    done

                    if [[ $total -gt 0 ]]; then
                        cpu_usage=$(echo "scale=1; 100 - (($idle + $iowait) * 100 / $total)" | bc 2>/dev/null || echo "0")
                    fi
                fi
            fi
        fi

        # 方法2: 使用top命令（如果/proc/stat不可用）
        if [[ "$cpu_usage" == "0" ]] && command_exists top; then
            # 尝试不同的top输出格式
            local top_output=$(timeout 3 top -bn1 2>/dev/null | head -10)
            if [[ -n "$top_output" ]]; then
                # 匹配不同格式的CPU行
                if [[ "$top_output" =~ %Cpu\(s\):[[:space:]]*([0-9.]+)[[:space:]]*us.*[[:space:]]+([0-9.]+)[[:space:]]*id ]]; then
                    # 格式: %Cpu(s): 12.5 us, 2.1 sy, 0.0 ni, 85.4 id
                    local idle_percent="${BASH_REMATCH[2]}"
                    cpu_usage=$(echo "scale=1; 100 - $idle_percent" | bc 2>/dev/null || echo "0")
                elif [[ "$top_output" =~ CPU:[[:space:]]*([0-9.]+)%[[:space:]]*us.*[[:space:]]+([0-9.]+)%[[:space:]]*id ]]; then
                    # 格式: CPU: 12.5% us, 2.1% sy, 85.4% id
                    local idle_percent="${BASH_REMATCH[2]}"
                    cpu_usage=$(echo "scale=1; 100 - $idle_percent" | bc 2>/dev/null || echo "0")
                fi
            fi
        fi

        # 方法3: 使用vmstat命令（备用方法）
        if [[ "$cpu_usage" == "0" ]] && command_exists vmstat; then
            local vmstat_output=$(timeout 3 vmstat 1 2 2>/dev/null | tail -1)
            if [[ -n "$vmstat_output" ]]; then
                local idle_percent=$(echo "$vmstat_output" | awk '{print $(NF-2)}' 2>/dev/null || echo "100")
                if [[ "$idle_percent" =~ ^[0-9]+$ ]]; then
                    cpu_usage=$((100 - idle_percent))
                fi
            fi
        fi

        # 确保cpu_usage是有效的数字
        cpu_usage=$(sanitize_number "$cpu_usage" "0")

        # 获取负载平均值 - 多种方法
        local load1="0" load5="0" load15="0"
        if [[ -f /proc/loadavg ]]; then
            local load_data=$(cat /proc/loadavg 2>/dev/null | awk '{print $1" "$2" "$3}' || echo "0 0 0")
            read -r load1 load5 load15 <<< "$load_data"
        elif command_exists uptime; then
            # 尝试从uptime命令获取负载
            local uptime_output=$(uptime 2>/dev/null)
            if [[ "$uptime_output" =~ load[[:space:]]+average:[[:space:]]*([0-9.]+),[[:space:]]*([0-9.]+),[[:space:]]*([0-9.]+) ]]; then
                load1="${BASH_REMATCH[1]}"
                load5="${BASH_REMATCH[2]}"
                load15="${BASH_REMATCH[3]}"
            elif [[ "$uptime_output" =~ ([0-9.]+)[[:space:]]+([0-9.]+)[[:space:]]+([0-9.]+)$ ]]; then
                load1="${BASH_REMATCH[1]}"
                load5="${BASH_REMATCH[2]}"
                load15="${BASH_REMATCH[3]}"
            fi
        fi

        # 清理和验证每个负载值
        load1=$(sanitize_number "$load1" "0")
        load5=$(sanitize_number "$load5" "0")
        load15=$(sanitize_number "$load15" "0")

        cpu_load="$load1,$load5,$load15"
    fi

    echo "{\"usage_percent\":$cpu_usage,\"load_avg\":[$cpu_load]}"
}

# 获取内存使用情况
get_memory_usage() {
    local total used free usage_percent

    # FreeBSD系统
    if [[ "$OS" == "FreeBSD" ]]; then
        if command_exists sysctl; then
            # FreeBSD内存信息
            local page_size=$(sysctl -n hw.pagesize 2>/dev/null || echo "4096")
            local total_pages=$(sysctl -n vm.stats.vm.v_page_count 2>/dev/null || echo "0")
            local free_pages=$(sysctl -n vm.stats.vm.v_free_count 2>/dev/null || echo "0")
            local inactive_pages=$(sysctl -n vm.stats.vm.v_inactive_count 2>/dev/null || echo "0")
            local cache_pages=$(sysctl -n vm.stats.vm.v_cache_count 2>/dev/null || echo "0")

            # 清理和验证数值
            page_size=$(sanitize_integer "$page_size" "4096")
            total_pages=$(sanitize_integer "$total_pages" "0")
            free_pages=$(sanitize_integer "$free_pages" "0")
            inactive_pages=$(sanitize_integer "$inactive_pages" "0")
            cache_pages=$(sanitize_integer "$cache_pages" "0")

            # 计算内存（转换为KB）
            if [[ $page_size -gt 0 && $total_pages -gt 0 ]]; then
                total=$(( (total_pages * page_size) / 1024 ))
                free=$(( ((free_pages + inactive_pages + cache_pages) * page_size) / 1024 ))
                used=$((total - free))

                # 确保数值合理
                if [[ $used -lt 0 ]]; then
                    used=0
                fi
                if [[ $free -lt 0 ]]; then
                    free=0
                fi
            else
                total=0
                used=0
                free=0
            fi
        else
            total=0
            used=0
            free=0
        fi
    else
        # Linux系统 - 修复内存计算逻辑，确保 used + free = total
        total=0
        used=0
        free=0

        # 方法1: 使用free命令（最常用且最准确）
        if command_exists free; then
            local mem_info=$(free -k 2>/dev/null | grep "^Mem:")
            if [[ -n "$mem_info" ]]; then
                total=$(echo "$mem_info" | awk '{print $2}')

                # 尝试获取available列（第7列，现代Linux系统）
                local available=$(echo "$mem_info" | awk '{print $7}' 2>/dev/null || echo "")
                if [[ "$available" =~ ^[0-9]+$ ]]; then
                    # 如果有available列，使用它作为真正的可用内存
                    free=$available
                    used=$((total - free))
                else
                    # 如果没有available列，使用传统方法计算
                    local mem_free=$(echo "$mem_info" | awk '{print $4}' 2>/dev/null || echo "0")
                    local buff_cache=$(echo "$mem_info" | awk '{print $6}' 2>/dev/null || echo "0")

                    # 验证数据有效性
                    if [[ "$mem_free" =~ ^[0-9]+$ ]] && [[ "$buff_cache" =~ ^[0-9]+$ ]]; then
                        free=$((mem_free + buff_cache))
                        used=$((total - free))
                    else
                        # 如果解析失败，使用第3列作为used，但需要重新计算free
                        local raw_used=$(echo "$mem_info" | awk '{print $3}' 2>/dev/null || echo "0")
                        if [[ "$raw_used" =~ ^[0-9]+$ ]]; then
                            used=$raw_used
                            free=$((total - used))
                        fi
                    fi
                fi
            fi
        fi

        # 方法2: 直接读取/proc/meminfo（备用方法）
        if [[ "$total" == "0" ]] && [[ -f /proc/meminfo ]]; then
            total=$(grep "^MemTotal:" /proc/meminfo | awk '{print $2}' 2>/dev/null || echo "0")
            local mem_free=$(grep "^MemFree:" /proc/meminfo | awk '{print $2}' 2>/dev/null || echo "0")
            local buffers=$(grep "^Buffers:" /proc/meminfo | awk '{print $2}' 2>/dev/null || echo "0")
            local cached=$(grep "^Cached:" /proc/meminfo | awk '{print $2}' 2>/dev/null || echo "0")
            local sreclaimable=$(grep "^SReclaimable:" /proc/meminfo | awk '{print $2}' 2>/dev/null || echo "0")

            # 计算实际可用内存（包括可回收的内存）
            free=$((mem_free + buffers + cached + sreclaimable))
            used=$((total - free))
        fi

        # 方法3: 容器环境特殊处理 (Cgroup V1 & V2)
        # 即使没有CONTAINER_ENV变量，如果检测到cgroup限制且限制合理，也优先使用
        local cgroup_limit="0"
        local cgroup_usage="0"
        local cgroup_found=false
        
        # 尝试检测 Cgroup V2
        if [[ -f /sys/fs/cgroup/memory.max ]]; then
            local max_raw=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
            if [[ "$max_raw" != "max" && "$max_raw" =~ ^[0-9]+$ ]]; then
                cgroup_limit="$max_raw"
                if [[ -f /sys/fs/cgroup/memory.current ]]; then
                    cgroup_usage=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo "0")
                    cgroup_found=true
                fi
            fi
        fi
        
        # 尝试检测 Cgroup V1 (如果V2没找到)
        if [[ "$cgroup_found" == "false" && -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]]; then
            local limit_raw=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo "0")
            # 忽略极大的值 (未限制)
            if [[ "$limit_raw" =~ ^[0-9]+$ && "$limit_raw" -lt 9223372036854771712 ]]; then
                cgroup_limit="$limit_raw"
                cgroup_usage=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || echo "0")
                cgroup_found=true
            fi
        fi
        
        # 如果找到了有效的cgroup限制，并且限制值小于宿主机物理内存(total)，则使用cgroup数据
        # 或者如果total是0（上面获取失败），直接使用cgroup数据
        if [[ "$cgroup_found" == "true" ]]; then
            local cgroup_total_kb=$((cgroup_limit / 1024))
            
            # 只有当cgroup限制明显即使有效（例如小于宿主机内存，或者我们确定是在容器里）时才使用
            # 这里如果不确定宿主机内存，或者cgroup限制小于宿主机内存，就采用
            if [[ "$total" == "0" || "$cgroup_total_kb" -lt "$total" ]]; then
                total=$cgroup_total_kb
                used=$((cgroup_usage / 1024))
                free=$((total - used))
            fi
        fi

        # 确保所有值都是有效数字
        total=$(sanitize_integer "$total" "0")
        used=$(sanitize_integer "$used" "0")
        free=$(sanitize_integer "$free" "0")

        # 数据一致性验证和修正 - 优化版本
        if [[ $total -gt 0 ]]; then
            # 确保所有值都是有效数字
            total=$(sanitize_integer "$total" "0")
            used=$(sanitize_integer "$used" "0")
            free=$(sanitize_integer "$free" "0")

            # 确保 used + free = total 的一致性
            local sum=$((used + free))
            local diff=$((sum - total))

            # 如果差异超过1%，说明数据有问题，需要修正
            local tolerance=$((total / 100))
            if [[ $tolerance -lt 1024 ]]; then
                tolerance=1024  # 最小容差1MB
            fi

            if [[ ${diff#-} -gt $tolerance ]]; then
                # 数据不一致，优先保证total的准确性
                if [[ $free -gt $total ]]; then
                    # free过大，重置为total
                    free=$total
                    used=0
                elif [[ $used -gt $total ]]; then
                    # used过大，重置
                    used=$total
                    free=0
                else
                    # 重新计算used，保证一致性
                    used=$((total - free))
                fi

                # 最终安全检查
                if [[ $used -lt 0 ]]; then
                    used=0
                    free=$total
                fi
                if [[ $free -lt 0 ]]; then
                    free=0
                    used=$total
                fi
            fi
        else
            # 如果没有获取到数据，设置默认值
            total=0
            used=0
            free=0
        fi
    fi

    # 计算使用百分比
    if [[ $total -gt 0 ]]; then
        usage_percent=$(echo "scale=1; $used * 100 / $total" | bc 2>/dev/null || echo "0")
        # 确保usage_percent是有效的数字
        if ! [[ "$usage_percent" =~ ^[0-9]+\.?[0-9]*$ ]]; then
            usage_percent="0"
        fi
    else
        usage_percent="0"
    fi

    echo "{\"total\":$total,\"used\":$used,\"free\":$free,\"usage_percent\":$usage_percent}"
}

# 获取磁盘使用情况
get_disk_usage() {
    local total used free usage_percent

    # 多种方法获取磁盘信息，提高兼容性
    if command_exists df; then
        # 使用-k参数确保输出单位一致（KB）
        local disk_info=$(df -k / 2>/dev/null | tail -1)
        if [[ -n "$disk_info" ]]; then
            # 从KB转换为GB，使用awk进行更安全的计算
            total=$(echo "$disk_info" | awk '{printf "%.2f", $2 / 1024 / 1024}' 2>/dev/null || echo "0")
            used=$(echo "$disk_info" | awk '{printf "%.2f", $3 / 1024 / 1024}' 2>/dev/null || echo "0")
            free=$(echo "$disk_info" | awk '{printf "%.2f", $4 / 1024 / 1024}' 2>/dev/null || echo "0")
            usage_percent=$(echo "$disk_info" | awk '{print $5}' | tr -d '%' 2>/dev/null || echo "0")

            # 验证数据有效性
            total=$(sanitize_number "$total" "0")
            used=$(sanitize_number "$used" "0")
            free=$(sanitize_number "$free" "0")
            usage_percent=$(sanitize_integer "$usage_percent" "0")
        else
            total="0"
            used="0"
            free="0"
            usage_percent="0"
        fi
    else
        # 如果df不可用，尝试其他方法
        total="0"
        used="0"
        free="0"
        usage_percent="0"
    fi

    # 容器环境特殊处理
    if [[ "${CONTAINER_ENV:-false}" == "true" && "$total" == "0" ]]; then
        # 在容器中，尝试获取当前目录的磁盘使用情况
        if command_exists df; then
            local container_disk=$(df -k . 2>/dev/null | tail -1)
            if [[ -n "$container_disk" ]]; then
                total=$(echo "$container_disk" | awk '{printf "%.2f", $2 / 1024 / 1024}' 2>/dev/null || echo "0")
                used=$(echo "$container_disk" | awk '{printf "%.2f", $3 / 1024 / 1024}' 2>/dev/null || echo "0")
                free=$(echo "$container_disk" | awk '{printf "%.2f", $4 / 1024 / 1024}' 2>/dev/null || echo "0")
                usage_percent=$(echo "$container_disk" | awk '{print $5}' | tr -d '%' 2>/dev/null || echo "0")

                total=$(sanitize_number "$total" "0")
                used=$(sanitize_number "$used" "0")
                free=$(sanitize_number "$free" "0")
                usage_percent=$(sanitize_integer "$usage_percent" "0")
            fi
        fi
    fi

    echo "{\"total\":$total,\"used\":$used,\"free\":$free,\"usage_percent\":$usage_percent}"
}

# 获取网络使用情况
get_network_usage() {
    local upload_speed=0
    local download_speed=0
    local total_upload=0
    local total_download=0

    # FreeBSD系统
    if [[ "$OS" == "FreeBSD" ]]; then
        # 获取默认网络接口
        local interface=""

        # FreeBSD使用不同的route命令格式
        if command_exists route; then
            # 获取默认路由的接口
            interface=$(route -n get default 2>/dev/null | grep 'interface:' | awk '{print $2}')
        fi

        # 如果没有找到，尝试查找活跃接口
        if [[ -z "$interface" ]] && command_exists netstat; then
            # 尝试1: 查找有流量的接口（排除lo）
            interface=$(netstat -i -b | awk 'NR>1 && $1 !~ /^lo/ && ($8 > 0 || $11 > 0) {print $1; exit}')
            
            # 尝试2: 如果没有找到活跃接口，使用第一个非lo接口
            if [[ -z "$interface" ]]; then
                interface=$(netstat -i -b | awk 'NR>1 && $1 !~ /^lo/ {print $1; exit}')
            fi
        fi

        # 如果还是没找到，使用第一个非lo接口
        if [[ -z "$interface" ]] && command_exists ifconfig; then
            interface=$(ifconfig -l | tr ' ' '\n' | grep -v '^lo' | head -1)
        fi

        if [[ -n "$interface" ]] && command_exists netstat; then
            # 使用netstat获取网络统计
            # FreeBSD netstat -i -b 输出格式：
            # Name  Mtu Network       Address              Ipkts Ierrs Idrop     Ibytes    Opkts Oerrs     Obytes  Coll
            # 同一接口可能有多行，我们只取第一行（Link层的统计）
            local net_stats=$(netstat -i -b 2>/dev/null | grep "^$interface" | grep "<Link#" | head -1 2>/dev/null || echo "")
            if [[ -n "$net_stats" ]]; then
                local raw_download=$(echo "$net_stats" | awk '{print $8}' 2>/dev/null || echo "0")  # Ibytes
                local raw_upload=$(echo "$net_stats" | awk '{print $11}' 2>/dev/null || echo "0")   # Obytes

                # 清理和验证数值
                total_download=$(sanitize_integer "$raw_download" "0")
                total_upload=$(sanitize_integer "$raw_upload" "0")
            else
                # 如果没有找到Link统计，尝试其他方法
                local net_stats_alt=$(netstat -i -b 2>/dev/null | grep "^$interface" | head -1 2>/dev/null || echo "")
                if [[ -n "$net_stats_alt" ]]; then
                    local raw_download=$(echo "$net_stats_alt" | awk '{print $8}' 2>/dev/null || echo "0")
                    local raw_upload=$(echo "$net_stats_alt" | awk '{print $11}' 2>/dev/null || echo "0")
                    total_download=$(sanitize_integer "$raw_download" "0")
                    total_upload=$(sanitize_integer "$raw_upload" "0")
                fi
            fi

            # 计算速度（简单方法）
            local speed_file="${TMPDIR:-/tmp}/vps_monitor_net_${interface}_$(whoami)"
            mkdir -p "$(dirname "$speed_file")" 2>/dev/null
            local current_time=$(date +%s)

            if [[ -f "$speed_file" ]]; then
                local last_data=$(cat "$speed_file")
                local last_time=$(echo "$last_data" | cut -d' ' -f1)
                local last_rx=$(echo "$last_data" | cut -d' ' -f2)
                local last_tx=$(echo "$last_data" | cut -d' ' -f3)

                local time_diff=$((current_time - last_time))
                if [[ $time_diff -gt 0 ]]; then
                    download_speed=$(( (total_download - last_rx) / time_diff ))
                    upload_speed=$(( (total_upload - last_tx) / time_diff ))

                    # 确保速度不为负数
                    [[ $download_speed -lt 0 ]] && download_speed=0
                    [[ $upload_speed -lt 0 ]] && upload_speed=0
                fi
            fi

            # 保存当前数据供下次使用
            echo "$current_time $total_download $total_upload" > "$speed_file"
        fi
    else
        # Linux系统
        # 获取默认网络接口 - 多种方法提高兼容性
        local interface=""

        # 方法1: 使用ip命令（现代Linux）
        if command_exists ip; then
            interface=$(ip route show default 2>/dev/null | awk '/default/ {print $5}' | head -1)
        fi

        # 方法2: 使用route命令（传统方法）
        if [[ -z "$interface" ]] && command_exists route; then
            interface=$(route -n 2>/dev/null | awk '/^0.0.0.0/ {print $8}' | head -1)
        fi

        # 方法3: 检查/proc/net/route（直接读取内核路由表）
        if [[ -z "$interface" && -f "/proc/net/route" ]]; then
            interface=$(awk '/^[^I]/ && $2 == "00000000" {print $1; exit}' /proc/net/route 2>/dev/null)
        fi

        # 方法4: 查找活跃的网络接口（改进版）
        if [[ -z "$interface" && -f "/proc/net/dev" ]]; then
            # 查找有流量的接口（排除lo和虚拟接口）
            # 查找有流量的接口（排除lo和虚拟接口）
            interface=$(awk '/^ *[^:]*:/ {
                gsub(/:/, "", $1)
                # 排除回环和虚拟接口
                if ($1 != "lo" && $1 !~ /^(docker|br-|veth|tun|tap|virbr|vmnet)/) {
                    # 只要不是排除的接口，就认为是活动接口，不设置流量阈值
                    print $1
                    exit
                }
            }' /proc/net/dev)
        fi

        # 方法5: 如果还是没找到，使用第一个物理网络接口
        if [[ -z "$interface" && -f "/proc/net/dev" ]]; then
            # 优先选择常见的物理接口名称
            for prefix in eth ens enp eno wlan wlp; do
                interface=$(awk -v prefix="$prefix" '/^ *[^:]*:/ {
                    gsub(/:/, "", $1)
                    if ($1 ~ "^" prefix) {
                        print $1
                        exit
                    }
                }' /proc/net/dev)
                if [[ -n "$interface" ]]; then
                    break
                fi
            done
        fi

        # 方法6: 最后的备选方案
        if [[ -z "$interface" && -f "/proc/net/dev" ]]; then
            interface=$(awk '/^ *[^:]*:/ {
                gsub(/:/, "", $1)
                if ($1 != "lo" && $1 !~ /^(docker|br-|veth|tun|tap|virbr|vmnet)/) {
                    print $1
                    exit
                }
            }' /proc/net/dev)
        fi

        if [[ -n "$interface" && -f "/proc/net/dev" ]]; then
            # 获取总流量
            local net_line=$(grep "^ *$interface:" /proc/net/dev 2>/dev/null)
            if [[ -n "$net_line" ]]; then
                # 解析网络统计数据
                # 格式: interface: bytes packets errs drop fifo frame compressed multicast
                local stats=($net_line)
                total_download=${stats[1]}  # 接收字节数
                total_upload=${stats[9]}    # 发送字节数

                # 确保是数字
                if ! [[ "$total_download" =~ ^[0-9]+$ ]]; then
                    total_download=0
                fi
                if ! [[ "$total_upload" =~ ^[0-9]+$ ]]; then
                    total_upload=0
                fi
            fi

            # 尝试获取实时速度
            if command_exists ifstat && [[ -n "$interface" ]]; then
                # 使用ifstat获取实时速度
                local network_speed=$(timeout 3 ifstat -i "$interface" 1 1 2>/dev/null | tail -1)
                if [[ -n "$network_speed" && "$network_speed" != *"no statistics"* ]]; then
                    download_speed=$(echo "$network_speed" | awk '{printf "%.0f", $1 * 1024}' 2>/dev/null || echo "0")
                    upload_speed=$(echo "$network_speed" | awk '{printf "%.0f", $2 * 1024}' 2>/dev/null || echo "0")
                fi
            else
                # 如果没有ifstat，使用简单的方法计算速度
                local speed_file="${TMPDIR:-/tmp}/vps_monitor_net_${interface}_$(whoami)"
                mkdir -p "$(dirname "$speed_file")" 2>/dev/null
                local current_time=$(date +%s)

                if [[ -f "$speed_file" ]]; then
                    local last_data=$(cat "$speed_file")
                    local last_time=$(echo "$last_data" | cut -d' ' -f1)
                    local last_rx=$(echo "$last_data" | cut -d' ' -f2)
                    local last_tx=$(echo "$last_data" | cut -d' ' -f3)

                    local time_diff=$((current_time - last_time))
                    if [[ $time_diff -gt 0 ]]; then
                        download_speed=$(( (total_download - last_rx) / time_diff ))
                        upload_speed=$(( (total_upload - last_tx) / time_diff ))
                    fi
                fi

                # 保存当前数据供下次使用
                echo "$current_time $total_download $total_upload" > "$speed_file"
            fi
        fi
    fi

    # 确保所有值都是数字
    [[ "$upload_speed" =~ ^[0-9]+$ ]] || upload_speed=0
    [[ "$download_speed" =~ ^[0-9]+$ ]] || download_speed=0
    [[ "$total_upload" =~ ^[0-9]+$ ]] || total_upload=0
    [[ "$total_download" =~ ^[0-9]+$ ]] || total_download=0

    echo "{\"upload_speed\":$upload_speed,\"download_speed\":$download_speed,\"total_upload\":$total_upload,\"total_download\":$total_download}"
}

# 获取系统运行时间
get_uptime() {
    local uptime_seconds=0

    # FreeBSD系统
    if [[ "$OS" == "FreeBSD" ]]; then
        if command_exists sysctl; then
            # FreeBSD使用sysctl获取启动时间
            local boot_time_raw=$(sysctl -n kern.boottime 2>/dev/null | awk '{print $4}' | tr -d ',' 2>/dev/null || echo "0")
            local boot_time=$(sanitize_integer "$boot_time_raw" "0")
            local current_time=$(date +%s)

            if [[ $boot_time -gt 0 && $current_time -gt $boot_time ]]; then
                uptime_seconds=$((current_time - boot_time))
            else
                # 如果无法获取启动时间，尝试其他方法
                if command_exists uptime; then
                    # 尝试解析uptime命令输出
                    local uptime_str=$(uptime 2>/dev/null | grep -o 'up [^,]*' | sed 's/up //' || echo "0")
                    # 简化处理，假设格式为 "X days" 或 "X:Y"
                    if [[ "$uptime_str" =~ ([0-9]+).*day ]]; then
                        uptime_seconds=$((${BASH_REMATCH[1]} * 86400))
                    else
                        uptime_seconds=0
                    fi
                else
                    uptime_seconds=0
                fi
            fi
        else
            uptime_seconds=0
        fi
    else
        # Linux系统
        if [[ -f /proc/uptime ]]; then
            uptime_seconds=$(cut -d. -f1 /proc/uptime)
        elif command_exists uptime; then
            # 解析uptime命令输出
            local uptime_str=$(uptime | awk '{print $3}')
            # 这里简化处理，实际可能需要更复杂的解析
            uptime_seconds=$(echo "$uptime_str" | sed 's/,//' | awk '{print $1 * 86400}' 2>/dev/null || echo "0")
        fi
    fi

    echo "$uptime_seconds"
}

# 验证和清理数值
sanitize_number() {
    local value="$1"
    local default_value="${2:-0}"

    value=$(echo "$value" | sed 's/[^0-9.]//g')

    if [[ "$value" =~ ^[0-9]*\.?[0-9]+$ ]] || [[ "$value" =~ ^[0-9]+\.?[0-9]*$ ]]; then
        [[ "$value" =~ ^\. ]] && value="0$value"
        [[ "$value" =~ \.$ ]] && value="${value}0"
        echo "$value"
    else
        echo "$default_value"
    fi
}

# 验证和清理整数
sanitize_integer() {
    local value="$1"
    local default_value="${2:-0}"

    value=$(echo "$value" | sed 's/[^0-9]//g')
    [[ "$value" =~ ^[0-9]+$ ]] && echo "$value" || echo "$default_value"
}



# 清理JSON字符串
clean_json_string() {
    local input="$1"
    # 移除可能的控制字符和非打印字符
    echo "$input" | tr -d '\000-\037' | tr -d '\177-\377'
}



# 获取服务器配置（带简单重试）
get_config() {
    local max_attempts=3
    local attempt=1

    while [[ $attempt -le $max_attempts ]]; do
        log "正在获取服务器配置... (第 $attempt/$max_attempts 次)"

        local response=$(curl -s -w "%{http_code}" -X GET "$WORKER_URL/api/config/$SERVER_ID" \
            -H "X-API-Key: $API_KEY" 2>/dev/null || echo "000")

        local http_code="${response: -3}"
        local response_body="${response%???}"

        if [[ "$http_code" == "200" ]]; then
            log "配置获取成功"

            # 简化的间隔解析
            local new_interval=$(echo "$response_body" | sed -n 's/.*"interval":\([0-9]\+\).*/\1/p')

            if [[ -n "$new_interval" && "$new_interval" =~ ^[0-9]+$ && "$new_interval" -gt 0 ]]; then
                if [[ "$new_interval" != "$INTERVAL" ]]; then
                    log "服务器返回新的上报间隔: ${new_interval}秒 (当前: ${INTERVAL}秒)"
                    INTERVAL="$new_interval"
                    save_config
                    log "上报间隔已更新为: ${INTERVAL}秒"
                fi
            fi

            save_config_cache "$response_body"
            return 0
        else
            log "配置获取失败 (HTTP $http_code)"

            case "$http_code" in
                "401") log "认证失败 - 请检查API密钥" ;;
                "404") log "服务器不存在 - 请检查服务器ID" ;;
                "000") log "网络连接失败" ;;
            esac

            if [[ $attempt -lt $max_attempts ]]; then
                log "等待2秒后重试..."
                sleep 2
            fi
        fi

        attempt=$((attempt + 1))
    done

    log "配置获取最终失败"
    return 1
}

# 本地缓存管理
CACHE_DIR="$SCRIPT_DIR/cache"
CONFIG_CACHE_FILE="$CACHE_DIR/config.json"
METRICS_CACHE_FILE="$CACHE_DIR/last_metrics.json"

# 初始化缓存目录
init_cache() {
    if [[ ! -d "$CACHE_DIR" ]]; then
        mkdir -p "$CACHE_DIR"
        log "创建缓存目录: $CACHE_DIR"
    fi
}

# 保存配置到缓存
save_config_cache() {
    local config_data="$1"
    init_cache

    echo "$config_data" > "$CONFIG_CACHE_FILE"
    log "配置已缓存到本地"
}

# 从缓存加载配置
load_config_cache() {
    if [[ -f "$CONFIG_CACHE_FILE" ]]; then
        local cached_config=$(cat "$CONFIG_CACHE_FILE")
        if [[ -n "$cached_config" ]]; then
            log "从缓存加载配置"
            echo "$cached_config"
            return 0
        fi
    fi
    return 1
}



# 上报监控数据
report_metrics() {
    local timestamp=$(date +%s)
    local cpu_raw=$(get_cpu_usage)
    local memory_raw=$(get_memory_usage)
    local disk_raw=$(get_disk_usage)
    local network_raw=$(get_network_usage)
    local uptime_raw=$(get_uptime)

    # 验证运行时间
    local uptime=$(sanitize_integer "$uptime_raw" "0")

    # 清理JSON数据
    cpu_raw=$(clean_json_string "$cpu_raw")
    memory_raw=$(clean_json_string "$memory_raw")
    disk_raw=$(clean_json_string "$disk_raw")
    network_raw=$(clean_json_string "$network_raw")

    # 简单验证JSON格式
    [[ ! "$cpu_raw" =~ ^\{.*\}$ ]] && cpu_raw='{"usage_percent":0,"load_avg":[0,0,0]}'
    [[ ! "$memory_raw" =~ ^\{.*\}$ ]] && memory_raw='{"total":0,"used":0,"free":0,"usage_percent":0}'
    [[ ! "$disk_raw" =~ ^\{.*\}$ ]] && disk_raw='{"total":0,"used":0,"free":0,"usage_percent":0}'
    [[ ! "$network_raw" =~ ^\{.*\}$ ]] && network_raw='{"upload_speed":0,"download_speed":0,"total_upload":0,"total_download":0}'

    # 构建JSON数据
    local data="{\"timestamp\":$timestamp,\"cpu\":$cpu_raw,\"memory\":$memory_raw,\"disk\":$disk_raw,\"network\":$network_raw,\"uptime\":$uptime}"

    # 确保API KEY和ID没有多余的空格或换行
    local clean_api_key=$(echo "$API_KEY" | tr -d ' \n\r')
    local clean_server_id=$(echo "$SERVER_ID" | tr -d ' \n\r')
    
    log "正在上报数据到 $WORKER_URL/api/report/$clean_server_id"

    local response=$(curl -s -w "%{http_code}" -X POST "$WORKER_URL/api/report/$clean_server_id" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $clean_api_key" \
        -d "$data" 2>/dev/null || echo "000")

    local http_code="${response: -3}"
    local response_body="${response%???}"

    if [[ "$http_code" == "200" ]]; then
        log "数据上报成功"

        # 尝试从响应中解析新的间隔设置
        if command_exists jq; then
            # 如果有jq命令，使用jq解析
            local new_interval=$(echo "$response_body" | jq -r '.interval // empty' 2>/dev/null)
            if [[ -n "$new_interval" && "$new_interval" =~ ^[0-9]+$ && "$new_interval" -gt 0 ]]; then
                if [[ "$new_interval" != "$INTERVAL" ]]; then
                    log "服务器返回新的上报间隔: ${new_interval}秒 (当前: ${INTERVAL}秒)"
                    INTERVAL="$new_interval"
                    # 更新配置文件
                    save_config
                    log "上报间隔已更新为: ${INTERVAL}秒"
                    # 创建重启标记文件，让主循环重启服务以应用新间隔
                    touch "$SCRIPT_DIR/restart_needed"
                fi
            fi
        else
            # 如果没有jq，使用简单的文本解析
            local new_interval=$(echo "$response_body" | sed -n 's/.*"interval":\([0-9]\+\).*/\1/p')
            if [[ -n "$new_interval" && "$new_interval" =~ ^[0-9]+$ && "$new_interval" -gt 0 ]]; then
                if [[ "$new_interval" != "$INTERVAL" ]]; then
                    log "服务器返回新的上报间隔: ${new_interval}秒 (当前: ${INTERVAL}秒)"
                    INTERVAL="$new_interval"
                    # 更新配置文件
                    save_config
                    log "上报间隔已更新为: ${INTERVAL}秒"
                    # 创建重启标记文件，让主循环重启服务以应用新间隔
                    touch "$SCRIPT_DIR/restart_needed"
                fi
            fi
        fi

        return 0
    else
        # 错误分类处理
        case "$http_code" in
            "400"|"413")
                log "数据上报失败 (HTTP $http_code): 数据格式或大小问题"
                return 1  # 不可重试的错误
                ;;
            "401"|"403")
                log "数据上报失败 (HTTP $http_code): 认证失败"
                return 1  # 不可重试的错误
                ;;
            "404")
                log "数据上报失败 (HTTP $http_code): 服务器不存在"
                return 1  # 不可重试的错误
                ;;
            "429"|"500"|"502"|"503"|"504"|"000")
                log "数据上报失败 (HTTP $http_code): 可重试的错误"
                return 2  # 可重试的错误
                ;;
            *)
                log "数据上报失败 (HTTP $http_code): 未知错误"
                return 1  # 默认不可重试
                ;;
        esac
    fi
}



# 创建监控服务脚本
create_service_script() {
    # 获取当前脚本的绝对路径
    local main_script_path=$(realpath "$0")

    cat > "$SERVICE_FILE" << EOF
#!/bin/bash

# cf-vps-monitor服务脚本 - 集中式文件管理
SCRIPT_DIR="$SCRIPT_DIR"
CONFIG_FILE="\$SCRIPT_DIR/config/config"
LOG_FILE="\$SCRIPT_DIR/logs/monitor.log"
PID_FILE="\$SCRIPT_DIR/run/monitor.pid"
MAIN_SCRIPT="$main_script_path"

# 设置服务模式标志（避免日志重复）
export SERVICE_MODE=true

# 确保日志目录存在
mkdir -p "\$(dirname "\$LOG_FILE")" 2>/dev/null

# 加载配置
if [[ -f "\$CONFIG_FILE" ]]; then
    source "\$CONFIG_FILE"
else
    echo "配置文件不存在: \$CONFIG_FILE"
    exit 1
fi

# 从主脚本加载监控函数（简化版）
source_monitoring_functions() {
    # 直接source主脚本，但设置标志避免执行主程序
    if [[ -f "\$MAIN_SCRIPT" ]]; then
        # 设置标志表示只加载函数
        export FUNCTIONS_ONLY=true
        source "\$MAIN_SCRIPT"
        unset FUNCTIONS_ONLY
    else
        log "错误: 找不到主脚本 \$MAIN_SCRIPT"
        exit 1
    fi
}

# 加载监控函数
source_monitoring_functions

# 清理JSON字符串
clean_json_string() {
    local input="\$1"
    # 移除可能的控制字符和非打印字符
    echo "\$input" | tr -d '\\000-\\037' | tr -d '\\177-\\377'
}

# 上报监控数据
report_metrics() {
    local timestamp=\$(date +%s)
    
    
    local cpu_raw=\$(get_cpu_usage)
    local memory_raw=\$(get_memory_usage)
    local disk_raw=\$(get_disk_usage)
    local network_raw=\$(get_network_usage)
    local uptime_raw=\$(get_uptime)

    # 验证运行时间
    local uptime=\$(sanitize_integer "\$uptime_raw" "0")

    # 清理JSON数据
    cpu_raw=\$(clean_json_string "\$cpu_raw")
    memory_raw=\$(clean_json_string "\$memory_raw")
    disk_raw=\$(clean_json_string "\$disk_raw")
    network_raw=\$(clean_json_string "\$network_raw")

    # 验证各个JSON组件（使用更宽松的验证）
    if [[ -z "\$cpu_raw" || "\$cpu_raw" == "{}" || ! "\$cpu_raw" =~ ^\{.*\}\$ ]]; then
        cpu_raw='{\\"usage_percent\\":0,\\"load_avg\\":[0,0,0]}'
    fi
    if [[ -z "\$memory_raw" || "\$memory_raw" == "{}" || ! "\$memory_raw" =~ ^\{.*\}\$ ]]; then
        memory_raw='{\\"total\\":0,\\"used\\":0,\\"free\\":0,\\"usage_percent\\":0}'
    fi
    if [[ -z "\$disk_raw" || "\$disk_raw" == "{}" || ! "\$disk_raw" =~ ^\{.*\}\$ ]]; then
        disk_raw='{\\"total\\":0,\\"used\\":0,\\"free\\":0,\\"usage_percent\\":0}'
    fi
    if [[ -z "\$network_raw" || "\$network_raw" == "{}" || ! "\$network_raw" =~ ^\{.*\}\$ ]]; then
        network_raw='{\\"upload_speed\\":0,\\"download_speed\\":0,\\"total_upload\\":0,\\"total_download\\":0}'
    fi


    # 构建JSON数据
    local data="{\\"timestamp\\":\$timestamp,\\"cpu\\":\$cpu_raw,\\"memory\\":\$memory_raw,\\"disk\\":\$disk_raw,\\"network\\":\$network_raw,\\"uptime\\":\$uptime}"

    # 确保API KEY和ID没有多余的空格或换行
    local clean_api_key=\$(echo "\$API_KEY" | tr -d ' \\n\\r')
    local clean_server_id=\$(echo "\$SERVER_ID" | tr -d ' \\n\\r')

    log "正在上报数据..."

    local response=\$(curl -s -w "%{http_code}" -X POST "\$WORKER_URL/api/report/\$clean_server_id" \\
        -H "Content-Type: application/json" \\
        -H "X-API-Key: \$clean_api_key" \\
        -d "\$data" 2>/dev/null || echo "000")


    local http_code="\${response: -3}"
    local response_body="\${response%???}"

    if [[ "\$http_code" == "200" ]]; then
        log "数据上报成功"

        # 尝试从响应中解析新的间隔设置
        # 使用简单的文本解析（避免依赖jq）
        local new_interval=\$(echo "\$response_body" | sed -n 's/.*"interval":\\([0-9]\\+\\).*/\\1/p')
        if [[ -n "\$new_interval" && "\$new_interval" =~ ^[0-9]+\$ && "\$new_interval" -gt 0 ]]; then
            if [[ "\$new_interval" != "\$INTERVAL" ]]; then
                log "服务器返回新的上报间隔: \${new_interval}秒 (当前: \${INTERVAL}秒)"
                INTERVAL="\$new_interval"
                # 更新配置文件
                cat > "\$CONFIG_FILE" << EOL
# VPS监控配置文件
WORKER_URL="\$WORKER_URL"
SERVER_ID="\$SERVER_ID"
API_KEY="\$API_KEY"
INTERVAL="\$INTERVAL"
EOL
                log "上报间隔已更新为: \${INTERVAL}秒"
                # 创建重启标记文件，让主循环重新加载配置
                touch "\$SCRIPT_DIR/restart_needed"
            fi
        fi

        return 0
    else
        log "数据上报失败 (HTTP \$http_code): \$response_body"

        # 简化的错误处理
        case "\$http_code" in
            "400") log "数据格式错误" ;;
            "401") log "认证失败 - 请检查API密钥" ;;
            "404") log "服务器不存在 - 请检查服务器ID" ;;
            "429") log "请求过于频繁 - 将自动重试" ;;
            "500"|"503") log "服务器错误 - 将在下个周期重试" ;;
            "000") log "网络连接失败" ;;
            *) log "未知错误 (HTTP \$http_code)" ;;
        esac

        return 1
    fi
}

# 获取服务器配置
get_config() {
    log "正在获取服务器配置..."

    local response=\$(curl -s -w "%{http_code}" -X GET "\$WORKER_URL/api/config/\$SERVER_ID" \\
        -H "X-API-Key: \$API_KEY" 2>/dev/null || echo "000")

    local http_code="\${response: -3}"
    local response_body="\${response%???}"

    if [[ "\$http_code" == "200" ]]; then
        log "配置获取成功"

        # 尝试解析配置
        local new_interval=""
        # 使用改进的文本解析（避免依赖jq）
        # 方法1: 使用grep + cut
        new_interval=\$(echo "\$response_body" | grep -o '"report_interval":[0-9]*' | cut -d':' -f2 2>/dev/null)

        # 方法2: 如果方法1失败，使用awk备用方案
        if [[ -z "\$new_interval" ]]; then
            new_interval=\$(echo "\$response_body" | awk -F'"report_interval":' '{if(NF>1) print \$2}' | awk -F',' '{print \$1}' | tr -d ' ' 2>/dev/null)
        fi

        # 验证并更新间隔设置
        if [[ -n "\$new_interval" && "\$new_interval" =~ ^[0-9]+\$ && "\$new_interval" -gt 0 ]]; then
            if [[ "\$new_interval" != "\$INTERVAL" ]]; then
                log "检测到新的上报间隔: \${new_interval}秒 (当前: \${INTERVAL}秒)"
                INTERVAL="\$new_interval"
                # 更新配置文件
                cat > "\$CONFIG_FILE" << EOL
# VPS监控配置文件
WORKER_URL="\$WORKER_URL"
SERVER_ID="\$SERVER_ID"
API_KEY="\$API_KEY"
INTERVAL="\$INTERVAL"
EOL
                log "上报间隔已更新为: \${INTERVAL}秒"
                return 0
            else
                log "配置无变化，当前间隔: \${INTERVAL}秒"
                return 0
            fi
        else
            log "警告: 无法解析配置中的上报间隔，保持当前设置"
            return 1
        fi
    else
        log "配置获取失败 (HTTP \$http_code): \$response_body"

        # 简化的错误处理
        case "\$http_code" in
            "401") log "认证失败 - 请检查API密钥" ;;
            "404") log "服务器不存在 - 请检查服务器ID" ;;
            "429") log "请求过于频繁 - 将稍后重试" ;;
            "500"|"503") log "服务器错误 - 将稍后重试" ;;
            "000") log "网络连接失败" ;;
            *) log "未知错误 (HTTP \$http_code)" ;;
        esac

        return 1
    fi
}

# 主循环
main() {
    log "VPS监控服务启动 (PID: \$\$)"
    echo \$\$ > "\$PID_FILE"

    # 信号处理
    trap 'log "收到终止信号，正在停止..."; rm -f "\$PID_FILE"; exit 0' TERM INT

    # 启动时获取一次配置
    log "启动时获取服务器配置..."
    get_config || log "启动时配置获取失败，使用当前配置"

    local config_check_counter=0
    local config_check_interval=10  # 每10个周期检查一次配置（约10分钟）

    while true; do
        # 定期检查配置更新
        if [[ \$config_check_counter -ge \$config_check_interval ]]; then
            log "定期检查配置更新..."
            get_config || log "配置检查失败，继续使用当前配置"
            config_check_counter=0
        else
            config_check_counter=\$((config_check_counter + 1))
        fi

        if ! report_metrics; then
            log "上报失败，将在下个周期重试"
        fi

        # 检查是否需要重启以应用新的间隔设置
        if [[ -f "\$SCRIPT_DIR/restart_needed" ]]; then
            log "检测到间隔设置变更，正在重新加载配置..."
            rm -f "\$SCRIPT_DIR/restart_needed"
            # 重新加载配置
            if [[ -f "\$CONFIG_FILE" ]]; then
                source "\$CONFIG_FILE"
                log "已重新加载配置，新的上报间隔: \${INTERVAL}秒"
            fi
        fi

        sleep "\$INTERVAL"
    done
}

# 启动主函数
main
EOF

    chmod +x "$SERVICE_FILE"
    print_message "$GREEN" "监控服务脚本创建完成: $SERVICE_FILE"
}

# ==================== 用户类型检测和systemd命令选择机制 ====================

# 检测当前用户类型
detect_user_type() {
    if [[ $EUID -eq 0 ]]; then
        echo "root"
    else
        echo "user"
    fi
}

# 检查是否为root用户
is_root_user() {
    [[ $EUID -eq 0 ]]
}



# 检查systemd服务可用性（根据用户类型）
check_systemd_availability() {
    if ! command_exists systemctl; then
        return 1
    fi

    if is_root_user; then
        # root用户检查系统级systemd
        systemctl status >/dev/null 2>&1
    else
        # 普通用户检查用户级systemd
        systemctl --user status >/dev/null 2>&1
    fi
}

# 创建systemd服务（兼容版）
create_systemd_service() {
    print_message "$BLUE" "配置systemd服务..."

    # 检查systemd可用性
    if ! is_user_systemd_available; then
        print_message "$YELLOW" "systemd不可用，跳过systemd服务配置"
        return 1
    fi

    # 确定服务文件路径
    local service_path
    if is_root_user; then
        service_path="/etc/systemd/system/cf-vps-monitor.service"
    else
        service_path="$HOME/.config/systemd/user/cf-vps-monitor.service"
        mkdir -p "$(dirname "$service_path")"
    fi

    # 生成服务文件内容
    print_message "$CYAN" "  生成systemd服务文件: $service_path"
    # 创建服务文件模板目录
    mkdir -p "$SCRIPT_DIR/system/templates"

    # 生成服务文件内容
    if is_root_user; then
        cat > "$SCRIPT_DIR/system/templates/systemd.service" << EOF
[Unit]
Description=cf-vps-monitor Service - VPS Monitoring Agent
Documentation=https://github.com/kadidalax/cf-vps-monitor
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$SERVICE_FILE
Restart=always
RestartSec=10
User=root
Group=root
WorkingDirectory=$SCRIPT_DIR

[Install]
WantedBy=multi-user.target
EOF
    else
        cat > "$SCRIPT_DIR/system/templates/systemd.service" << EOF
[Unit]
Description=cf-vps-monitor Service - VPS Monitoring Agent
Documentation=https://github.com/kadidalax/cf-vps-monitor
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$SERVICE_FILE
Restart=always
RestartSec=10
WorkingDirectory=$SCRIPT_DIR

[Install]
WantedBy=default.target
EOF
    fi

    # 复制模板到系统位置
    cp "$SCRIPT_DIR/system/templates/systemd.service" "$service_path"

    # 记录到安装清单
    record_installation "systemd" "$service_path" "create" "none"

    # 重新加载systemd配置
    if is_root_user; then
        safe_systemctl daemon-reload
        safe_systemctl enable cf-vps-monitor.service
    else
        safe_systemctl --user daemon-reload
        safe_systemctl --user enable cf-vps-monitor.service
    fi

    print_message "$GREEN" "✓ systemd服务创建完成: $service_path"
    return 0
}



# ==================== systemd lingering支持 ====================

# 简化的lingering启用
enable_lingering() {
    # root用户不需要lingering
    if is_root_user; then
        return 0
    fi

    # 检查loginctl是否可用
    if ! command_exists loginctl; then
        return 1
    fi

    # 尝试启用lingering（静默处理）
    loginctl enable-linger "$USER" 2>/dev/null || true
    return 0
}



# 启动监控服务
start_service() {
    local user_desc=$(get_user_type_description)
    print_message "$BLUE" "启动监控服务 ($user_desc)..."

    # 1. 检查是否已有进程在运行
    if is_monitor_running; then
        local pids=$(find_monitor_processes)
        local first_pid=$(echo "$pids" | awk '{print $1}')
        print_message "$YELLOW" "监控服务已在运行 (PID: $first_pid)"
        return 0
    fi

    # 2. 清理旧的PID文件
    rm -f "$PID_FILE" 2>/dev/null || true

    # 3. 尝试使用systemd启动（简化版）
    local service_path
    if is_root_user; then
        service_path="/etc/systemd/system/cf-vps-monitor.service"
    else
        service_path="$HOME/.config/systemd/user/cf-vps-monitor.service"
    fi

    if [[ -f "$service_path" ]] && is_systemd_available; then
        local systemd_cmd="systemctl"
        [[ ! $(is_root_user) ]] && systemd_cmd="systemctl --user"

        if $systemd_cmd start cf-vps-monitor.service 2>/dev/null; then
            $systemd_cmd enable cf-vps-monitor.service 2>/dev/null || true
            print_message "$GREEN" "✓ 监控服务已启动 (systemd)"

            # 自动配置其他自启动设置
            echo
            add_autostart_settings
            echo
            print_message "$CYAN" "提示: 已配置自启动设置，重启后监控服务会自动启动"
            return 0
        fi
    fi

    # 4. 传统方式启动
    print_message "$BLUE" "使用传统方式启动服务..."

    if [[ ! -f "$SERVICE_FILE" ]]; then
        print_message "$RED" "✗ 服务脚本不存在: $SERVICE_FILE"
        print_message "$CYAN" "请先运行安装命令"
        return 1
    fi

    chmod +x "$SERVICE_FILE" 2>/dev/null || true

    if command_exists nohup; then
        nohup "$SERVICE_FILE" >> "$LOG_FILE" 2>&1 &
    else
        "$SERVICE_FILE" >> "$LOG_FILE" 2>&1 &
    fi

    local pid=$!
    echo "$pid" > "$PID_FILE"

    # 5. 验证启动成功
    sleep 2
    if kill -0 "$pid" 2>/dev/null; then
        print_message "$GREEN" "✓ 监控服务已启动 (PID: $pid)"
        print_message "$CYAN" "日志文件: $LOG_FILE"

        # 自动配置自启动设置
        echo
        add_autostart_settings
        echo
        print_message "$CYAN" "提示: 已配置自启动设置，重启后监控服务会自动启动"
        return 0
    else
        print_message "$RED" "✗ 监控服务启动失败"
        if [[ -f "$LOG_FILE" ]]; then
            print_message "$YELLOW" "查看日志: tail -f $LOG_FILE"
        fi
        rm -f "$PID_FILE"
        return 1
    fi
}

# 渐进式停止单个进程（改进版）
stop_single_process() {
    local pid="$1"

    # 首先验证PID
    if ! validate_pid "$pid"; then
        print_message "$YELLOW" "  ⚠ PID $pid 无效或进程不存在"
        return 1
    fi

    # 获取正确的进程信息
    local cmd=$(get_process_command "$pid")
    print_message "$BLUE" "停止进程: $cmd (PID: $pid)"

    # 1. 温和停止（SIGTERM）
    if kill "$pid" 2>/dev/null; then
        sleep 2

        # 2. 检查是否还在运行
        if ! kill -0 "$pid" 2>/dev/null; then
            print_message "$GREEN" "  ✓ 进程已正常停止"
            return 0
        fi

        # 3. 强制停止（SIGKILL）
        if kill -9 "$pid" 2>/dev/null; then
            sleep 1

            # 4. 最终确认
            if ! kill -0 "$pid" 2>/dev/null; then
                print_message "$GREEN" "  ✓ 进程已强制停止"
                return 0
            else
                print_message "$RED" "  ✗ 进程无法停止"
                return 1
            fi
        fi
    fi

    print_message "$YELLOW" "  ⚠ 无法发送信号"
    return 1
}

# 停止监控服务
stop_service() {
    local user_desc=$(get_user_type_description)
    print_message "$BLUE" "停止监控服务 ($user_desc)..."

    local stopped=false

    # 1. 尝试使用systemd停止（简化版）
    local service_path
    if is_root_user; then
        service_path="/etc/systemd/system/cf-vps-monitor.service"
    else
        service_path="$HOME/.config/systemd/user/cf-vps-monitor.service"
    fi

    if [[ -f "$service_path" ]] && is_systemd_available; then
        local systemd_cmd="systemctl"
        [[ ! $(is_root_user) ]] && systemd_cmd="systemctl --user"

        if $systemd_cmd is-active cf-vps-monitor.service >/dev/null 2>&1; then
            $systemd_cmd stop cf-vps-monitor.service 2>/dev/null
            $systemd_cmd disable cf-vps-monitor.service 2>/dev/null || true
            stopped=true
        fi
    fi

    # 2. 查找并停止所有相关进程（使用精确检测）
    local pids=$(find_monitor_processes)
    if [[ -n "$pids" ]]; then
        local stopped_count=0
        local total_count=0

        for pid in $pids; do
            total_count=$((total_count + 1))
            if stop_single_process "$pid"; then
                stopped_count=$((stopped_count + 1))
                stopped=true
            fi
        done

        if [[ $stopped_count -gt 0 ]]; then
            print_message "$GREEN" "✓ 已停止 $stopped_count/$total_count 个监控进程"
        fi
    fi

    # 3. 清理PID文件
    rm -f "$PID_FILE" 2>/dev/null || true

    # 4. 结果报告和自启动清理
    if [[ "$stopped" == "true" ]]; then
        print_message "$GREEN" "✓ 监控服务已停止"

        # 自动移除自启动设置
        echo
        remove_autostart_settings
        echo
        print_message "$CYAN" "提示: 已移除自启动设置，重启后监控服务不会自动启动"
        print_message "$CYAN" "如需重新启用监控，请使用启动功能"
    else
        print_message "$YELLOW" "没有发现运行中的监控服务"
    fi
}

# 检查服务状态
check_service_status() {
    local user_desc=$(get_user_type_description)
    print_message "$BLUE" "检查监控服务状态 ($user_desc)..."
    echo

    # 1. 使用精确检测逻辑
    if is_monitor_running; then
        local pids=$(find_monitor_processes)
        local pid_count=$(echo "$pids" | wc -w)

        print_message "$GREEN" "✓ 监控服务正在运行"

        if [[ $pid_count -eq 1 ]]; then
            local pid=$(echo "$pids" | awk '{print $1}')
            local cmd=$(get_process_command "$pid")
            print_message "$CYAN" "  进程信息: PID $pid"
            print_message "$CYAN" "  命令行: $cmd"
        else
            print_message "$YELLOW" "  发现多个进程实例 ($pid_count 个):"
            for pid in $pids; do
                local cmd=$(get_process_command "$pid")
                print_message "$CYAN" "    PID $pid: $cmd"
            done
        fi
    else
        print_message "$RED" "✗ 监控服务未运行"
    fi

    # 2. 检查systemd状态（如果可用）
    local service_path
    if is_root_user; then
        service_path="/etc/systemd/system/cf-vps-monitor.service"
    else
        service_path="$HOME/.config/systemd/user/cf-vps-monitor.service"
    fi

    if [[ -f "$service_path" ]] && is_systemd_available; then
        local systemd_cmd="systemctl"
        [[ ! $(is_root_user) ]] && systemd_cmd="systemctl --user"

        echo
        print_message "$BLUE" "systemd服务状态:"
        if $systemd_cmd is-active cf-vps-monitor.service >/dev/null 2>&1; then
            print_message "$GREEN" "  ✓ systemd服务活跃"
            $systemd_cmd status cf-vps-monitor.service --no-pager -l 2>/dev/null || true
        else
            print_message "$YELLOW" "  ✗ systemd服务未活跃"
        fi
    fi

    # 3. 检查PID文件状态
    echo
    print_message "$BLUE" "PID文件状态:"
    if [[ -f "$PID_FILE" ]]; then
        local file_pid=$(cat "$PID_FILE" 2>/dev/null)
        if [[ -n "$file_pid" ]]; then
            if kill -0 "$file_pid" 2>/dev/null; then
                print_message "$GREEN" "  ✓ PID文件有效 (PID: $file_pid)"
            else
                print_message "$YELLOW" "  ⚠ PID文件存在但进程不存在 (清理中...)"
                rm -f "$PID_FILE"
            fi
        else
            print_message "$YELLOW" "  ⚠ PID文件为空"
        fi
    else
        print_message "$YELLOW" "  ✗ PID文件不存在"
    fi

    # 4. 显示配置信息
    echo
    print_message "$BLUE" "配置信息:"
    if [[ -f "$CONFIG_FILE" ]]; then
        load_config
        print_message "$CYAN" "  Worker URL: $WORKER_URL"
        print_message "$CYAN" "  Server ID: $SERVER_ID"
        print_message "$CYAN" "  API Key: ${API_KEY:0:8}..."
        print_message "$CYAN" "  上报间隔: ${INTERVAL}秒"
    else
        print_message "$YELLOW" "  ✗ 配置文件不存在"
    fi

    # 5. 显示日志文件信息
    echo
    print_message "$BLUE" "日志文件:"
    if [[ -f "$LOG_FILE" ]]; then
        local log_size=$(du -h "$LOG_FILE" 2>/dev/null | cut -f1)
        local log_lines=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")
        print_message "$CYAN" "  文件: $LOG_FILE"
        print_message "$CYAN" "  大小: $log_size"
        print_message "$CYAN" "  行数: $log_lines"
    else
        print_message "$YELLOW" "  ✗ 日志文件不存在"
    fi

    # 显示自启动状态
    echo
    print_message "$CYAN" "自启动配置状态:"

    local active_count=0

    # 检查systemd服务状态
    local service_path
    if is_root_user; then
        service_path="/etc/systemd/system/cf-vps-monitor.service"
        print_message "$CYAN" "  systemd服务 (系统管理员):"
        if [[ -f "$service_path" ]] && command_exists systemctl; then
            if systemctl is-enabled cf-vps-monitor.service >/dev/null 2>&1; then
                print_message "$GREEN" "    ✓ 服务已启用"
                active_count=$((active_count + 1))
                print_message "$GREEN" "    ✓ 系统级服务 (重启后自动运行)"
            else
                print_message "$YELLOW" "    ✗ 服务未启用"
            fi
        else
            print_message "$YELLOW" "    ✗ systemd服务文件不存在"
        fi
    else
        service_path="$HOME/.config/systemd/user/cf-vps-monitor.service"
        print_message "$CYAN" "  systemd服务 (普通用户):"
        if [[ -f "$service_path" ]] && command_exists systemctl; then
            if systemctl --user is-enabled cf-vps-monitor.service >/dev/null 2>&1; then
                print_message "$GREEN" "    ✓ 服务已启用"
                active_count=$((active_count + 1))
            else
                print_message "$YELLOW" "    ✗ 服务未启用"
            fi
        else
            print_message "$YELLOW" "    ✗ systemd服务文件不存在"
        fi
    fi

    # 检查crontab状态
    print_message "$CYAN" "  crontab自启动:"
    if check_crontab_autostart; then
        print_message "$GREEN" "    ✓ 已配置 (重启后自动运行)"
        active_count=$((active_count + 1))
    else
        print_message "$YELLOW" "    ✗ 未配置"
    fi

    # 检查profile状态
    print_message "$CYAN" "  shell profile自启动:"
    if [[ -f "$HOME/.bashrc" ]] && grep -q "cf-vps-monitor auto-start" "$HOME/.bashrc" 2>/dev/null; then
        print_message "$GREEN" "    ✓ 已配置 (登录时自动运行)"
        active_count=$((active_count + 1))
    else
        print_message "$YELLOW" "    ✗ 未配置"
    fi

    # 自启动状态总结
    echo
    print_message "$BLUE" "自启动保障总结:"
    echo "  活跃方案数: $active_count / 3"

    if [[ $active_count -eq 0 ]]; then
        print_message "$RED" "  状态: 无自启动保障"
        print_message "$YELLOW" "  建议: 重新安装服务以配置自启动"
    elif [[ $active_count -eq 1 ]]; then
        print_message "$YELLOW" "  状态: 基本保障"
        print_message "$CYAN" "  建议: 重新安装服务以配置完整保障"
    elif [[ $active_count -eq 2 ]]; then
        print_message "$GREEN" "  状态: 良好保障"
    else
        print_message "$GREEN" "  状态: 完全保障 (推荐)"
    fi

    # 如果检测有问题，提供诊断选项
    if ! is_monitor_running && [[ $active_count -gt 0 ]]; then
        echo
        print_message "$YELLOW" "提示: 配置了自启动但服务未运行，输入 'd' 查看详细诊断"
        echo -n "是否查看诊断信息? (d/N): "
        read -r -t 10 diag_choice
        if [[ "$diag_choice" =~ ^[Dd]$ ]]; then
            echo
            diagnose_monitor_service
        fi
    fi
}

# ==================== crontab自启动方案 ====================

# 设置crontab自启动
setup_crontab_autostart() {
    print_message "$BLUE" "配置crontab自启动..."

    # 检查crontab可用性
    if ! command_exists crontab; then
        return 1
    fi

    # 获取当前crontab（减少fork操作）
    local current_crontab=$(crontab -l 2>/dev/null || echo "")

    # 检查是否已配置
    if echo "$current_crontab" | grep -q "cf-vps-monitor"; then
        print_message "$GREEN" "✓ crontab自启动已存在"
        return 0
    fi

    # 备份当前crontab
    local backup_file="$SCRIPT_DIR/system/backups/crontab_backup"
    echo "$current_crontab" > "$backup_file"

    # 优先级启动条目（简化进程检测）
    local crontab_entry="@reboot sleep 30 && pgrep -f 'cf-vps-monitor|vps-monitor-service' >/dev/null || $SERVICE_FILE"

    # 添加新条目（减少临时文件操作）
    if (echo "$current_crontab"; echo "$crontab_entry") | crontab - 2>/dev/null; then
        # 记录到安装清单
        record_installation "crontab" "$USER" "add" "$backup_file"
        print_message "$GREEN" "✓ crontab自启动已配置"
        return 0
    else
        return 1
    fi
}



# 检查crontab自启动状态
check_crontab_autostart() {
    if ! command_exists crontab; then
        return 1
    fi

    if crontab -l 2>/dev/null | grep -q "$SERVICE_FILE"; then
        return 0
    else
        return 1
    fi
}

# ==================== shell profile自启动方案 ====================

# 设置shell profile自启动
setup_profile_autostart() {
    print_message "$BLUE" "配置shell profile自启动..."

    local profile="$HOME/.bashrc"

    # 检查是否已配置
    if grep -q "cf-vps-monitor auto-start" "$profile" 2>/dev/null; then
        return 0
    fi

    # 备份原文件
    local backup_file="$SCRIPT_DIR/system/backups/bashrc_backup"
    cp "$profile" "$backup_file" 2>/dev/null || touch "$backup_file"

    # 添加自启动代码
    cat >> "$profile" << EOF
# === cf-vps-monitor auto-start BEGIN ===
# VPS监控服务自启动检测 (最后保障)
if [ -n "\$PS1" ] && [ "\$TERM" != "dumb" ]; then
    if ! pgrep -f 'cf-vps-monitor|vps-monitor-service' >/dev/null 2>&1; then
        (sleep 5 && nohup "$SERVICE_FILE" >/dev/null 2>&1 &) &
    fi
fi
# === cf-vps-monitor auto-start END ===
EOF

    # 记录到安装清单
    record_installation "profile" "$profile" "modify" "$backup_file"
    print_message "$GREEN" "✓ shell profile自启动已配置"
    return 0
}



# ==================== 多重自启动方案协调器 ====================

# 配置优先级自启动
setup_auto_start() {
    print_message "$BLUE" "配置优先级自启动机制..."
    echo

    # 检查服务脚本
    if [[ ! -f "$SERVICE_FILE" ]]; then
        print_message "$RED" "✗ 服务脚本不存在，请先运行安装"
        return 1
    fi

    local success_count=0
    local total_attempts=3

    # 优先级1: systemd服务
    if is_user_systemd_available; then
        print_message "$CYAN" "优先级1: systemd服务"
        if create_systemd_service; then
            success_count=$((success_count + 1))
            print_message "$GREEN" "  ✓ systemd服务已配置"
            if ! is_root_user; then
                enable_lingering >/dev/null 2>&1
            fi
        else
            print_message "$YELLOW" "  ✗ systemd服务配置失败"
        fi
    else
        print_message "$YELLOW" "  - systemd不可用，跳过"
        total_attempts=$((total_attempts - 1))
    fi

    # 优先级2: crontab备用
    print_message "$CYAN" "优先级2: crontab备用"
    if setup_crontab_autostart; then
        success_count=$((success_count + 1))
        print_message "$GREEN" "  ✓ crontab备用已配置"
    else
        print_message "$YELLOW" "  ✗ crontab备用配置失败"
    fi

    # 优先级3: shell profile保障
    print_message "$CYAN" "优先级3: shell profile保障"
    if setup_profile_autostart; then
        success_count=$((success_count + 1))
        print_message "$GREEN" "  ✓ profile保障已配置"
    else
        print_message "$YELLOW" "  ✗ profile保障配置失败"
    fi

    echo
    if [[ $success_count -eq 0 ]]; then
        print_message "$RED" "✗ 所有自启动方案配置失败"
        return 1
    else
        print_message "$GREEN" "✓ 配置了 $success_count/$total_attempts 种自启动方案"
        if [[ $success_count -eq $total_attempts ]]; then
            print_message "$GREEN" "完全保障"
        elif [[ $success_count -ge 2 ]]; then
            print_message "$GREEN" "良好保障"
        else
            print_message "$YELLOW" "基本保障"
        fi
    fi

    print_message "$CYAN" "优先级: systemd > crontab > profile"
    return 0
}




# 查看日志
view_logs() {
    if [[ ! -f "$LOG_FILE" ]]; then
        print_message "$YELLOW" "日志文件不存在: $LOG_FILE"
        return
    fi

    print_message "$BLUE" "显示最近50行日志:"
    echo "----------------------------------------"
    tail -n 50 "$LOG_FILE"
    echo "----------------------------------------"
    print_message "$CYAN" "日志文件位置: $LOG_FILE"
}


# 测试连接
test_connection() {
    print_message "$BLUE" "测试连接到监控服务器..."

    load_config

    if [[ -z "$WORKER_URL" || -z "$SERVER_ID" || -z "$API_KEY" ]]; then
        print_message "$RED" "配置不完整，请先配置监控参数"
        return 1
    fi

    print_message "$BLUE" "正在测试配置获取..."
    if get_config; then
        print_message "$GREEN" "✓ 配置获取测试成功"
    else
        print_message "$YELLOW" "⚠ 配置获取测试失败，但不影响基本功能"
    fi

    print_message "$BLUE" "正在测试数据上报..."
    if report_metrics; then
        print_message "$GREEN" "✓ 数据上报测试成功"
    else
        print_message "$RED" "✗ 数据上报测试失败，请检查配置和网络"
        return 1
    fi

    print_message "$GREEN" "✓ 连接测试完成"
}







# 配置监控参数
configure_monitor() {
    print_message "$BLUE" "配置监控参数"
    echo

    load_config

    # Server ID
    echo -n "请输入Server ID"
    if [[ -n "$SERVER_ID" ]]; then
        echo -n " (当前: $SERVER_ID)"
    fi
    echo -n ": "
    read -r input_server_id
    if [[ -n "$input_server_id" ]]; then
        SERVER_ID="$input_server_id"
    fi

    # API Key
    echo -n "请输入API Key"
    if [[ -n "$API_KEY" ]]; then
        echo -n " (当前: ${API_KEY:0:8}...)"
    fi
    echo -n ": "
    read -r input_api_key
    if [[ -n "$input_api_key" ]]; then
        API_KEY="$input_api_key"
    fi

    # Worker URL
    echo -n "请输入Worker URL"
    if [[ -n "$WORKER_URL" ]]; then
        echo -n " (当前: $WORKER_URL)"
    fi
    echo -n ": "
    read -r input_url
    if [[ -n "$input_url" ]]; then
        WORKER_URL="$input_url"
    fi

    # 设置默认上报间隔为10秒，脚本会自动从服务器获取最新配置
    if [[ -z "$INTERVAL" ]]; then
        INTERVAL="10"
    fi
    print_message "$CYAN" "上报间隔设置为: ${INTERVAL}秒 (脚本运行后会自动从服务器获取最新配置)"

    # 验证配置
    if [[ -z "$WORKER_URL" || -z "$SERVER_ID" || -z "$API_KEY" ]]; then
        print_message "$RED" "配置不完整，请确保所有必需参数都已填写"
        return 1
    fi

    # 保存配置
    save_config
    print_message "$GREEN" "配置保存成功"

    # 询问是否测试连接
    echo
    echo -n "是否测试连接? (y/N): "
    read -r test_choice
    if [[ "$test_choice" =~ ^[Yy]$ ]]; then
        test_connection
    fi
}

# 安装监控服务
install_monitor() {
    print_message "$BLUE" "开始安装VPS监控服务..."
    echo

    # 检查系统资源（防止fork错误）
    if ! check_system_resources; then
        print_message "$YELLOW" "系统资源紧张，启用简化模式"
    fi

    # 检测系统
    detect_system
    detect_package_manager

    # 安装依赖
    install_dependencies

    # 创建目录结构
    create_directories

    # 配置监控参数
    if ! configure_monitor; then
        error_exit "配置失败，安装中止"
    fi

    # 创建服务脚本
    create_service_script

    # 创建systemd服务（如果可用）
    local systemd_available=false
    if create_systemd_service; then
        systemd_available=true
    fi

    # 配置多重自启动保障
    echo
    print_message "$BLUE" "配置自启动机制..."
    if setup_auto_start; then
        print_message "$GREEN" "✓ 自启动机制配置完成"
    else
        print_message "$YELLOW" "⚠ 自启动配置部分失败，但不影响基本功能"
    fi

    # 启动服务
    echo
    if start_service; then
        print_message "$GREEN" "✓ VPS监控服务安装并启动成功"
        echo
        print_message "$CYAN" "安装信息:"
        echo "  安装目录: $SCRIPT_DIR"
        echo "  配置文件: $CONFIG_FILE"
        echo "  日志文件: $LOG_FILE"
        echo "  服务脚本: $SERVICE_FILE"
        if [[ "$systemd_available" == "true" ]]; then
            local service_path
            if is_root_user; then
                service_path="/etc/systemd/system/cf-vps-monitor.service"
            else
                service_path="$HOME/.config/systemd/user/cf-vps-monitor.service"
            fi
            echo "  systemd服务: $service_path"
            print_message "$GREEN" "  启动方式: systemd服务"
        else
            print_message "$GREEN" "  启动方式: 传统后台进程"
        fi
        echo
        print_message "$GREEN" "✓ 已配置多重自启动保障，VPS重启后将自动运行"
        echo
        print_message "$YELLOW" "提示: 使用 '$0 status' 检查服务状态和自启动状态"
        print_message "$YELLOW" "提示: 使用 '$0 logs' 查看运行日志"
    else
        error_exit "服务启动失败"
    fi
}



# 集中式彻底卸载监控服务
uninstall_monitor() {
    print_message "$YELLOW" "警告: 这将删除VPS监控服务及其数据"
    echo -n "确认卸载? (y/N): "
    read -r confirm

    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        print_message "$BLUE" "取消卸载"
        return 0
    fi

    print_message "$BLUE" "开始集中式卸载VPS监控服务..."

    # 1. 停止服务
    stop_service

    # 2. 保护脚本本身
    local script_path=$(realpath "$0")
    local need_backup=false
    if [[ "$script_path" == "$SCRIPT_DIR"/* ]]; then
        need_backup=true
        local backup_script="/tmp/cf-vps-monitor-backup.sh"
        cp "$script_path" "$backup_script"
        chmod +x "$backup_script"
        print_message "$CYAN" "已备份脚本到: $backup_script"
    fi

    # 3. 清理系统集成文件（兼容所有系统）
    if [[ -f "$INSTALL_MANIFEST" ]]; then
        print_message "$CYAN" "清理系统集成文件..."

        while IFS=':' read -r type path action backup; do
            case "$type" in
                "systemd")
                    print_message "$CYAN" "  移除systemd服务: $path"
                    rm -f "$path" 2>/dev/null || true
                    # 只在有systemctl的系统上重载
                    if command_exists systemctl; then
                        if is_root_user; then
                            systemctl daemon-reload 2>/dev/null || true
                        else
                            systemctl --user daemon-reload 2>/dev/null || true
                        fi
                    fi
                    ;;
                "crontab")
                    print_message "$CYAN" "  清理crontab条目"
                    (crontab -l 2>/dev/null || echo "") | grep -v "cf-vps-monitor" | crontab - 2>/dev/null || true
                    ;;
                "profile")
                    print_message "$CYAN" "  清理profile修改: $path"
                    # 兼容FreeBSD的sed语法
                    if [[ "$OS" == "FreeBSD" ]] || [[ "$OS" == "Darwin" ]]; then
                        sed -i '' '/# === cf-vps-monitor auto-start BEGIN ===/,/# === cf-vps-monitor auto-start END ===/d' "$path" 2>/dev/null || true
                    else
                        sed -i '/# === cf-vps-monitor auto-start BEGIN ===/,/# === cf-vps-monitor auto-start END ===/d' "$path" 2>/dev/null || true
                    fi
                    ;;
            esac
        done < "$INSTALL_MANIFEST" 2>/dev/null || true
    fi

    # 4. 强制删除安装目录（多重保障）
    print_message "$BLUE" "删除安装目录: $SCRIPT_DIR"

    # 确保不在目标目录内执行删除
    cd / 2>/dev/null || cd "$HOME" 2>/dev/null || true

    # 尝试删除，如果失败提供详细信息
    if ! rm -rf "$SCRIPT_DIR" 2>/dev/null; then
        print_message "$YELLOW" "标准删除失败，尝试强制删除..."

        # 尝试逐个删除文件
        if [[ -d "$SCRIPT_DIR" ]]; then
            find "$SCRIPT_DIR" -type f -exec rm -f {} \; 2>/dev/null || true
            find "$SCRIPT_DIR" -type d -exec rmdir {} \; 2>/dev/null || true

            # 最后尝试删除主目录
            rmdir "$SCRIPT_DIR" 2>/dev/null || rm -rf "$SCRIPT_DIR" 2>/dev/null || true
        fi
    fi

    # 5. 验证删除结果并提供反馈
    if [[ -d "$SCRIPT_DIR" ]]; then
        print_message "$YELLOW" "⚠ 安装目录仍然存在: $SCRIPT_DIR"
        print_message "$CYAN" "可能原因: 文件被占用或权限不足"
        print_message "$CYAN" "手动删除: rm -rf '$SCRIPT_DIR'"

        # 显示目录内容帮助诊断
        if [[ -r "$SCRIPT_DIR" ]]; then
            print_message "$CYAN" "目录内容:"
            ls -la "$SCRIPT_DIR" 2>/dev/null || true
        fi
    else
        print_message "$GREEN" "✓ VPS监控服务已彻底卸载"
        if [[ "$need_backup" == "true" ]]; then
            print_message "$YELLOW" "注意: 当前脚本已被删除，但备份在: $backup_script"
        else
            print_message "$CYAN" "当前脚本未被删除，可以重新安装"
        fi
    fi
}

# 显示帮助信息
show_help() {
    echo "VPS监控脚本 v2.0"
    echo
    echo "用法: $0 [选项] [参数]"
    echo
    echo "基本选项:"
    echo "  install     安装监控服务"
    echo "  uninstall   彻底卸载监控服务"
    echo "  start       启动监控服务"
    echo "  stop        停止监控服务"
    echo "  restart     重启监控服务"
    echo "  status      查看服务状态"
    echo "  logs        查看运行日志"
    echo "  config      配置监控参数"
    echo "  test        测试连接"
    echo "  menu        显示交互菜单"
    echo "  help        显示此帮助信息"
    echo

    echo "一键安装参数:"
    echo "  -i, --install           一键安装模式"
    echo "  -s, --server-id ID      服务器ID"
    echo "  -k, --api-key KEY       API密钥"
    echo "  -u, --worker-url URL    Worker地址"
    echo
    echo "示例:"
    echo "  $0 install              # 交互式安装"
    echo "  $0 status               # 查看服务状态"
    echo "  $0 logs                 # 查看日志"
    echo
    echo "一键安装示例:"
    echo "  $0 -i -s server123 -k abc123 -u https://worker.example.com"
    echo
    echo "注意: 上报间隔会自动从服务器获取，无需手动设置"
}

# 显示交互菜单
show_menu() {
    while true; do
        clear
        print_message "$CYAN" "=================================="
        print_message "$CYAN" "       VPS监控服务管理菜单"
        print_message "$CYAN" "=================================="
        echo
        echo "1. 安装监控服务"
        echo "2. 启动监控服务"
        echo
        echo "3. 停止监控服务"
        echo "4. 重启监控服务"
        echo
        echo "5. 查看服务状态"
        echo "6. 查看运行日志"
        echo
        echo "7. 配置监控参数"
        echo "8. 测试连接"
        echo
        print_message "$CYAN" "特殊操作:"
        echo "9. 彻底卸载服务"
        echo "0. 退出"
        echo
        print_message "$YELLOW" "请选择操作 (0-9): "
        read -r choice

        case $choice in
            1)
                echo
                install_monitor
                echo
                print_message "$BLUE" "按任意键继续..."
                read -r
                ;;
            2)
                echo
                start_service
                echo
                print_message "$BLUE" "按任意键继续..."
                read -r
                ;;
            3)
                echo
                stop_service
                echo
                print_message "$BLUE" "按任意键继续..."
                read -r
                ;;
            4)
                echo
                stop_service
                sleep 1
                start_service
                echo
                print_message "$BLUE" "按任意键继续..."
                read -r
                ;;
            5)
                echo
                check_service_status
                echo
                print_message "$BLUE" "按任意键继续..."
                read -r
                ;;
            6)
                echo
                view_logs
                echo
                print_message "$BLUE" "按任意键继续..."
                read -r
                ;;
            7)
                echo
                configure_monitor
                echo
                print_message "$BLUE" "按任意键继续..."
                read -r
                ;;
            8)
                echo
                test_connection
                echo
                print_message "$BLUE" "按任意键继续..."
                read -r
                ;;
            9)
                echo
                uninstall_monitor
                echo
                print_message "$BLUE" "按任意键继续..."
                read -r
                ;;
            0)
                print_message "$GREEN" "感谢使用VPS监控服务！"
                exit 0
                ;;
            *)
                print_message "$RED" "无效选择，请重新输入"
                sleep 1
                ;;
        esac
    done
}

# 解析命令行参数
parse_arguments() {
    local install_mode=false
    local server_id=""
    local api_key=""
    local worker_url=""
    while [[ $# -gt 0 ]]; do
        case $1 in
            -i|--install)
                install_mode=true
                shift
                ;;
            -s|--server-id)
                server_id="$2"
                shift 2
                ;;
            -k|--api-key)
                api_key="$2"
                shift 2
                ;;
            -u|--worker-url)
                worker_url="$2"
                shift 2
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                # 如果是基本命令，返回处理
                return 1
                ;;
        esac
    done

    # 如果是一键安装模式
    if [[ "$install_mode" == "true" ]]; then
        one_click_install "$server_id" "$api_key" "$worker_url"
        exit $?
    fi

    return 1
}

# 一键安装函数
one_click_install() {
    local server_id="$1"
    local api_key="$2"
    local worker_url="$3"


    print_message "$BLUE" "开始一键安装VPS监控服务..."
    echo

    # 验证必需参数
    if [[ -z "$server_id" || -z "$api_key" || -z "$worker_url" ]]; then
        print_message "$RED" "错误: 缺少必需参数"
        echo "必需参数: -s <服务器ID> -k <API密钥> -u <Worker地址>"
        echo "使用 '$0 --help' 查看详细帮助"
        return 1
    fi

    # 设置默认间隔为10秒（会自动从服务器获取最新配置）
    local interval="10"

    print_message "$CYAN" "安装参数:"
    echo "  服务器ID: $server_id"
    echo "  API密钥: ${api_key:0:8}..."
    echo "  Worker地址: $worker_url"
    echo "  初始上报间隔: ${interval}秒 (运行后会自动从服务器获取最新配置)"
    echo

    # 检测系统
    detect_system
    detect_package_manager

    # 安装依赖
    install_dependencies

    # 创建目录结构
    create_directories

    # 设置配置参数
    WORKER_URL="$worker_url"
    SERVER_ID="$server_id"
    API_KEY="$api_key"
    INTERVAL="$interval"

    # 保存配置
    save_config
    print_message "$GREEN" "配置保存成功"

    # 测试连接
    print_message "$BLUE" "测试连接..."
    if ! report_metrics; then
        print_message "$YELLOW" "警告: 连接测试失败，但将继续安装"
        print_message "$YELLOW" "请检查网络连接和配置参数"
    else
        print_message "$GREEN" "✓ 连接测试成功"
    fi

    # 创建服务脚本
    create_service_script

    # 创建systemd服务（如果可用）
    local systemd_available=false
    if create_systemd_service; then
        systemd_available=true
    fi

    # 配置多重自启动保障
    echo
    print_message "$BLUE" "配置自启动机制..."
    if setup_auto_start; then
        print_message "$GREEN" "✓ 自启动机制配置完成"
    else
        print_message "$YELLOW" "⚠ 自启动配置部分失败，但不影响基本功能"
    fi

    # 启动服务
    echo
    if start_service; then
        print_message "$GREEN" "✓ VPS监控服务一键安装成功"
        echo
        print_message "$CYAN" "安装信息:"
        echo "  安装目录: $SCRIPT_DIR"
        echo "  配置文件: $CONFIG_FILE"
        echo "  日志文件: $LOG_FILE"
        echo "  服务脚本: $SERVICE_FILE"
        if [[ "$systemd_available" == "true" ]]; then
            local service_path
            if is_root_user; then
                service_path="/etc/systemd/system/cf-vps-monitor.service"
            else
                service_path="$HOME/.config/systemd/user/cf-vps-monitor.service"
            fi
            echo "  systemd服务: $service_path"
            print_message "$GREEN" "  启动方式: systemd服务"
        else
            print_message "$GREEN" "  启动方式: 传统后台进程"
        fi
        echo
        print_message "$GREEN" "✓ 已配置多重自启动保障，VPS重启后将自动运行"
        echo
        print_message "$YELLOW" "提示: 使用 '$0 status' 检查服务状态和自启动状态"
        print_message "$YELLOW" "提示: 使用 '$0 logs' 查看运行日志"
        return 0
    else
        print_message "$RED" "✗ 服务启动失败"
        return 1
    fi
}

# 主函数
main() {
    # 首先尝试解析命令行参数
    if parse_arguments "$@"; then
        return
    fi

    # 如果没有参数，显示菜单
    if [[ $# -eq 0 ]]; then
        show_menu
        return
    fi

    # 处理命令行参数
    case "$1" in
        install)
            install_monitor
            ;;
        uninstall)
            uninstall_monitor
            ;;
        start)
            start_service
            ;;
        stop)
            stop_service
            ;;
        restart)
            stop_service
            sleep 1
            start_service
            ;;
        status)
            check_service_status
            ;;
        logs)
            view_logs
            ;;
        config)
            configure_monitor
            ;;
        test)
            test_connection
            ;;
        menu)
            show_menu
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            print_message "$RED" "未知选项: $1"
            echo
            show_help
            exit 1
            ;;
    esac
}

# 函数加载模式支持（用于服务脚本）
if [[ "${FUNCTIONS_ONLY:-false}" == "true" ]]; then
    # 只加载函数，不执行主程序
    return 0 2>/dev/null || exit 0
fi

# 脚本入口点
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
