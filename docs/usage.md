# 使用说明

[文档导航](README.md) · [安装与升级](installation.md) · [API 文档](api.md)

## 登录控制台

安装完成后，打开终端显示的控制台地址，填写管理员密钥。首次登录从当前页面自动识别协议、域名/IP 和端口。本文所有 `kuku.example.invalid` 地址均为不可用于实际连接的示例占位符，不是部署地址；使用时替换为自己的服务地址。

| 页面地址 | 自动使用的后端地址 |
|---|---|
| `http://kuku.example.invalid:8787/users` | `http://kuku.example.invalid:8787` |
| `https://kuku.example.invalid/users` | `https://kuku.example.invalid` |

已有合法的自定义后端地址会保留。前后端分开部署时可展开服务端地址配置，填写后端根地址，**不加 `/v1`**。HTTP 和 HTTPS 均支持；FTP、file 等协议不支持。

## 添加账号

推荐在号池使用百度 App 扫码，也可以使用短信验证码。登录完成后后端验证账号身份并入池，同一百度账号重复登录不会新增副本。

短信登录接收 11 位大陆手机号、6 位短信验证码。上游可能要求图形验证码：

- 发送短信前出现图形码：填写后继续发送。
- 提交短信码后出现图形码：填写图形码并继续使用原短信码，不需要重发短信。
- 要求滑块时：按提示改用扫码登录。

每个短信会话有效 10 分钟，实际发送后冷却 60 秒，每会话最多成功发送 5 次；重发不延长会话。2026-10-12 用户已确认修复后的真实短信登录成功，其他账号仍可能受到上游频控和验证要求限制。

账号登录过期时更新登录凭据或重新处理账号。账号凭据不在列表中回显；不要把 Cookie、数据库或管理员密钥上传到公开仓库。

## 接入模型客户端

在控制台创建普通 API 密钥，保存只显示一次的完整密钥。客户端 Base URL 为 `http://kuku.example.invalid:8787/v1`，HTTPS 反向代理示例为 `https://kuku.example.invalid/v1`。

模型 ID 以 `/v1/models` 为准；显示名称不一定等于请求使用的 ID。公开监听时必须配置普通 API 密钥，管理员密钥不能代替它调用模型。

### OpenCode 等编程客户端

v1.1.0 新增原生 MCP 工具适配；使用 v1.0.1 的用户需先运行一键升级。后端向上游提供客户端的真实工具定义，转换结构化调用，客户端在自己的工作目录中检查权限并执行。2026-10-13 已通过 GLM Flash、DeepSeek Flash 的读文件→写文件→运行检查→最终回答测试，以及 OpenCode 1.19.0 + GLM Flash 的实际 read→edit→bash 测试。详见 [验收说明](agent-upstream-verification.md)。

OpenCode 使用自定义 OpenAI-compatible provider。以下是本次验收配置的精简示例；替换地址、普通 API 密钥和目录中可用的模型 ID：

```json
{
  "$schema":"https://opencode.ai/config.json",
  "provider":{
    "kuku":{
      "npm":"@ai-sdk/openai-compatible",
      "name":"kuku2api",
      "options":{"baseURL":"https://kuku.example.invalid/v1","apiKey":"REPLACE_WITH_YOUR_API_KEY"},
      "models":{
        "gateway-glm-5.3-flash":{
          "name":"GLM Flash",
          "tool_call":true,
          "limit":{"context":128000,"output":8192},
          "options":{"think_mode":1}
        }
      }
    }
  },
  "model":"kuku/gateway-glm-5.3-flash",
  "compaction":{"auto":false,"prune":false},
  "agent":{"title":{"disable":true},"summary":{"disable":true},"compaction":{"disable":true}},
  "permission":{"read":"allow","edit":"ask","bash":"ask"}
}
```

配置格式见 OpenCode [自定义提供商](https://opencode.ai/docs/providers/#custom-provider)、[模型](https://opencode.ai/docs/models/) 和 [权限](https://opencode.ai/docs/permissions/) 文档。`limit` 是客户端配置，并非本项目验证的上游模型最大窗口或输出保证。首次使用请从少量文件和短任务开始，客户端首字节超时建议至少覆盖后端默认 180 秒生成期限。

- 工具模式的正文和思考实时输出；工具调用仍在完整参数校验及原生交接后发送，参数增量可能只有一块。需在客户端启用 `stream:true` 才能边生成边显示，不能按“是否逐字出现参数”判断工具有没有生效。
- Chat 每轮重传完整 messages、tool_calls、tool 结果和 tools，无需 `x-kuku-session`；Responses 可在 store:true 时使用 previous ID，store:false 必须自行重传完整历史。
- 上游 usage 包括平台提示和内部工具发现的多次推理合计，不能作为客户端当前上下文长度。示例关闭自动压缩和自动标题等额外调用以避免过早压缩和额外消耗；大任务需主动精简历史或开启新会话，并保留任务交接摘要。长期任务压缩、子 Agent 和所有 MCP 插件尚未逐项验收。
- 工作目录必须是客户端实际项目目录。外部启动器应同时设置 cwd/PWD 或显式使用 OpenCode 的 `--dir`；模型 API 不会自动上传本地文件，只有客户端实际执行 read 后的文本结果才会进入历史。
- 支持标准图片附件及工具返回的图片；其他二进制文件、提供商托管工具、grammar 自定义工具仍不支持。图片大小、URL、存储与限制见 [图片附件](api.md#图片附件)。权限由客户端控制，后端不会在云服务器执行客户端命令。
- `invalid_tool_response` 表示模型调用或参数未通过校验，没有向客户端交出可执行调用。`upstream_requires_client` 表示上游仍请求了未支持的桌面能力；先查看状态和余额，避免自动循环重发付费请求。
- 如果正文首字仍慢，可先在客户端选择较低思考档，并在日志中查看 `agent timing` 的分段耗时。已实时显示思考但较晚输出正文时，降低代理缓冲通常不能省去模型自身的思考时间；模型未保证严格遵守固定思考预算。工具发现仍可能需要额外一轮上游推理。

### Pi 编程 Agent

已实际验证 Pi 1.2.0 + GLM Flash，Chat 和 Responses 均成功完成识图、写入文件、运行固定检查及最终回答。配置参考 Pi 官方 [自定义模型文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)，在 agent 目录的 models.json 中添加：

```json
{
  "providers":{
    "kuku":{
      "baseUrl":"https://kuku.example.invalid/v1",
      "api":"openai-completions",
      "apiKey":"REPLACE_WITH_YOUR_API_KEY",
      "authHeader":true,
      "models":[{"id":"gateway-glm-5.3-flash","input":["text","image"],"reasoning":false,"contextWindow":128000,"maxTokens":8192}]
    }
  }
}
```

需要 Responses 时将 api 改为 `openai-responses`。`input` 的 image 标记用于让客户端发送图片，reasoning:false 是本次验收的客户端能力设置，不代表上游关闭思考；服务端思考档位按 API 请求与上游默认值确定。Pi 可用 `@图片路径` 附加图片，或调用 read 读取图片。上述窗口和输出上限仍只是客户端设置。

Pi 同样需要避免根据累计上游 usage 过早压缩；本次验收 settings.json 使用 `{"compaction":{"enabled":false},"retry":{"enabled":false,"maxRetries":0}}`，并限制工具权限到合成测试文件及固定命令。关闭自动压缩后，大任务需自行整理上下文；日常使用的工具权限应由使用者配置。

## 思考档位与会话

思考档位来自模型目录的 `think_list`。支持 `think_mode`，也支持兼容的 `reasoning_effort`，具体字段见 [API 文档](api.md#模型与思考档位)。档位会传给上游，实际思考内容和预算由模型决定，不保证随档位严格递增。

普通文本 Chat 可用 `x-kuku-session` 续接上游会话，也可每次重传完整历史。工具模式 Chat 每次新建原生会话，须重传完整历史；Responses 可通过 `previous_response_id` 取回已保存的工具历史。会话按账号与上游身份隔离；旧账号不可用时，已有 Responses 链不会悄悄换号继续。

## 积分与用量

控制台可查询余额、领取当前奖励，并选择完成对话任务。`chat:true` 的对话任务可能先消耗少量积分，再上报进度并领取；费用以返回值为准。

手动、单账号和每日自动领取共用队列：一个账号处理完毕后等待 15 秒，再处理下一个，失败时也会等待。批量操作可能耗时数分钟，请等待结果，不要重复点击；普通对话不受该等待影响。

是否到账应查看实际领取结果和余额变化，不能只看 HTTP 200 或任务上报成功。部分任务失败时，其他已领取奖励仍可能到账。结果不确定时先刷新状态，避免自动循环重发付费对话。

每日自动领取默认关闭，显式开启后按服务器本地时间运行。新用户奖励资格与额度由上游决定；需要真实电脑端上下文时，云服务器不一定具备，项目不保证固定赠送额度。

token 统计与积分是不同口径。积分看 `consume_points`；token 是上游报告值，可能包含缓存和多次模型调用限制，不能直接换算账单。详见 [统计接口](api.md#统计对话与日志)。

## 常见问题

| 现象 | 检查方式 |
|---|---|
| `Failed to fetch` | 后端是否运行、地址是否正确、防火墙是否开放、HTTPS 页面是否误连 HTTP 后端 |
| `bad api key` | 模型调用需普通 API 密钥；管理台读取支持管理员令牌，但旧的自定义地址可能指向了别的实例 |
| `admin token required` | 检查管理员密钥是否属于当前实例；重跑安装入口可显示已有实例的密钥 |
| 端口被占用 | 首次安装另选端口，显式传 `--port` / `-Port`；升级只停止已确认属于本目录的服务 |
| 对话任务没到账 | 查看账号结果、`reported`、`notes` 和余额；完成对话不等于奖励已领取 |
| 新用户赠送未到账 | 检查活动资格及 `desktop_login` 结果，不把账号新增成功当作奖励成功 |
| 反向代理 HTTPS 无法登录 | 同源代理应转发页面、`/healthz`、`/pool` 和 `/v1`；浏览器地址配置填代理根地址 |
| 关闭终端后访问失败 | 旧版前台部署请重跑安装命令升级；新版后台运行，检查系统服务日志 |
