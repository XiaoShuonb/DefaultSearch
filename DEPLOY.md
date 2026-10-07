# DefaultSearch 服务器部署

本项目没有 Web 面板，不需要域名、不需要 Nginx、不需要开放端口。服务器只需要能访问：

- Telegram Bot API
- TronGrid 官方 API
- OKX U 价 API

需要 Node.js 24+。

部署目录示例：

```text
/opt/usdtbot
```

## 部署步骤

```bash
sudo mkdir -p /opt/usdtbot
sudo chown "$USER":"$USER" /opt/usdtbot
```

上传本项目文件到 `/opt/usdtbot`，然后：

```bash
cd /opt/usdtbot
cp .env.example .env
nano .env
```

填写：

```env
BOT_TOKEN=
OWNER_ID=
```

`TRON_GRID_API_KEY` 可不填。留空时地址查询和监控都走公共 TronGrid 接口；监控多个地址时如果被限速，再填写自己的 TronGrid API Key。

创建低权限用户：

```bash
sudo useradd --system --home /opt/usdtbot --shell /usr/sbin/nologin usdtbot || true
sudo mkdir -p /opt/usdtbot/data
sudo chown -R usdtbot:usdtbot /opt/usdtbot
sudo chmod 700 /opt/usdtbot/data
sudo chmod 600 /opt/usdtbot/.env
```

安装服务：

```bash
sudo cp /opt/usdtbot/usdtbot.service.example /etc/systemd/system/usdtbot.service
sudo systemctl daemon-reload
sudo systemctl enable --now usdtbot
sudo systemctl status usdtbot
```

看日志：

```bash
sudo journalctl -u usdtbot -f
```

## systemd 示例

```ini
[Unit]
Description=DefaultSearch
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/usdtbot
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/usdtbot/.env
User=usdtbot
Group=usdtbot
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/usdtbot/data

[Install]
WantedBy=multi-user.target
```
