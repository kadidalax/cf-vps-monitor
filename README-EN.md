# cf-vps-monitor
[简体中文](https://github.com/kadidalax/cf-vps-monitor/blob/main/README.md) | [English](https://github.com/kadidalax/cf-vps-monitor/blob/main/README-EN.md)

## VPS monitoring probe + website detection panel built with Cloudflare Worker.

Panel Demo: https://vps-monitor.abo-vendor289.workers.dev/

PC Frontend:

![image](https://github.com/kadidalax/cf-vps-monitor/blob/main/pic/front.jpg)

Mobile Frontend:

![image](https://github.com/kadidalax/cf-vps-monitor/blob/main/pic/mobile.jpg)

Backend:

![image](https://github.com/kadidalax/cf-vps-monitor/blob/main/pic/back.jpg)

# VPS Monitoring Panel (Cloudflare Worker + D1) - Deployment Guide

This is a simple VPS monitoring panel deployed on Cloudflare Workers, using Cloudflare D1 database for data storage. This guide will walk you through the deployment process using the Cloudflare **web dashboard**, without requiring command-line tools.

## Prerequisites

* A Cloudflare account.

## Deployment Steps

### 1. Create D1 Database

You need a D1 database to store panel data (server list, API keys, monitoring data, etc.).

1. Log in to the Cloudflare dashboard.
2. In the left menu, find and click `Storage & Databases`.
3. In the dropdown menu, select `D1 SQL Database`.
4. Click `Create Database`.
5. Name your database (e.g., `vps-monitor-db`), then click `Create`.

### 2. Create and Configure Worker

Next, create a Worker and deploy the code.

1. In the left menu, click `Compute (Workers)`, select `Workers & Pages`.
2. On the overview page, click `Create`.
3. Select `Start with Hello World!` and click `Get Started`.
4. Name your Worker (e.g., `vps-monitor-worker`), ensure the name is available.
5. Click `Deploy`.
6. After deployment, click `Edit Code` to enter the Worker editor.
7. **Delete all existing code** in the editor.
8. Open the `worker.js` file from this repository and copy **all** its content.
9. Paste the copied code into the Cloudflare Worker editor.
10. Click the `Deploy` button in the top-right corner of the editor.

### 3. Add Environment Variables

In `Settings` → `Variables and Secrets`, add the following environment variables for enhanced security:
1. Optional Variable Name: `USERNAME`, Type: `Secret`, Value: `Any random string`
2. Optional Variable Name: `PASSWORD`, Type: `Secret`, Value: `Any random string`
3. Variable Name: `JWT_SECRET`, Type: `Secret`, Value: `Any random string of about 30 characters`
4. Save and deploy after adding

### 4. Bind D1 Database to Worker

The Worker needs access to the D1 database you created earlier.

1. In the Worker management page (click the Worker name above the edit code page to return to management page), select the `Bindings` tab.
2. Select `D1 Database`.
3. Enter `DB` (must be uppercase) in the `Variable Name` field.
4. In the `D1 Database` dropdown, select the database you created earlier (e.g., `vps-monitor-db`).
5. Click `Deploy`.
6. **Important! Initialize Database:** Copy your Worker URL to browser and append `/api/init-db`, like `vps-monitor.abo-vendor289.workers.dev/api/init-db`. Opening this link should show `{"success":true,"message":"数据库初始化完成"}` indicating the database is ready.

### 5. Set Trigger Frequency (for website monitoring)

1. In the Worker management page, select the `Settings` tab.
2. In the settings page, select the `Triggers` submenu.
3. Click `Add`, select `Cron Trigger`.
4. Select `Schedule`, set Worker execution frequency to `Hourly`, fill in 1 in the box below (i.e., check websites every hour).
5. Click `Add`.

### 6. Access Panel

After deployment and binding are complete, your monitoring panel should be accessible via the Worker's URL.

* In the settings page, you'll see a `.workers.dev` URL, e.g., `vps-monitor.abo-vendor289.workers.dev`.
* Open this URL in your browser, and you should see the monitoring panel's frontend interface.

## Using the Panel

### 1. Initial Login

1. Visit your Worker URL.
2. Click `Login` in the top-right corner of the page or directly access the `/login` path (e.g., `https://vps-monitor.abo-vendor289.workers.dev/login`).
3. Login with environment variable credentials or default credentials:
   * Default Username: `admin`
   * Default Password: `monitor2025!`
4. After login, change the password immediately! Change the password immediately! Change the password immediately!!!

### 2. Add Server

1. After logging into the backend, you should see the management interface.
2. Find the option to add a server.
3. Enter the server name and optional description.
4. Click `Save`.
5. The panel will automatically generate a unique `Server ID` and `API Key`, which can be viewed in the backend at any time and are needed when deploying the Agent.

### 3. Deploy Agent (Probe)

The Agent is a script that needs to run on your VPS to collect status information and send it back to the panel.

There are two ways to install the Agent script:

First method is to copy the command with parameters directly from the backend for one-click installation (recommended):
![image](https://github.com/kadidalax/cf-vps-monitor/blob/main/pic/setting.jpg)

Second method: Download and run the script:
```
wget -O cf-vps-monitor.sh https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/main/cf-vps-monitor.sh && chmod +x cf-vps-monitor.sh && ./cf-vps-monitor.sh
```
Or download and run the script:
```
curl -O https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/main/cf-vps-monitor.sh && chmod +x cf-vps-monitor.sh && ./cf-vps-monitor.sh
```
* Installation requires `Server ID`, `API Key`, and your `Worker URL`
* You can click `View Key` in the backend to get these three parameters
* Follow the prompts to complete installation. After installation, the Agent will start sending data to your panel regularly. You should see status updates for the corresponding server on the panel.

### 4. Agent Management

The installation script itself also provides management functions:

* **Install Service:**
* **Uninstall Service:**
* **View Status:**
* **View Logs:**
* **Stop Service:**
* **Restart Service:**
* **Modify Configuration:**

### 5. Add Website Monitoring

1. After logging into the backend, you should see the management interface.
2. Click `Add Monitoring Website`.
3. Enter `Website Name (optional)` and `Website URL (e.g., https://example.com)`.
4. Click `Save`.

### 6. Configure Telegram Notifications

1. Create a bot with BotFather and get the `Bot Token`.
2. Get your `ID` from `@userinfobot`.
3. Fill in both items above respectively.
4. Enable notifications, click `Save Telegram Settings` and you'll receive a test notification, indicating correct configuration.

### 7. Configure Custom Background and Transparency

1. Find a nice background image.
2. Upload this image to an image hosting service and get the image link (e.g., https://i.111666.best/image/QbF51RYyzcHFTBnOhICxdY.jpg).
3. Fill this link into the background image URL field and check `Enable Custom Background`.
4. Adjust the `Panel Transparency` slider.
5. Click `Save Background Settings`.

## Notes

* **Worker and D1 Daily Quotas:** Cloudflare Worker and D1 free tiers have limitations. Please refer to Cloudflare documentation for details.
* **Security:** The default password is very insecure. Please change it immediately after first login. API keys used by the Agent should also be kept secure.
* **Error Handling:** If the panel or Agent encounters issues, you can check the Worker logs (in the Cloudflare dashboard Worker page) and Agent logs.
* All content and code above are AI-generated. If you encounter problems, please take the code directly to AI for help.

### Sponsorship Welcome🤣:

[![Powered by DartNode](https://dartnode.com/branding/DN-Open-Source-sm.png)](https://dartnode.com "Powered by DartNode - Free VPS for Open Source")
