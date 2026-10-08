# kuku2api

将百度「库库AI」的模型转换为 OpenAI 兼容 API，支持多账号池、Chat Completions、Responses 和网页管理控制台。

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

打开 [控制台](http://127.0.0.1:8787)。首次安装在终端显示一次随机生成的管理员强令牌，**请立即保存**，并用它进入控制台。之后可扫码加号、创建普通 API 密钥，将客户端的 Base URL 配置为 `http://127.0.0.1:8787/v1`。

已安装项目中运行脚本会复用当前源码、数据库与令牌；不会自动拉取新版本，也不会覆盖无关的非空目录。源码更新后可重新运行脚本构建。运行前先停止旧服务；数据库升级前应做好一致性备份。

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
| `--no-start` | `-NoStart` | 只安装、不启动 |
| `--backend-only` | `-BackendOnly` | 只初始化后端，不下载前端依赖或构建控制台 |
| `--skip-dependencies` | `-SkipDependencies` | 用已安装的前端依赖重新构建，适合本地开发 |

通过 `PORT` 环境变量修改端口；再次启动时设置同一变量。启动器清除 HTTP/HTTPS/ALL 代理环境变量，确保账号请求直连。

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

后端回归共 259 项（251 项既有检查 + 8 项安装/静态控制台检查）。新增检查覆盖首次安装、重复安装、端口冲突、代理清理、SPA 路由、静态资源、目录链接越界、构建失败及 API 鉴权边界。安装不包含付费模型验收。

