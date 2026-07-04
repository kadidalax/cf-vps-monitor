# CF VPS Monitor

CF VPS Monitor 是一个轻量 VPS 探针面板，使用 Cloudflare Workers 承载前端、API、实时连接和定时任务，使用 Durable Objects 协调实时状态，使用 Supabase Postgres 保存配置和历史数据，使用 Go Agent 在服务器上采集指标。


## 特性

- **服务器监控**：在线状态、CPU、GPU、内存、Swap、磁盘、负载、温度、网络速率、月度流量、系统信息、IPv4/IPv6、进程数、TCP/UDP 连接数。
- **实时看板**：首页、节点详情页和后台首页通过 WebSocket 获取实时数据。
- **Ping 监控**：支持 ICMP、TCP、HTTP Ping 任务，可分配到全部节点或指定节点，并展示延迟历史。
- **网站监控**：支持 HTTP/HTTPS GET、HTTP/HTTPS HEAD 和 TCP 检测，支持期望状态码、超时、间隔、启停、隐藏、排序、手动检测和 Agent 节点侧探测。
- **后台管理**：节点增删改、批量隐藏/删除、拖拽排序、记录清理、Agent Token 轮换、安装命令生成、系统设置、审计日志、健康检查、容量估算、备份恢复、账号改名和改密。
- **通知**：支持 Telegram 和 SMTP Email，可配置离线、到期、负载以及网站监控相关通知。
- **主题**：内置 `monitor` 和 `next` 主题，支持主题包、自定义 CSS、图片和字体资源。
- **管理员恢复**：首次登录时创建管理员；忘记账号或密码时，可在登录页用 Supabase `service_role` key 重置唯一管理员。
- **省配额策略**：有实时观看者时 Agent 约 3 秒采集并上报；无人查看时约 120 秒采样并批量上报，足可监控50台服务器。

## 预览图

<img width="1696" height="965" alt="image" src="https://github.com/user-attachments/assets/fbd8bab6-258a-44e0-96c3-106fd7b26fae" />
<img width="1695" height="954" alt="image" src="https://github.com/user-attachments/assets/1afbd54b-1320-4635-be4f-1cf291748abd" />
<img width="1698" height="955" alt="image" src="https://github.com/user-attachments/assets/b9e6be02-bc41-49d5-a7d6-f57a2b9c8b32" />



## 架构

| 目录 | 说明 |
| --- | --- |
| `frontend/` | React + Vite + Radix UI + Tailwind，构建产物由 Workers Static Assets 托管 |
| `worker/` | Hono Worker、Durable Objects、Cron Triggers、Supabase HTTP RPC 数据层 |
| `agent/` | Go Agent，支持 WebSocket/HTTP 上报和 Linux/Windows 安装脚本 |
| `supabase/migrations/` | Supabase 表、索引、RLS、RPC、授权和默认数据 |
| `scripts/` | 部署和迁移清单生成脚本 |

## 运行时配置


| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `SUPABASE_URL` | Variable | Supabase Project URL，例如 `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Supabase `service_role` 或 Secret key，不能使用 anon key |
| `JWT_SECRET` | Secret | 后台会话签名密钥，建议使用随机字符串 |

## 面板部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kadidalax/cf-vps-monitor)

Cloudflare deploy 后请在 `Settings -> Variables & Secrets` 确认三项运行时配置已存在。

适合不使用命令行的用户。

1. 在 [Supabase](https://supabase.com/dashboard/) 创建或选择项目。
2. 打开 Supabase 项目 **Project Overview**页面 复制 `Project URL`, 打开**Project Settings -> API Keys**页面，复制`service_role` key (Secret keys)。
3. 点击 上面的**Deploy to Cloudflare**。
4. 登录 Cloudflare, 选择账号、仓库名和 Worker 名称。
5. 填入对应变量的值 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`JWT_SECRET`。
6. 点击部署。
7. 去[Supabase](https://supabase.com/dashboard/account/tokens) 创建有效期1小时的Access Token
8. 打开 `https://你的 Worker 域名/db-init` 填入Access Token 初始化数据库。
9. 首次部署后访问 `/admin/login` 创建管理员。

## 命令行部署

适合本地开发或维护者。

```powershell
npm ci
npm run build
npx wrangler login
$env:SUPABASE_URL="https://xxxx.supabase.co"
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put JWT_SECRET
npm run deploy
```


## 使用流程

1. 登录后台。
2. 在“服务器”添加节点。
3. 打开节点安装命令，选择 Linux 或 Windows。
4. 在 VPS 上执行安装命令，等待 Agent 上线。
5. 需要 Ping 监控时，在“Ping”创建任务。
6. 需要网站监控时，在“网站”创建 HTTP/HTTPS 或 TCP 检测目标。
7. 需要告警时，在“通知”配置 Telegram 或 SMTP Email。


同一台服务器可以安装多个 Agent 实例。每个安装命令会带独立 `instance-id`，默认生成独立服务名和安装目录。

卸载单个 Linux 实例：

```bash
sudo ./install-linux.sh --uninstall -i 实例ID
```

卸载单个 Windows 实例：

```powershell
.\install-windows.ps1 -Uninstall -i '实例ID'
```

只有执行 `--uninstall-all --yes` 或 `-UninstallAll -Yes` 才会清理本机全部 Agent 实例。

## 本地开发

```bash
npm ci
npm run dev:frontend
npm run dev:worker
```

常用检查：

```bash
npm run build:migrations
npm run verify
cd agent && go test ./...
```


## 安全

- 后台登录使用 HttpOnly 会话 Cookie，非安全写请求需要 CSRF 校验。
- 登录失败会记录限流状态和审计日志。
- Agent 使用节点 Token 认证，后台可轮换节点 Token。
- Ping 与网站探测会拦截内网、回环、链路本地、组播、保留地址和元数据地址。
- Supabase 迁移启用 RLS，并对 RPC 函数显式 `revoke` / `grant`；需要 `security definer` 的函数固定 `search_path`。
- 忘记密码重置需要输入当前部署的 Supabase `service_role` key；该 key 只用于本次请求校验，不会被保存。

## 许可证

本项目使用 [MIT License](LICENSE)。

## 参考文档

- [Cloudflare Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Supabase Management API](https://supabase.com/docs/reference/api/introduction)
- [Supabase Data API Security](https://supabase.com/docs/guides/api/securing-your-api)


## Star History

<a href="https://www.star-history.com/?repos=kadidalax%2Fcf-vps-monitor&type=timeline&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=kadidalax/cf-vps-monitor&type=timeline&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=kadidalax/cf-vps-monitor&type=timeline&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=kadidalax/cf-vps-monitor&type=timeline&legend=top-left" />
 </picture>
</a>
