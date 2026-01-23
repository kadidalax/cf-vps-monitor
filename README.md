# 自从上次更新以来，由于一直太忙没空搞，预计年后会有时间，会把一些问题尽量修复，感谢各位一直以来的支持！

# cf-vps-monitor
[简体中文](https://github.com/kadidalax/cf-vps-monitor/blob/main/README.md) | [English](https://github.com/kadidalax/cf-vps-monitor/blob/main/README-EN.md)
## 用cloudflare worker搭建的vps探针 + 网站检测面板。
面板示例：https://vps-monitor.abo-vendor289.workers.dev/

PC端前台：

![image](https://github.com/kadidalax/cf-vps-monitor/blob/main/pic/front.jpg)

移动端前台：

![image](https://github.com/kadidalax/cf-vps-monitor/blob/main/pic/mobile.jpg)

后台：

![image](https://github.com/kadidalax/cf-vps-monitor/blob/main/pic/back.jpg)



# VPS 监控面板 (Cloudflare Worker + D1 版) - 部署指南

这是一个部署在 Cloudflare Workers 上的简单 VPS 监控面板，使用 Cloudflare D1 数据库存储数据。本指南将引导你通过 Cloudflare **网页控制面板** 完成部署，无需使用命令行工具。

## 先决条件

*   一个 Cloudflare 账户。

## 部署步骤

### 1. 创建 D1 数据库

你需要一个 D1 数据库来存储面板数据（服务器列表、API 密钥、监控数据等）。

1.  登录 Cloudflare 控制面板。
2.  在左侧菜单中，找到并点击 `存储和数据库`。
3.  在下拉菜单中，选择 `D1 SQL 数据库`。
4.  点击 `创建数据库`。
5.  为数据库命名（例如 `vps-monitor-db`），然后点击 `创建`。
### 2. 创建并配置 Worker

接下来，创建 Worker 并将代码部署上去。

1.  在左侧菜单中，点击 `计算(Workers)`，选择 `Workers & Pages`。
2.  在概览页面，点击 `创建`。
3.  选择 `Start with Hello World!`点击`开始使用`。
4.  为你的 Worker 命名（例如 `vps-monitor-worker`），确保名称可用。
5.  点击 `部署`。
6.  部署完成后，点击 `编辑代码` 进入 Worker 编辑器。
7.  **删除编辑器中现有的所有代码**。
8.  打开本仓库的 `worker.js` 文件，复制其**全部**内容。
9.  将复制的代码粘贴到 Cloudflare Worker 编辑器中。
10. 点击编辑器右上角的 `部署` 按钮。

### 3. 添加环境变量

在 `设置` → `变量和机密` 中添加以下环境变量，以增加安全性：
1. 可选变量名：`USERNAME`，类型：`密钥`， 值：`任意随机字符串`
2. 可选变量名：`PASSWORD`，类型：`密钥`， 值：`任意随机字符串`
3. 变量名：`JWT_SECRET`，类型：`密钥`， 值：`任意30位左右的随机字符串`
4. 添加完保存并部署

### 4. 绑定 D1 数据库到 Worker

Worker 需要访问你之前创建的 D1 数据库。

1.  在 Worker 的管理页面（编辑代码页面上方有 Worker 名称，点击它可以返回管理页面），选择 `绑定` 标签页。
2.  选择`D1数据库`。
3.  在 `变量名称` 处输入 `DB` (必须大写)。
4.  在 `D1 数据库` 下拉菜单中，选择你之前创建的数据库 (例如 `vps-monitor-db`)。
5.  点击 `部署`。
6.  **重要！初始化数据库：** 复制你的Worker URL到浏览器，后面加上`/api/init-db`，如`vps-monitor.abo-vendor289.workers.dev/api/init-db`，打开此链接后会看到 `{"success":true,"message":"数据库初始化完成"}` 即表明数据库已准备完毕。

### 5. 设置触发频率（检测网站用）

1.  在 Worker 的管理页面选择 `设置` 标签页。
2.  在设置页面中，选择 `触发事件` 子菜单。
3.  点击`添加`，选择`Cron触发器`。
4.  选择`计划`，执行 Worker 的频率选择`小时`，下面的框填入1（即每整点检测一次网站）。
5.  点击`添加`。

### 6. 访问面板

部署和绑定完成后，你的监控面板应该可以通过 Worker 的 URL 访问了。

*   在设置页面你会看到一个 `.workers.dev` 的 URL，例如 `vps-monitor.abo-vendor289.workers.dev`。
*   在浏览器中打开这个 URL，你应该能看到监控面板的前端界面。

## 使用面板

### 1. 初始登录

1.  访问你的 Worker URL。
2.  点击页面右上角的 `登录` 或直接访问 `/login` 路径 (例如 `https://vps-monitor.abo-vendor289.workers.dev/login`)。
3.  使用环境变量凭证或默认凭据登录：
    *   默认用户名: `admin`
    *   默认密码: `monitor2025!`
4.  登录后，立即修改密码！立即修改密码！立即修改密码！！！

### 2. 添加服务器

1.  登录后台后，你应该会看到管理界面。
2.  找到添加服务器的选项。
3.  输入服务器的名称和可选的描述。
4.  点击 `保存`。
5.  面板会自动生成一个唯一的 `服务器 ID` 和 `API 密钥`，后台可以随时查看，部署 Agent 时需要用到。

### 3. 部署 Agent (探针)

Agent 是一个需要在你的 VPS 上运行的脚本，用于收集状态信息并发送回面板。

有两种方式安装Agent脚本：

第一种是直接从后台复制带有参数的命令一键安装（推荐）
![image](https://github.com/kadidalax/cf-vps-monitor/blob/main/pic/setting.jpg)

第二种是：下载脚本并运行：
```
wget -O cf-vps-monitor.sh https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/main/cf-vps-monitor.sh && chmod +x cf-vps-monitor.sh && ./cf-vps-monitor.sh
```
或者下载脚本并运行：
```
curl -O https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/main/cf-vps-monitor.sh && chmod +x cf-vps-monitor.sh && ./cf-vps-monitor.sh
```
*   安装需要  `服务器ID` `API密钥` 和你的 `worker网址`
*   可以在后台点击 `查看密钥` 来获取上述三个参数
*   按照提示输入安装完成后，Agent 会开始定期向你的面板发送数据。你应该能在面板上看到对应服务器的状态更新。

### 4. Agent 管理

安装脚本本身也提供了管理功能：

*   **安装服务:** 
*   **卸载服务:** 
*   **查看状态:** 
*   **查看日志:** 
*   **停止服务:**
*   **重启服务:**
*   **修改配置:**

### 5. 添加检测网站

1.  登录后台后，你应该会看到管理界面。
2.  点击`添加监控网站`。
3.  输入`网站名称（可选）`和`网站URL 如(https://example.com)`。
4.  点击`保存`。

### 6. 配置Telegram 通知

1.  BotFather创建bot并获取`Bot Token`。
2.  `@userinfobot`获取自己的`ID`。
3.  将上述两项分别填入。
4.  启用通知，点击`保存Telegram设置`后会受到一条测试通知，说明配置正确。

### 7. 配置自定义背景和透明度

1.  找一张好看的背景图。
2.  上传到图床，得到该图的链接（如：https://i.111666.best/image/QbF51RYyzcHFTBnOhICxdY.jpg ）
3.  将此链接填入背景图片URL框，并勾选 `启用自定义背景`。
4.  调整 `面透明度` 滑块。
5.  点击 `保存背景设置`

## 注意事项

*   **Worker 和 D1 每日配额:** 本项目当前最大的限制是Worker请求数，主要是vps上报数据的消耗，每日请求数可以用这个公式计算：vps数量 *（86400/上报频率），得到的数字再除以100000就是已消耗百分比。
*   **安全性:** 默认密码非常不安全 ，请务必在首次登录后修改。Agent 使用的 API 密钥也应妥善保管。
*   **错误处理:** 如果面板或 Agent 遇到问题，可以检查 Worker 的日志（在 Cloudflare 控制面板 Worker 页面）和 Agent 的日志。
*   以上所有内容和代码均为AI生成，出现问题请直接拿着代码找AI吧。

### 诚邀赞助🤣：

[![Powered by DartNode](https://dartnode.com/branding/DN-Open-Source-sm.png)](https://dartnode.com "Powered by DartNode - Free VPS for Open Source")
