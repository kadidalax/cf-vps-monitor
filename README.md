![Stars](https://img.shields.io/github/stars/kadidalax/cf-vps-monitor?style=for-the-badge&logo=github&label=Stars&color=ffb000) ![Forks](https://img.shields.io/github/forks/kadidalax/cf-vps-monitor?style=for-the-badge&logo=github&label=Forks&color=2ea44f) ![License](https://img.shields.io/github/license/kadidalax/cf-vps-monitor?style=for-the-badge&color=blue)
# CF VPS Monitor

CF VPS Monitor 是一个轻量 VPS 探针面板，使用 Cloudflare Workers 承载前端、API、实时连接和定时任务，使用 Durable Objects 协调实时状态，使用 Supabase Postgres 保存配置和历史数据，使用 Go Agent 在服务器上采集指标。


## 特性

- **服务器监控**：在线状态、CPU、GPU、内存、Swap、磁盘、负载、温度、网络速率、月度流量、账单、到期时间、系统信息、IPv4/IPv6、进程数、TCP/UDP 连接数。
- **实时看板**：首页、节点详情页和后台首页通过 WebSocket 获取实时数据。
- **Ping 监控**：支持 ICMP、TCP、HTTP Ping 任务，可分配到全部节点或指定节点，并展示延迟历史。
- **网站监控**：支持 HTTP/HTTPS GET、HTTP/HTTPS HEAD 和 TCP 检测，支持期望状态码、超时、间隔、启停、隐藏、排序、手动检测和 Agent 节点侧探测。
- **后台管理**：节点增删改、批量隐藏/删除、拖拽排序、记录清理、Agent Token 轮换、安装命令生成、系统设置、审计日志、健康检查、容量估算、备份恢复、账号改名和改密。
- **通知**：支持 Telegram 、 SMTP Email 和 Webhook，可配置离线、到期、负载以及网站监控相关通知。
- **主题**：内置 `monitor` 和 `next` 主题，支持主题包、自定义 CSS、图片和字体资源。
- **管理员恢复**：首次登录时创建管理员；忘记账号或密码时，可在登录页用当前部署的 Supabase Secret key 重置唯一管理员。
- **省配额策略**：有实时观看者时 Agent 约 3 秒采集并上报；无人查看时约 120 秒采样并批量上报，足可监控50台服务器。

## 预览图

<img width="960" height="540" alt="cf-vps-monitor-promo-full-mobile" src="https://github.com/user-attachments/assets/78a5c78b-143c-4874-aa6e-4dbe17c3597d" />



## 架构

| 目录 | 说明 |
| --- | --- |
| `frontend/` | React + Vite + Radix UI + Tailwind，构建产物由 Workers Static Assets 托管 |
| `worker/` | Hono Worker、Durable Objects、Cron Triggers、Supabase HTTP RPC 数据层 |
| `agent/` | Go Agent，支持 WebSocket/HTTP 上报和 Unix/Windows 安装脚本 |
| `supabase/migrations/` | Supabase 表、索引、RLS、RPC、授权和默认数据 |
| `scripts/` | 部署和迁移清单生成脚本 |

## 运行时配置


| 名称                    | 类型       | 说明                                                                    |
| --------------------- | -------- | --------------------------------------------------------------------- |
| `SUPABASE_URL`        | Variable | Supabase Project URL，例如 `https://xxxx.supabase.co`                    |
| `SUPABASE_SECRET_KEY` | Secret   | Supabase Secret key，通常以 `sb_secret_` 开头；不要填写 Publishable key、anon key |
| `JWT_SECRET`          | Secret   | 后台会话签名密钥，必须至少 32 字节；英文/数字不少于 32 个字符                                   |

`SUPABASE_SERVICE_ROLE_KEY` 仅作为旧部署兼容变量保留；新部署请使用 `SUPABASE_SECRET_KEY`。

## 面板部署

### Fork 原仓库部署【推荐，方便更新】


1. 在 [Supabase](https://supabase.com/dashboard/) 创建或选择项目。
2. 打开 Supabase 项目 **Project Overview** 页面复制 `Project URL`；打开 **Project Settings -> API Keys -> Publishable and secret API keys**，复制 **Secret keys** 中的 `default` Secret key，格式通常为 `sb_secret_...`。
3. Fork [本仓库](https://github.com/kadidalax/cf-vps-monitor)， 创建自己的仓库。到Actions 选择**Agent Release** 点击**Run workflow** 填入创建自己的版本号，再次点击**Run workflow** 创建自己仓库的Agent 安装脚本。
4. 打开 Cloudflare Dashboard 的 **Workers & Pages**，点击 **创建应用程序**， 点击**Continue with GitHub**。
5. 选择 GitHub 账号和刚创建的 Fork 仓库，点击**下一步**。
6. 展开 **高级设置** 配置三个变量 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`JWT_SECRET`。`JWT_SECRET` 必须至少 32 字节，英文/数字不少于 32 个字符。
7. 保持默认 **构建命令** `npm run build`，将 **部署命令** 设置为 `npm run deploy`。
8. 点击 **部署**。
9. 如果 Cloudflare 里创建的 Worker 名称不是 `cf-vps-monitor`，需要同步修改 Fork 仓库的 `wrangler.toml` 里的 `name`，两者必须一致。
10. 去 [Supabase](https://supabase.com/dashboard/account/tokens) 创建有效期 1 小时的 Access Token。
11. 打开 `https://你的 Worker 域名/db-init` 初始化数据库，首次部署后访问 `/admin/login` 创建管理员。



### 直接一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kadidalax/cf-vps-monitor)

1. 在 [Supabase](https://supabase.com/dashboard/) 创建或选择项目。
2. 打开 Supabase 项目 **Project Overview** 页面复制 `Project URL`；打开 **Project Settings -> API Keys -> Publishable and secret API keys**，复制 **Secret keys** 中的 `default` Secret key，格式通常为 `sb_secret_...`。
3. 点击 上面的**Deploy to Cloudflare**。
4. 登录 Cloudflare, 选择账号、仓库名和 Worker 名称。
5. 填入对应变量的值 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`JWT_SECRET`。`JWT_SECRET` 必须至少 32 字节，英文/数字不少于 32 个字符。
6. 保持默认 **构建命令** `npm run build`，将 **部署命令** 设置为 `npm run deploy`。
7. 点击 **部署**。
8. 去 [Supabase](https://supabase.com/dashboard/account/tokens) 创建有效期 1 小时的 Access Token。
9. 打开 `https://你的 Worker 域名/db-init` 初始化数据库，首次部署后访问 `/admin/login` 创建管理员。
10. 建议后续每次版本更新后都执行一次初始化数据库(不会丢失数据)。


## 命令行部署

适合本地开发或维护者。

```powershell
npm ci
npm run build
npx wrangler login
$env:SUPABASE_URL="https://xxxx.supabase.co"
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put JWT_SECRET
npm run deploy
```



## 使用流程

1. 登录后台。
2. 在“服务器”添加节点。
3. 打开节点安装命令，选择 Unix 自动检测或 Windows。复制安装命令。请确认你的安装脚本指向的仓库有效且你已经在actions里运行了创建agent脚本的workflow。
4. 在 VPS 上执行安装命令，等待 Agent 上线。
5. 需要 Ping 监控时，在“Ping”创建任务。
6. 需要网站监控时，在“网站”创建 HTTP/HTTPS 或 TCP 检测目标。
7. 需要告警时，在“通知”配置 Telegram、SMTP Email 或 webhook推送。


同一台服务器可以安装多个 Agent 实例。每个安装命令会带独立 `instance-id`，默认生成独立服务名和安装目录。

Unix 安装命令会自动判断 Linux、Alpine/OpenRC、macOS、FreeBSD，以及 root/非 root 环境。非 root 或 Serv00 这类共享主机会安装到用户目录，并使用 `nohup` + `crontab @reboot` 尝试保持后台运行。

卸载单个 Unix 实例：

```bash
wget -qO- 'https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/refs/heads/main/agent/install.sh' | sh -s -- --uninstall -i 实例ID
```

卸载单个 Windows 实例：

```powershell
.\install-windows.ps1 -Uninstall -i '实例ID'
```

只有执行 `--uninstall-all --yes` 或 `-UninstallAll -Yes` 才会清理本机全部 Agent 实例。

## 后台一键同步更新

后台固定检测 [kadidalax/cf-vps-monitor](https://github.com/kadidalax/cf-vps-monitor) `main` 分支的最新推送编码。进入后台 `关于 -> 版本更新`，保存“你的部署仓库地址”，以后检测到推送编码不一致时会显示同步入口。

### 如果是 Fork 原仓库部署【推荐】

适合先 Fork 官方仓库，再在 Cloudflare Workers Builds 里连接这个 Fork 仓库的部署方式。

1. 在后台 `关于 -> 版本更新`：
   - `你的部署仓库地址` 填你的 Fork 仓库地址，例如 `https://github.com/用户名/cf-vps-monitor`
   - 点击 `保存设置`
2. 后台检测到更新后，点击 `前往同步 Fork`，打开你的 Fork 仓库首页。
3. 在 GitHub 仓库文件列表上方点击 `Sync fork` 下拉菜单。
4. 确认上游提交后点击 `Update branch`。
5. 如果 GitHub 提示冲突，需要按提示创建 PR 或手动解决冲突。
6. Fork 更新产生的 push 会触发 Cloudflare Workers Builds 自动构建部署。
7. **更新后最好初始化一下数据库，否则可能无法使用**

### 如果是 Deploy Button 一键部署

Cloudflare 一键部署自动创建的仓库不保证包含可用的更新工作流，后台不再提供这类更新入口。需要后续稳定同步更新时，建议改用上面的 Fork 原仓库部署方式。


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
- 忘记密码重置需要输入当前部署的 Supabase Secret key；该 key 只用于本次请求校验，不会被保存。

## 许可证

本项目使用 [MIT License](LICENSE)。

## 参考文档

- [Cloudflare Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Supabase Management API](https://supabase.com/docs/reference/api/introduction)
- [Supabase API Keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Migrating to new API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
- [Supabase Data API Security](https://supabase.com/docs/guides/api/securing-your-api)


## Star History

<a href="https://www.star-history.com/?repos=kadidalax%2Fcf-vps-monitor&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=kadidalax/cf-vps-monitor&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=kadidalax/cf-vps-monitor&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=kadidalax/cf-vps-monitor&type=date&legend=top-left" />
 </picture>
</a>
