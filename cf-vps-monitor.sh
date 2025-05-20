#!/bin/bash
# VPS监控脚本 - 增强版安装程序

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # 无颜色

# 默认配置
API_KEY=""
SERVER_ID=""
WORKER_URL=""
INTERVAL="60" # 默认上报间隔 (秒)
INSTALL_DIR="/opt/vps-monitor"
SERVICE_NAME="vps-monitor"
CONFIG_FILE="$INSTALL_DIR/config.conf"

# 显示横幅
show_banner() {
    clear
    echo -e "${BLUE}┌─────────────────────────────────────────────┐${NC}"
    echo -e "${BLUE}│       ${GREEN}VPS监控系统 - 客户端管理工具${BLUE}         │${NC}"
    echo -e "${BLUE}│                                             │${NC}"
    echo -e "${BLUE}│  ${YELLOW}功能: 监控CPU、内存、硬盘和网络使用情况${BLUE}    │${NC}"
    echo -e "${BLUE}│  ${YELLOW}版本: 1.1.0                            ${BLUE}   │${NC}"
    echo -e "${BLUE}└─────────────────────────────────────────────┘${NC}"
    echo ""
}

# 检查是否为root用户
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo -e "${RED}错误: 此脚本需要root权限${NC}"
        exit 1
    fi
}

# 加载配置
load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        source "$CONFIG_FILE"
        return 0
    fi
    return 1
}

# 保存配置
save_config() {
    mkdir -p "$INSTALL_DIR"
    cat > "$CONFIG_FILE" << EOF
# VPS监控系统配置文件
API_KEY="$API_KEY"
SERVER_ID="$SERVER_ID"
WORKER_URL="$WORKER_URL"
INTERVAL="$INTERVAL"
INSTALL_DIR="$INSTALL_DIR"
SERVICE_NAME="$SERVICE_NAME"
EOF
    chmod 600 "$CONFIG_FILE"
}

# 安装依赖
install_dependencies() {
    echo -e "${YELLOW}正在检查并安装依赖...${NC}"
    
    # 检测包管理器
    if command -v apt-get &> /dev/null; then
        PKG_MANAGER="apt-get"
    elif command -v yum &> /dev/null; then
        PKG_MANAGER="yum"
    else
        echo -e "${RED}不支持的系统，无法自动安装依赖${NC}"
        return 1
    fi
    
    # 安装依赖
    $PKG_MANAGER update -y
    $PKG_MANAGER install -y bc curl ifstat jq
    
    echo -e "${GREEN}依赖安装完成${NC}"
    return 0
}

# 创建监控脚本
create_monitor_script() {
    echo -e "${YELLOW}正在创建监控脚本...${NC}"
    
    cat > "$INSTALL_DIR/monitor.sh" << 'EOF'
#!/bin/bash

# 配置
API_KEY="__API_KEY__"
SERVER_ID="__SERVER_ID__"
WORKER_URL="__WORKER_URL__"
INTERVAL="__INTERVAL__"  # 上报间隔（秒）
LOG_FILE="/var/log/vps-monitor.log"

# 日志函数
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

# 获取CPU使用率
get_cpu_usage() {
    cpu_usage=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - $1}' || echo "0")
    cpu_load=$(cat /proc/loadavg | awk '{print "["$1","$2","$3"]"}' || echo "[0,0,0]")
    # 验证 JSON
    json="{\"usage_percent\":$cpu_usage,\"load_avg\":$cpu_load}"
    if echo "$json" | jq . >/dev/null 2>&1; then
        echo "$json"
    else
        log "Invalid CPU JSON: $json"
        echo "{\"usage_percent\":0,\"load_avg\":[0,0,0]}"
    fi
}

# 获取内存使用情况
get_memory_usage() {
    mem_info=$(free -k | grep Mem || echo "0 0 0")
    total=$(echo "$mem_info" | awk '{print $2}' || echo "0")
    used=$(echo "$mem_info" | awk '{print $3}' || echo "0")
    free=$(echo "$mem_info" | awk '{print $4}' || echo "0")
    usage_percent=$(echo "scale=1; $used * 100 / ($total + 0.1)" | bc || echo "0")
    json="{\"total\":$total,\"used\":$used,\"free\":$free,\"usage_percent\":$usage_percent}"
    if echo "$json" | jq . >/dev/null 2>&1; then
        echo "$json"
    else
        log "Invalid Memory JSON: $json"
        echo "{\"total\":0,\"used\":0,\"free\":0,\"usage_percent\":0}"
    fi
}

# 获取硬盘使用情况
get_disk_usage() {
    disk_info=$(df -k / | tail -1 || echo "0 0 0 0 0%")
    total=$(echo "$disk_info" | awk '{print $2 / 1024 / 1024}' || echo "0")
    used=$(echo "$disk_info" | awk '{print $3 / 1024 / 1024}' || echo "0")
    free=$(echo "$disk_info" | awk '{print $4 / 1024 / 1024}' || echo "0")
    usage_percent=$(echo "$disk_info" | awk '{print $5}' | tr -d '%' || echo "0")
    json="{\"total\":$total,\"used\":$used,\"free\":$free,\"usage_percent\":$usage_percent}"
    if echo "$json" | jq . >/dev/null 2>&1; then
        echo "$json"
    else
        log "Invalid Disk JSON: $json"
        echo "{\"total\":0,\"used\":0,\"free\":0,\"usage_percent\":0}"
    fi
}

# 获取网络使用情况
get_network_usage() {
    if ! command -v ifstat &> /dev/null; then
        log "ifstat未安装，无法获取网络速度"
        echo "{\"upload_speed\":0,\"download_speed\":0,\"total_upload\":0,\"total_download\":0}"
        return
    fi
    
    # 尝试多种方式获取网络接口
    interface=$(ip -o -4 route show to default 2>/dev/null | awk '{print $5}' | head -n 1 || echo "")
    
    # 如果没有找到默认路由，尝试获取第一个活动非环回接口
    if [ -z "$interface" ]; then
        interface=$(ip -o link show up 2>/dev/null | grep -v 'lo:' | awk -F': ' '{print $2}' | head -n 1 || echo "")
    fi
    
    # 清理接口名称，移除@if部分
    interface=$(echo "$interface" | sed 's/@[^[:space:]]*//g')
    
    if [ -z "$interface" ]; then
        log "未找到活动网络接口，使用默认值"
        echo "{\"upload_speed\":0,\"download_speed\":0,\"total_upload\":0,\"total_download\":0}"
        return
    fi
    
    log "使用网络接口: $interface"
    
    ifstat_output=$(ifstat -i "$interface" 1 1 2>/dev/null)
    if [ -z "$ifstat_output" ] || echo "$ifstat_output" | grep -q "error"; then
        log "ifstat 失败 for $interface，使用默认值"
        echo "{\"upload_speed\":0,\"download_speed\":0,\"total_upload\":0,\"total_download\":0}"
        return
    fi
    
    network_speed=$(echo "$ifstat_output" | tail -n 1)
    download_speed=$(echo "$network_speed" | awk '{print $1 * 1024}' | grep -o '[0-9.]*' || echo "0")
    upload_speed=$(echo "$network_speed" | awk '{print $2 * 1024}' | grep -o '[0-9.]*' || echo "0")
    
    # 确保这些值是数字
    if ! [[ "$download_speed" =~ ^[0-9]*(\.[0-9]*)?$ ]]; then download_speed=0; fi
    if ! [[ "$upload_speed" =~ ^[0-9]*(\.[0-9]*)?$ ]]; then upload_speed=0; fi
    
    rx_bytes=$(cat /proc/net/dev 2>/dev/null | grep "$interface" | awk '{print $2}' || echo "0")
    tx_bytes=$(cat /proc/net/dev 2>/dev/null | grep "$interface" | awk '{print $10}' || echo "0")
    
    # 确保这些值是数字
    if ! [[ "$rx_bytes" =~ ^[0-9]+$ ]]; then rx_bytes=0; fi
    if ! [[ "$tx_bytes" =~ ^[0-9]+$ ]]; then tx_bytes=0; fi
    
    json="{\"upload_speed\":$upload_speed,\"download_speed\":$download_speed,\"total_upload\":$tx_bytes,\"total_download\":$rx_bytes}"
    if echo "$json" | jq . >/dev/null 2>&1; then
        echo "$json"
    else
        log "Invalid Network JSON: $json"
        echo "{\"upload_speed\":0,\"download_speed\":0,\"total_upload\":0,\"total_download\":0}"
    fi
}

# 获取运行时长
get_uptime() {
    uptime_seconds=$(cut -d. -f1 /proc/uptime || echo "0")
    echo "$uptime_seconds"
}

# 上报数据
report_metrics() {
    timestamp=$(date +%s)
    cpu=$(get_cpu_usage)
    memory=$(get_memory_usage)
    disk=$(get_disk_usage)
    network=$(get_network_usage)
    uptime=$(get_uptime)
    
    # 验证所有数据是否为有效的JSON
    if ! echo "$cpu" | jq . >/dev/null 2>&1; then
        log "CPU 数据不是有效的JSON: $cpu"
        cpu="{\"usage_percent\":0,\"load_avg\":[0,0,0]}"
    fi
    
    if ! echo "$memory" | jq . >/dev/null 2>&1; then
        log "Memory 数据不是有效的JSON: $memory"
        memory="{\"total\":0,\"used\":0,\"free\":0,\"usage_percent\":0}"
    fi
    
    if ! echo "$disk" | jq . >/dev/null 2>&1; then
        log "Disk 数据不是有效的JSON: $disk"
        disk="{\"total\":0,\"used\":0,\"free\":0,\"usage_percent\":0}"
    fi
    
    if ! echo "$network" | jq . >/dev/null 2>&1; then
        log "Network 数据不是有效的JSON: $network"
        network="{\"upload_speed\":0,\"download_speed\":0,\"total_upload\":0,\"total_download\":0}"
    fi
    
    # 确保uptime是数字
    if ! [[ "$uptime" =~ ^[0-9]+$ ]]; then
        log "Uptime 不是有效的数字: $uptime"
        uptime="0"
    fi
    
    log "CPU 数据: $cpu"
    log "Memory 数据: $memory"
    log "Disk 数据: $disk"
    log "Network 数据: $network"
    log "Uptime: $uptime"
    
    # 使用--arg而不是--argjson，在jq内部进行转换
    data=$(jq -n \
        --arg timestamp "$timestamp" \
        --argjson cpu "$cpu" \
        --argjson memory "$memory" \
        --argjson disk "$disk" \
        --argjson network "$network" \
        --arg uptime "$uptime" \
        '{"timestamp":($timestamp|tonumber),"cpu":$cpu,"memory":$memory,"disk":$disk,"network":$network,"uptime":($uptime|tonumber)}' 2>/tmp/jq_error.txt)
    
    if [ $? -ne 0 ]; then
        log "jq 错误: $(cat /tmp/jq_error.txt)"
        return
    fi
    
    log "JSON 数据: $data"
    
    if ! echo "$data" | jq . >/dev/null 2>&1; then
        log "无效 JSON 数据: $data"
        return
    fi
    
    log "正在上报数据..."
    
    response=$(curl -s -X POST "$WORKER_URL/api/report/$SERVER_ID" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d "$data")
    
    if [[ "$response" == *"success"* ]]; then
        log "数据上报成功"
    else
        log "数据上报失败: $response"
    fi
}

# 主函数
main() {
    log "VPS监控脚本启动"
    log "服务器ID: $SERVER_ID"
    log "Worker URL: $WORKER_URL"
    
    # 创建日志文件
    touch "$LOG_FILE"
    
    # 主循环
    while true; do
        report_metrics
        sleep $INTERVAL
    done
}

# 启动主函数
main
EOF

    # 替换配置
    sed -i "s|__API_KEY__|$API_KEY|g" "$INSTALL_DIR/monitor.sh"
    sed -i "s|__SERVER_ID__|$SERVER_ID|g" "$INSTALL_DIR/monitor.sh"
    sed -i "s|__WORKER_URL__|$WORKER_URL|g" "$INSTALL_DIR/monitor.sh"
    sed -i "s|__INTERVAL__|$INTERVAL|g" "$INSTALL_DIR/monitor.sh"

    # 设置执行权限
    chmod +x "$INSTALL_DIR/monitor.sh"
    
    echo -e "${GREEN}监控脚本创建完成${NC}"
}

# 创建systemd服务
create_service() {
    echo -e "${YELLOW}正在创建系统服务...${NC}"
    
    cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
[Unit]
Description=VPS Monitor Service
After=network.target

[Service]
ExecStart=$INSTALL_DIR/monitor.sh
Restart=always
User=root
Group=root
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    
    echo -e "${GREEN}系统服务创建完成${NC}"
}

# 安装监控系统
install_monitor() {
    show_banner
    echo -e "${CYAN}开始安装VPS监控系统...${NC}"
    
    # 检查是否已安装
    if systemctl is-active --quiet $SERVICE_NAME; then
        echo -e "${YELLOW}监控系统已经安装并运行中。${NC}"
        echo -e "${YELLOW}如需重新安装，请先卸载现有安装。${NC}"
        return
    fi
    
    # 获取配置信息
    if [ -z "$API_KEY" ] || [ -z "$SERVER_ID" ] || [ -z "$WORKER_URL" ]; then
        echo -e "${CYAN}请输入监控系统配置信息:${NC}"
        
        # 获取API密钥
        while [ -z "$API_KEY" ]; do
            read -p "API密钥: " API_KEY
            if [ -z "$API_KEY" ]; then
                echo -e "${RED}API密钥不能为空${NC}"
            fi
        done
        
        # 获取服务器ID
        while [ -z "$SERVER_ID" ]; do
            read -p "服务器ID: " SERVER_ID
            if [ -z "$SERVER_ID" ]; then
                echo -e "${RED}服务器ID不能为空${NC}"
            fi
        done
        
        # 获取Worker URL
        while [ -z "$WORKER_URL" ]; do
            read -p "Worker URL (例如: https://example.workers.dev): " WORKER_URL
            if [ -z "$WORKER_URL" ]; then
                echo -e "${RED}Worker URL不能为空${NC}"
            fi
        done
        
        # 获取上报间隔
        local temp_interval
        read -p "上报间隔 (秒) [默认: $INTERVAL]: " temp_interval
        if [[ "$temp_interval" =~ ^[0-9]+$ ]] && [ "$temp_interval" -gt 0 ]; then
            INTERVAL="$temp_interval"
        else
            echo -e "${YELLOW}输入无效或为空，使用默认值: $INTERVAL 秒${NC}"
        fi
    fi
    
    # 创建安装目录
    mkdir -p "$INSTALL_DIR"
    
    # 安装依赖
    install_dependencies || {
        echo -e "${RED}安装依赖失败，请手动安装bc、curl和ifstat${NC}"
        return 1
    }
    
    # 创建监控脚本
    create_monitor_script
    
    # 创建systemd服务
    create_service
    
    # 保存配置
    save_config
    
    # 启动服务
    echo -e "${YELLOW}正在启动监控服务...${NC}"
    systemctl enable "$SERVICE_NAME"
    systemctl start "$SERVICE_NAME"
    
    echo -e "${GREEN}VPS监控系统安装完成！${NC}"
    echo -e "${CYAN}服务状态: $(systemctl is-active $SERVICE_NAME)${NC}"
    echo -e "${CYAN}查看服务状态: systemctl status $SERVICE_NAME${NC}"
    echo -e "${CYAN}查看服务日志: journalctl -u $SERVICE_NAME -f${NC}"
    echo -e "${CYAN}或: tail -f /var/log/vps-monitor.log${NC}"
}

# 卸载监控系统
uninstall_monitor() {
    show_banner
    echo -e "${CYAN}开始卸载VPS监控系统...${NC}"
    
    # 检查是否已安装
    if ! systemctl is-active --quiet $SERVICE_NAME && [ ! -d "$INSTALL_DIR" ]; then
        echo -e "${YELLOW}监控系统未安装。${NC}"
        return
    fi
    
    # 确认卸载
    read -p "确定要卸载VPS监控系统吗？(y/n): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo -e "${YELLOW}卸载已取消。${NC}"
        return
    fi
    
    # 停止并禁用服务
    echo -e "${YELLOW}正在停止监控服务...${NC}"
    systemctl stop "$SERVICE_NAME" 2>/dev/null
    systemctl disable "$SERVICE_NAME" 2>/dev/null
    
    # 删除服务文件
    echo -e "${YELLOW}正在删除系统服务...${NC}"
    rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    
    # 删除安装目录
    echo -e "${YELLOW}正在删除安装文件...${NC}"
    rm -rf "$INSTALL_DIR"
    
    # 删除日志文件
    echo -e "${YELLOW}正在删除日志文件...${NC}"
    rm -f "/var/log/vps-monitor.log"

    # 重置内存中的配置变量，以便在同一会话中重新安装时提示
    API_KEY=""
    SERVER_ID=""
    WORKER_URL=""
    INTERVAL="60" # 恢复为脚本顶部的默认值
    
    echo -e "${GREEN}VPS监控系统已成功卸载！${NC}"
}

# 查看监控状态
check_status() {
    show_banner
    echo -e "${CYAN}VPS监控系统状态:${NC}"
    
    # 检查服务状态
    if systemctl is-active --quiet $SERVICE_NAME; then
        echo -e "${GREEN}● 监控服务运行中${NC}"
    else
        echo -e "${RED}● 监控服务未运行${NC}"
    fi
    
    # 检查是否开机启动
    if systemctl is-enabled --quiet $SERVICE_NAME; then
        echo -e "${GREEN}● 已设置开机自启${NC}"
    else
        echo -e "${RED}● 未设置开机自启${NC}"
    fi
    
    # 加载配置
    if load_config; then
        echo -e "${CYAN}配置信息:${NC}"
        echo -e "  服务器ID: ${YELLOW}$SERVER_ID${NC}"
        echo -e "  Worker URL: ${YELLOW}$WORKER_URL${NC}"
        echo -e "  安装目录: ${YELLOW}$INSTALL_DIR${NC}"
    else
        echo -e "${RED}● 配置文件不存在${NC}"
    fi
    
    # 显示系统信息
    echo -e "${CYAN}系统信息:${NC}"
    cpu_usage=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - $1}')
    mem_info=$(free -m | grep Mem)
    mem_total=$(echo "$mem_info" | awk '{print $2}')
    mem_used=$(echo "$mem_info" | awk '{print $3}')
    mem_usage=$(echo "scale=1; $mem_used * 100 / $mem_total" | bc)
    disk_usage=$(df -h / | tail -1 | awk '{print $5}')
    
    echo -e "  CPU使用率: ${YELLOW}${cpu_usage}%${NC}"
    echo -e "  内存使用率: ${YELLOW}${mem_usage}% (${mem_used}MB/${mem_total}MB)${NC}"
    echo -e "  硬盘使用率: ${YELLOW}${disk_usage}${NC}"
    
    # 显示最近日志
    if [ -f "/var/log/vps-monitor.log" ]; then
        echo -e "${CYAN}最近日志:${NC}"
        tail -n 5 "/var/log/vps-monitor.log"
    fi
    
    echo ""
    echo -e "${CYAN}服务控制命令:${NC}"
    echo -e "  启动服务: ${YELLOW}systemctl start $SERVICE_NAME${NC}"
    echo -e "  停止服务: ${YELLOW}systemctl stop $SERVICE_NAME${NC}"
    echo -e "  重启服务: ${YELLOW}systemctl restart $SERVICE_NAME${NC}"
}

# 停止监控服务
stop_service() {
    show_banner
    echo -e "${CYAN}正在停止VPS监控服务...${NC}"
    
    if systemctl is-active --quiet $SERVICE_NAME; then
        systemctl stop "$SERVICE_NAME"
        echo -e "${GREEN}服务已停止${NC}"
    else
        echo -e "${YELLOW}服务未运行${NC}"
    fi
    
    echo -e "${CYAN}服务状态: $(systemctl is-active $SERVICE_NAME)${NC}"
}

# 查看监控日志
view_logs() {
    show_banner
    echo -e "${CYAN}VPS监控系统日志:${NC}"
    
    if [ -f "/var/log/vps-monitor.log" ]; then
        echo -e "${YELLOW}显示最近50行日志，按Ctrl+C退出${NC}"
        echo ""
        tail -n 50 -f "/var/log/vps-monitor.log"
    else
        echo -e "${RED}日志文件不存在${NC}"
        echo -e "${YELLOW}尝试查看系统日志:${NC}"
        journalctl -u "$SERVICE_NAME" -n 50 --no-pager
    fi
}

# 重启监控服务
restart_service() {
    show_banner
    echo -e "${CYAN}正在重启VPS监控服务...${NC}"
    
    if systemctl is-active --quiet $SERVICE_NAME; then
        systemctl restart "$SERVICE_NAME"
        echo -e "${GREEN}服务已重启${NC}"
    else
        systemctl start "$SERVICE_NAME"
        echo -e "${GREEN}服务已启动${NC}"
    fi
    
    echo -e "${CYAN}服务状态: $(systemctl is-active $SERVICE_NAME)${NC}"
}

# 修改配置
change_config() {
    show_banner
    echo -e "${CYAN}修改VPS监控系统配置:${NC}"
    echo -e "${YELLOW}直接输入新值，留空则保留当前值。${NC}"
    echo ""

    # 加载现有配置
    load_config || {
        echo -e "${RED}错误: 无法加载配置文件 $CONFIG_FILE。请先安装。${NC}"
        return 1
    }

    # 临时变量存储新值
    local new_api_key=""
    local new_server_id=""
    local new_worker_url=""
    local new_interval=""

    # 获取新API密钥
    read -p "新的API密钥 [当前: ${API_KEY}]: " new_api_key
    if [ -z "$new_api_key" ]; then
        new_api_key="$API_KEY" # 保留旧值
    fi

    # 获取新服务器ID
    read -p "新的服务器ID [当前: ${SERVER_ID}]: " new_server_id
    if [ -z "$new_server_id" ]; then
        new_server_id="$SERVER_ID" # 保留旧值
    fi

    # 获取新Worker URL
    read -p "新的Worker URL [当前: ${WORKER_URL}]: " new_worker_url
    if [ -z "$new_worker_url" ]; then
        new_worker_url="$WORKER_URL" # 保留旧值
    fi

    # 获取新上报间隔
    read -p "新的上报间隔 (秒) [当前: ${INTERVAL}]: " new_interval
    if [[ -n "$new_interval" && "$new_interval" =~ ^[0-9]+$ ]] && [ "$new_interval" -gt 0 ]; then
        INTERVAL="$new_interval"
    elif [ -n "$new_interval" ]; then # 如果输入了但无效
        echo -e "${RED}无效的上报间隔输入，保留当前值: ${INTERVAL} 秒${NC}"
    fi
    # 如果留空，INTERVAL 保持不变

    # 更新配置变量
    API_KEY="$new_api_key"
    SERVER_ID="$new_server_id"
    WORKER_URL="$new_worker_url"
    # INTERVAL 已经直接更新了

    # 保存配置
    echo -e "${YELLOW}正在保存配置...${NC}"
    save_config

    # 更新监控脚本
    echo -e "${YELLOW}正在更新监控脚本...${NC}"
    create_monitor_script

    # 重启服务
    echo -e "${YELLOW}正在重启服务以应用新配置...${NC}"
    restart_service # restart_service 内部会显示状态

    echo -e "${GREEN}配置已保存并重启服务。${NC}"
}

# 主菜单
show_menu() {
    while true; do
        show_banner
        echo -e "${CYAN}请选择操作:${NC}"
        echo -e "  ${GREEN}1.${NC} 安装监控系统"
        echo -e "  ${GREEN}2.${NC} 卸载监控系统"
        echo -e "  ${GREEN}3.${NC} 查看监控状态"
        echo -e "  ${GREEN}4.${NC} 查看监控日志"
        echo -e "  ${GREEN}5.${NC} 停止监控服务"
        echo -e "  ${GREEN}6.${NC} 重启监控服务"
        echo -e "  ${GREEN}7.${NC} 修改配置"
        echo -e "  ${GREEN}0.${NC} 退出"
        echo ""
        read -p "请输入选项 [0-7]: " choice
        
        case $choice in
            1) install_monitor ;;
            2) uninstall_monitor ;;
            3) check_status ;;
            4) view_logs ;;
            5) stop_service ;;
            6) restart_service ;;
            7) change_config ;;
            0) exit 0 ;;
            *) echo -e "${RED}无效的选择，请重试${NC}" ;;
        esac
        
        echo ""
        read -p "按Enter键继续..."
    done
}

# 解析命令行参数
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -k|--key)
                API_KEY="$2"
                shift 2
                ;;
            -s|--server)
                SERVER_ID="$2"
                shift 2
                ;;
            -u|--url)
                WORKER_URL="$2"
                shift 2
                ;;
            -d|--dir)
                INSTALL_DIR="$2"
                shift 2
                ;;
            -t|--interval)
                if [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -gt 0 ]; then
                    INTERVAL="$2"
                else
                    echo -e "${RED}错误: 无效的上报间隔 '$2'。必须是正整数。${NC}"
                    exit 1
                fi
                shift 2
                ;;
            -i|--install)
                DIRECT_INSTALL=1
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                echo -e "${RED}未知参数: $1${NC}"
                show_help
                exit 1
                ;;
        esac
    done
}

# 显示帮助信息
show_help() {
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  -k, --key KEY        API密钥"
    echo "  -s, --server ID      服务器ID"
    echo "  -u, --url URL        Worker URL"
    echo "  -t, --interval SECS  上报间隔 (秒, 默认: 60)"
    echo "  -d, --dir DIR        安装目录 (默认: /opt/vps-monitor)"
    echo "  -i, --install        直接安装，不显示菜单"
    echo "  -h, --help           显示此帮助信息"
    echo ""
    echo "示例:"
    echo "  $0                   显示交互式菜单"
    echo "  $0 -i -k API_KEY -s SERVER_ID -u https://example.workers.dev -t 300"
    echo "                       直接安装监控系统，上报间隔为300秒"
}

# 主函数
main() {
    check_root
    
    # 加载现有配置
    load_config
    
    # 解析命令行参数
    parse_args "$@"
    
    # 直接安装或显示菜单
    if [ "$DIRECT_INSTALL" = "1" ]; then
        install_monitor
    else
        show_menu
    fi
}

# 执行主函数
main "$@"
