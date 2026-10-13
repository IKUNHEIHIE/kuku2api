# kuku2api

将百度「库库AI」接入 OpenAI 兼容客户端，提供多账号池、流式对话和网页管理控制台。

[快速安装](#快速安装) · [使用说明](docs/usage.md) · [API 文档](docs/api.md) · [全部文档](docs/README.md) · [v1.2.0 发布说明](docs/releases/v1.2.0.md) · [发布包](https://github.com/IKUNHEIHIE/kuku2api/releases/latest)

## 功能

- 支持 Chat Completions 与 Responses，支持流式输出和思考档位。
- 工具模式实时输出正文与思考，支持原生 MCP 客户端工具及图片附件适配；GLM/DeepSeek Flash、OpenCode 与 Pi 验收范围见 [说明](docs/agent-upstream-verification.md)。
- v1.2.0 改进异常账号切换，支持登录凭据定时续期及控制台管理；工具定义稳定序列化，并移除工具数量与定义总大小的额外限制。
- 扫码、短信登录，多账号去重、调度及会话隔离。
- 管理员令牌与模型 API 密钥独立，控制台管理账号、积分和密钥。
- SQLite 保存设置、日志、对话与用量，支持 token 和积分统计。
- 手动领取积分；每日自动领取默认关闭。
- 积分领取按账号串行处理，每个账号完成后间隔 15 秒。
- 安装与升级下载预编译包，用户服务器无需构建前端。

## 快速安装

支持 Windows、Linux/macOS 的 x64/arm64。安装器自动选择可用的 Node.js，最低版本为 **24.15.0**；后端运行时无第三方依赖。

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/IKUNHEIHIE/kuku2api/main/install.sh -o /tmp/kuku2api-install.sh && bash /tmp/kuku2api-install.sh
```

**Windows PowerShell**

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/IKUNHEIHIE/kuku2api/main/install.ps1 -OutFile "$env:TEMP\kuku2api-install.ps1"
& "$env:TEMP\kuku2api-install.ps1"
```

按提示选择运行端口（默认 `8787`），安装完成后会显示：

```text
安装完成，服务已在后台运行。
控制台地址：http://服务器IP:端口
管理员密钥：随机生成的强令牌
```

保存管理员密钥，打开控制台即可使用。新安装默认允许通过服务器 IP 访问；安装脚本不会自动开放防火墙端口。系统时区决定默认交互语言，也可手动指定。

端口选择、安装参数、Windows 执行策略及启动方式见 [安装与升级](docs/installation.md)。

## 开始使用

1. 使用管理员密钥登录控制台。首次登录自动填入当前页面的 HTTP/HTTPS 地址，也适用于同源反向代理。
2. 在「号池」扫码或短信登录，添加自己的账号。
3. 在「密钥管理」创建普通 API 密钥并保存。
4. 在兼容客户端中填写下表内容。

| 配置项 | 填写内容 |
|---|---|
| Base URL | `http://服务器IP:端口/v1`，或 `https://你的域名/v1` |
| API Key | 控制台创建的普通 API 密钥 |
| 模型 | 从 `/v1/models` 获取，例如 `gateway-glm-5.3-flash` |

管理员密钥用于控制台；模型调用使用普通 API 密钥。模型可用性与实际积分消耗以上游返回为准。

## 升级与重启

重复执行上方安装命令，会自动识别已有安装并升级，保留账号、密钥、端口和设置。也可在默认安装目录运行：

| 操作 | Linux / macOS | Windows PowerShell |
|---|---|---|
| 升级 | `bash ~/kuku2api/upgrade.sh` | `& "$env:USERPROFILE\kuku2api\upgrade.ps1"` |
| 启动 | `bash ~/kuku2api/start.sh` | `& "$env:USERPROFILE\kuku2api\start.ps1"` |

安装器验证后台服务启动后自动退出，关闭终端不影响服务。Linux root + systemd 环境自动注册开机启动和异常重启；其他环境使用独立后台进程。详细说明见 [运行维护](docs/operations.md)。

## 文档

| 我想了解 | 文档 |
|---|---|
| 安装、指定端口、升级 | [安装与升级](docs/installation.md) |
| 登录加号、积分、模型与常见问题 | [使用说明](docs/usage.md) |
| 接口、鉴权、请求字段与错误码 | [API 文档](docs/api.md) |
| 环境变量、反向代理、备份恢复 | [运行维护](docs/operations.md) |
| 本地开发、测试与发布 | [开发说明](docs/development.md) |
| 旧版改动及验收记录 | [历史归档](docs/archive/README.md) |

## 许可证

项目原创代码与文档采用 [0BSD](LICENSE)：允许商用、修改、分发和闭源使用，无署名或公开源码要求。许可证原文见 [OSI Zero-Clause BSD](https://opensource.org/license/0bsd)。

第三方代码继续遵循各自许可；前端基于 Sat Naing 的 Shadcn Admin 模板，其 [MIT 声明](ui/LICENSE) 必须保留。详见 [第三方许可说明](docs/licenses.md)。
