# kuku2api

将百度「库库AI」的模型转换为 OpenAI 兼容 API，支持多账号池、Chat Completions、Responses 和网页管理控制台。

当前版本 **0.2.0**：包含最新控制台、管理员号池状态读取，以及流式失败、独立会话、隐私存储和账号保存一致性修复。续聊请明确传递 `x-kuku-session` 或 `previous_response_id`；无会话标识的请求每次新建对话。

- 流式 / 非流式响应、思考深度、真实上游用量统计。
- 扫码或短信登录加号、账号去重、余额查询、账号间会话隔离。
- 管理员令牌与普通 API 密钥分别管理。
- SQLite 保存账号、设置、日志、对话记录和用量。
- 手动积分领取；每日自动领取默认关闭。
- 后端运行时零第三方依赖，要求 Node.js >=24.15.0。

## 一键安装

安装器支持 Windows、Linux/macOS 的 x64/arm64。自动下载源码；缺少合适的 Node.js 时，从官方站点下载私有 Node 24 运行时并核对 SHA-256。无需管理员权限，不替换系统 Node.js。

Linux / macOS（需要 bash、curl、tar；校验工具 sha256sum 或 shasum）：

```bash
curl -fsSL https://raw.githubusercontent.com/IKUNHEIHIE/kuku2api/main/install.sh -o /tmp/kuku2api-install.sh && bash /tmp/kuku2api-install.sh
```

Windows PowerShell：

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/IKUNHEIHIE/kuku2api/main/install.ps1 -OutFile "$env:TEMP\kuku2api-install.ps1"; & "$env:TEMP\kuku2api-install.ps1"
```

如系统的执行策略禁止运行下载的脚本，可在确认文件内容后使用单次进程启动，不修改系统执行策略：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\kuku2api-install.ps1"
```

默认目录为用户目录下的 `kuku2api`。安装器安装固定版本 pnpm，通过现有锁文件安装前端依赖并构建控制台，完成后以前台方式启动服务。

安装时会询问服务端口（默认 `8787`，回车沿用），端口被占用或输入无效时可重新选择。端口在安装成功后写入 SQLite，之后运行 `start.sh`、`start.ps1` 或 `npm start` 自动沿用，无需重复设置环境变量。指定 `--port` / `-Port` 可跳过询问；无人值守安装不会等待输入。

交互语言根据系统时区自动选择：中国大陆、香港、澳门、台湾时区显示中文，其他时区显示英文；不按 UTC+8 偏移判断，因此新加坡等时区使用英文。可用 `--lang zh|en|auto` / `-Lang zh|en|auto` 覆盖。下载源码、安装运行时和管理员令牌提醒也使用对应语言；依赖工具自己的输出保持原样。

打开安装器显示的控制台地址（默认 [http://127.0.0.1:8787](http://127.0.0.1:8787)）。首次安装在终端显示一次随机生成的管理员强令牌，**请立即保存**，并用它进入控制台。之后可扫码加号、创建普通 API 密钥，将客户端的 Base URL 配置为对应地址加 `/v1`。

**上面的远程命令可重复使用：未安装时自动安装，已安装时自动升级并启动。** 升级沿用已保存的端口、账号、管理员令牌和设置，不再询问端口；只有主动传入端口参数时才修改。已经是最新版且构建存在时，跳过重复构建；正在运行则保持运行。

安装目录中也有一键升级入口，它每次都会获取最新安装器：

```bash
bash ~/kuku2api/upgrade.sh
```

```powershell
& "$env:USERPROFILE\kuku2api\upgrade.ps1"
```

自定义安装目录请替换上述路径；也可在远程命令后指定 `--dir PATH --upgrade` / `-InstallDir PATH -Upgrade`。已有旧安装缺少升级入口时，重新执行上面的远程安装命令即可自动下载完整新版，修复旧辅助程序不识别 `--lang` 的问题。不要删除安装目录或单独替换辅助文件。

升级先在临时目录下载源码并构建控制台，成功后才停止已验证属于本目录的服务，等待请求及正在执行的定时领取结束。源码和 SQLite 一致性备份保存至 `.runtime/backups/`，再切换新版、初始化数据库并检查启动；初始化或启动失败会尝试恢复旧版和原服务。备份包含账号和令牌，请像数据库一样保管。强制中断或外部并发修改可能需要按备份手动恢复，正常失败会显示恢复结果。

Git 安装只允许干净目录快进到 `origin/main`，有本地修改或分叉时保留现场并停止。压缩包安装会先备份再替换公开源码，无关文件、私有配置、`data/` 和私有运行时保留。数据库仍按原有路径读取；如曾设置 `DATABASE_FILE` 或显式 `ADMIN_TOKEN`，升级和启动时沿用相同环境变量。

首次升级旧版时，如果旧服务没有身份验证及停止接口，请先在原终端按 Ctrl+C；之后脚本可以自动停止并重启本服务。无法确认归属的占用端口不会被脚本强行结束。升级最多等待旧进程退出 120 秒，超时会停止切换源码。

在安装目录直接运行 `install.sh` / `install.ps1` 默认使用当前源码重新安装，适合本地开发；`--install` / `-Install` 可显式选择该行为。使用 `--upgrade` / `-Upgrade` 获取发布的新版。

如果选择其他端口，登录页展开“服务端地址配置”，填写安装器显示的根地址，例如 `http://127.0.0.1:8788`，不要加 `/v1`。管理员可直接读取号池本地状态；模型调用仍使用独立的普通 API 密钥。

关闭终端或按 Ctrl+C 会停止服务。再次启动：

```bash
cd ~/kuku2api
bash start.sh
```

```powershell
cd "$env:USERPROFILE\kuku2api"
.\start.ps1
```

可选安装方式：

| Linux/macOS 参数 | Windows 参数 | 说明 |
|---|---|---|
| `--dir PATH` | `-InstallDir PATH` | 自定义目录 |
| `--port 8788` | `-Port 8788` | 指定并保存服务端口，跳过端口提问 |
| `--lang zh` / `--lang en` | `-Lang zh` / `-Lang en` | 手动指定中文或英文；默认 `auto` 按时区判断 |
| `--upgrade` | `-Upgrade` | 下载最新源码、备份、升级并启动；自动沿用端口 |
| `--start` | `-Start` | 启动本目录服务；已运行时直接显示地址 |
| `--restart` | `-Restart` | 验证本目录服务身份后停止并重新启动 |
| `--install` | `-Install` | 使用当前源码安装/重建，不下载更新 |
| `--no-start` | `-NoStart` | 安装或升级完成后不启动；升级时仍停止旧服务 |
| `--backend-only` | `-BackendOnly` | 只初始化后端，不下载前端依赖或构建控制台 |
| `--skip-dependencies` | `-SkipDependencies` | 本地安装用现有依赖重建；升级构建不支持此选项 |

例如：`bash install.sh --port 8788 --lang zh`，或 `.\install.ps1 -Port 8788 -Lang zh`。

安装端口的默认值优先级：命令行参数 > `PORT` 环境变量 > SQLite 中已保存的端口 > `8787`。交互安装可修改默认值；`--no-start` / `-NoStart` 仍保存选择，但不检查端口占用。启动时 `PORT` 优先于已保存端口，仅临时覆盖，不改写数据库。启动器清除 HTTP/HTTPS/ALL 代理环境变量，确保账号请求直连。

## 本地开发

```bash
npm install                 # 首次生成并显示管理员令牌
npm start                   # API；如有 ui/dist，也提供控制台
npm test                    # 离线回归，不连接上游或花积分
```

前端开发保持现有方式，在 `ui/` 目录安装依赖后运行开发服务器。API 完整契约、请求示例、错误码和思考档位规则见 [docs/api.md](docs/api.md)。

真实上游验收脚本 `npm run accept` 会发送模型请求并消耗积分，应在理解脚本和费用后手动执行；安装器不会运行它。

## 数据与认证

默认数据库：`data/kukuai.sqlite`，可通过 `DATABASE_FILE` 指定路径。重装、重启复用已有数据。账号凭据、数据库、令牌及其备份均已排除在版本管理之外。

管理员接口始终要求管理员令牌；普通 API 密钥与管理员令牌独立。未配置任何普通密钥时，普通 API 采用本机免鉴权模式。需要给其他客户端访问时，先在控制台创建普通密钥。

服务只监听 `127.0.0.1`。远程机器可使用 SSH 端口转发；如需提供公网访问，应自行配置 HTTPS、访问控制和反向代理。安装器不开放防火墙、不安装系统服务。

SQLite 使用 WAL；在线备份请使用 SQLite 一致性备份，或停止服务后完整保存数据库目录，避免只复制主文件而遗漏 WAL。

## 限制

- 本项目依赖库库AI现有接口，上游变更可能影响兼容性。
- 账号隔离是凭据、会话和任务的逻辑隔离；网络出口和本机设备仍共享。
- 新用户桌面奖励需要真实桌面客户端环境与上游资格，安装器不伪造设备，也不承诺获得奖励。Linux/macOS 安装不会提供 Windows 原生桌面环境。
- 自动领取默认为关闭；开启后会按配置执行，涉及对话任务时可能消耗积分。
- 未确认归属的旧会话不能冒用其他账号续聊，需要新建对话。
- 前端模板的许可和原作者声明保留在 [ui/LICENSE](ui/LICENSE)。

## 验证

离线回归覆盖管理员与普通密钥隔离、流式失败、独立会话、隐私存储、账号保存故障，以及安装语言、端口保存、旧版自动升级、Git 修改保护、备份回滚和服务重启。Windows 和 Linux 在 GitHub Actions 分别验证；安装不包含付费模型验收。

