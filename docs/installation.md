# 安装与升级

[文档导航](README.md) · [使用说明](usage.md) · [运行维护](operations.md)

## 运行要求

- Windows、Linux 或 macOS，x64/arm64。
- Node.js ≥24.15.0。系统版本不合适时，安装器从官方站点下载私有 Node 24 运行时并校验 SHA-256，不替换系统 Node.js。
- Linux/macOS 需要 bash、curl、tar，以及 sha256sum 或 shasum。
- 能访问 GitHub 发布包、Node.js 官方下载站和库库AI服务。

默认下载 GitHub Actions 预先构建的控制台与后端，校验后解压、初始化 SQLite 并启动。**安装和升级均不在用户服务器构建前端，不安装前端依赖。** 发布包不可用或校验失败会停止，不自动切换为源码构建。

## 一键安装

Linux / macOS：

```bash
curl -fsSL https://raw.githubusercontent.com/IKUNHEIHIE/kuku2api/main/install.sh -o /tmp/kuku2api-install.sh && bash /tmp/kuku2api-install.sh
```

Windows PowerShell：

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/IKUNHEIHIE/kuku2api/main/install.ps1 -OutFile "$env:TEMP\kuku2api-install.ps1"
& "$env:TEMP\kuku2api-install.ps1"
```

若 Windows 执行策略阻止脚本，可检查下载文件后仅对本次进程放行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\kuku2api-install.ps1"
```

默认安装到用户目录下的 `kuku2api`。首次交互安装询问运行端口，默认 `8787`；占用时推荐可用端口，用户可重新选择，不停止占用端口的其他服务。成功启动后显示安装完成、控制台地址和管理员密钥，然后退出脚本，请保存密钥。

新装默认监听 `0.0.0.0`，允许通过服务器 IP 访问。地址优先使用云服务器公网 IPv4，再尝试出口地址，失败回退本机网卡地址。安装器不开放防火墙。Linux 以 root 安装且支持 systemd 时自动注册系统服务，开机启动、异常退出自动重启；其他环境启动独立后台进程，支持关闭终端后继续运行，但不自动开机启动或异常重启。

## 指定端口与语言

下载脚本后，可直接指定参数跳过端口询问：

```bash
bash /tmp/kuku2api-install.sh --port 8400 --lang zh
```

```powershell
& "$env:TEMP\kuku2api-install.ps1" -Port 8400 -Lang zh
```

默认语言按系统时区选择：中国大陆、香港、澳门、台湾时区为中文，其余为英文；`--lang` / `-Lang` 可选 `auto`、`zh`、`en`。不是仅按 UTC+8 偏移判断，新加坡时区使用英文。

端口默认值优先级：命令行参数 > `PORT` 环境变量 > 数据库保存值 > `8787`。选择成功后写入 SQLite，后续启动沿用。无人值守安装不等待输入，默认端口冲突时选择后续可用端口；显式指定的端口被占用则报错。

## 升级

**重复执行一键安装命令即可升级**：已有安装会自动识别，保留账号、密钥、端口和设置。默认沿用端口，只有主动传入端口参数才修改。

默认目录的一键升级入口：

```bash
bash ~/kuku2api/upgrade.sh
```

```powershell
& "$env:USERPROFILE\kuku2api\upgrade.ps1"
```

自定义目录请替换路径，或给下载的安装器传入 `--dir PATH --upgrade` / `-InstallDir PATH -Upgrade`。缺少升级入口的旧版直接重跑远程安装命令。

升级先下载并校验成品包，再验证旧实例身份、等待请求完成、保存源码和 SQLite 一致性备份到 `.runtime/backups/`，然后切换并检查启动。正常初始化或启动失败会尝试恢复旧版和原服务。已是最新版且文件完整时跳过重复切换；已托管的运行中服务保持运行；支持 systemd 的 Linux root 环境会将旧版前台实例切换为系统服务。

Git 安装要求目录干净且能快进到发布包对应提交；有本地修改或分叉时停止并保留现场。压缩包安装保留 `data/`、私有配置和运行时。新版后台启动会将应用环境配置私有保存到 `.runtime/service.json`，后续管理命令与重启自动沿用；首次从旧版迁移仍须带上原 `DATABASE_FILE` 或 `ADMIN_TOKEN` 等显式配置。

旧版若没有实例身份和停止接口，先在原终端按 Ctrl+C，再升级。无法确认归属的端口不会强制结束；等待旧进程退出最多 120 秒。中断安装且尚未初始化数据时，会重新进入首次端口选择。

## 启动与停止

Linux / macOS：

```bash
cd ~/kuku2api
bash start.sh
```

Windows PowerShell：

```powershell
cd "$env:USERPROFILE\kuku2api"
.\start.ps1
```

启动脚本验证后台服务可访问后退出，关闭终端不会停止服务。Linux 系统服务的状态、日志和停止方式见 [运行维护](operations.md#后台服务管理)。开发者运行 `npm start` 仍以前台方式运行，按 Ctrl+C 停止。

## 参数速查

| Linux/macOS | Windows PowerShell | 作用 |
|---|---|---|
| `--dir PATH` | `-InstallDir PATH` | 自定义安装目录 |
| `--port 8400` | `-Port 8400` | 指定并保存端口 |
| `--lang zh` | `-Lang zh` | `auto` / `zh` / `en` |
| `--upgrade` | `-Upgrade` | 下载最新版、备份、升级并启动 |
| `--start` | `-Start` | 启动本目录实例 |
| `--restart` | `-Restart` | 验证身份后重启 |
| `--install` | `-Install` | 使用本地发布包安装，不下载更新 |
| `--no-start` | `-NoStart` | 完成安装/升级后不启动；升级仍停止旧实例 |
| `--backend-only` | `-BackendOnly` | 只初始化后端 |
| `--build-from-source` | `-BuildFromSource` | 开发者显式选择本机构建，默认关闭 |
| `--skip-dependencies` | `-SkipDependencies` | 源码构建时使用已有依赖 |

`--no-start` 仍保存端口，但不检查占用。普通用户使用默认预编译方式即可；源码开发见 [开发说明](development.md)。
