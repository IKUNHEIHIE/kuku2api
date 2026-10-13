# API 文档

版本：基于 1.1.0 的主分支更新（实时流式优化与领取限速；云端已更新，尚未发布新安装包） · 更新：2026-10-13

本文描述当前接口。旧版差异与验收过程见 [历史归档](archive/api-history.md)，安装参数和环境变量见 [安装与升级](installation.md)、[运行维护](operations.md)。

## 目录

- [地址与鉴权](#地址与鉴权)
- [路由索引](#路由索引)
- [模型与思考档位](#模型与思考档位)
- [Chat Completions](#chat-completions)
- [Responses](#responses)
- [客户端工具调用](#客户端工具调用)
- [图片附件](#图片附件)
- [会话隔离](#会话隔离)
- [号池查询与管理](#号池查询与管理)
- [扫码与短信登录](#扫码与短信登录)
- [普通 API 密钥](#普通-api-密钥)
- [积分领取](#积分领取)
- [统计、对话与日志](#统计对话与日志)
- [系统设置](#系统设置)
- [运行实例管理](#运行实例管理)
- [错误处理](#错误处理)

## 地址与鉴权

管理台填写后端根地址，例如 `https://example.com`；OpenAI 兼容客户端的 Base URL 通常填写 `https://example.com/v1`。以下路径均相对于根地址。

| 凭证 | 请求头 | 适用范围 |
|---|---|---|
| 普通 API 密钥 | `Authorization: Bearer <API_KEY>` 或 `x-api-key: <API_KEY>` | 模型调用、Responses 历史及号池查询 |
| 管理员令牌 | `x-admin-token: <ADMIN_TOKEN>` 或 `Authorization: Bearer <ADMIN_TOKEN>` | `/pool/admin/*` 及下方列出的管理读取接口 |

管理员读取例外仅限 **GET** `/v1/models`、`/pool/state`、`/pool/health`、`/pool/points`、`/pool/sessions`。有效 `x-admin-token` 独立验证，不受同时携带的失效普通密钥影响。模型生成与 Responses 历史读取/删除仍独立要求普通 API 密钥。

公开监听时，没有普通密钥也禁止匿名调用。仅回环监听且普通密钥全部为空时，普通接口允许本地免鉴权；管理员接口仍需令牌。删除最后一条密钥不会开放公开实例。

JSON 请求使用 `Content-Type: application/json`。`OPTIONS` 预检返回 204；允许的请求头包括 `authorization`、`content-type`、`x-api-key`、`x-admin-token`、`x-kuku-account`、`x-kuku-session`、`x-kuku-allow-unavailable`。

## 路由索引

“普通/管理员”表示两类凭证均可读取；“普通”不包含管理员令牌。

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/healthz` | 无 | 存活检查，返回 `{"ok":true}` |
| GET | `/v1/models` | 普通/管理员 | 模型及思考档位 |
| POST | `/v1/chat/completions` | 普通 | Chat 对话 |
| POST | `/v1/responses` | 普通 | Responses 对话 |
| GET | `/v1/responses` | 普通 | Responses 分页列表 |
| GET / DELETE | `/v1/responses/:id` | 普通 | 读取/删除单条 Responses |
| GET | `/pool/state` | 普通/管理员 | 账号运行状态 |
| GET | `/pool/health` | 普通/管理员 | 上游登录态检查 |
| GET | `/pool/points` | 普通/管理员 | 积分余额 |
| GET | `/pool/sessions` | 普通/管理员 | 上游会话列表 |
| POST | `/pool/admin/accounts` | 管理员 | 手动添加账号 |
| PATCH / DELETE | `/pool/admin/accounts/:id` | 管理员 | 更新/删除账号 |
| POST | `/pool/admin/resequence` | 管理员 | 重排优先级 |
| POST | `/pool/admin/reset-cooldown` | 管理员 | 清除运行时不可用标记 |
| GET / POST | `/pool/admin/accounts/:id/desktop-login` | 管理员 | 电脑端初始化状态/补跑 |
| POST | `/pool/admin/login/qr` | 管理员 | 创建扫码会话 |
| GET | `/pool/admin/login/qr/:id.png` | 管理员 | 二维码图片 |
| GET / POST | `/pool/admin/login/qr/:id` | 管理员 | 查询扫码状态 |
| POST | `/pool/admin/login/sms` | 管理员 | 发送短信 |
| GET | `/pool/admin/login/sms/captcha/:id` | 管理员 | 图形验证码图片 |
| POST | `/pool/admin/login/sms/resend` | 管理员 | 重发或完成发送前图形验证 |
| POST | `/pool/admin/login/sms/verify` | 管理员 | 完成短信登录 |
| GET / POST | `/pool/admin/keys` | 管理员 | 列表/创建普通密钥 |
| DELETE | `/pool/admin/keys/:id` | 管理员 | 吊销数据库普通密钥 |
| GET / POST | `/pool/admin/claim` | 管理员 | 查任务/领取积分 |
| GET / POST | `/pool/admin/auto-claim` | 管理员 | 读取/设置每日领取 |
| POST | `/pool/admin/auto-claim/run` | 管理员 | 手动执行每日任务 |
| GET | `/pool/admin/stats/tokens` | 管理员 | token/积分统计 |
| GET | `/pool/admin/conversations` | 管理员 | 对话尝试列表 |
| GET | `/pool/admin/conversations/:id` | 管理员 | 对话详情 |
| GET | `/pool/admin/logs` | 管理员 | 日志分页 |
| GET / PATCH | `/pool/admin/settings` | 管理员 | 系统设置 |
| GET | `/pool/admin/runtime` | 管理员 | 当前运行实例 |
| POST | `/pool/admin/shutdown` | 管理员 | 停止指定实例 |

## 模型与思考档位

`GET /v1/models` 返回 `object:"list"`、`data`，目录可用时还返回 `think_list`、`default_model`、`default_think_id`。

模型字段为 `id`、`object`、`owned_by`、`display_name`、`cost_ratio`、`description`。展示使用 `display_name`，请求提交 `id`；ID 可能包含 `/`，若放入 URL 路径须编码。目录暂不可用时可能返回空列表。

| 字段 | 说明 |
|---|---|
| `think_list` | 上游目录级档位，元素含 `id`、`think_name`、`description` |
| `default_think_id` | 上游默认思考档，数字 |
| `default_model` | 上游默认模型的可用 ID |
| `cost_ratio` | 展示字符串，不能直接换算实际扣分 |

两种生成接口都支持 `think_mode`，也支持 `reasoning.effort` 或扁平 `reasoning_effort`。明确提供 `think_mode` 时优先。

| effort | think_mode |
|---|---|
| `minimal` / `low` | 1 |
| `medium` | 2 |
| `high` | 3 |
| `xhigh` | 4 |

档位以实时 `think_list` 校验；未知档位、`none` 或 `max` 返回 400 `invalid_think_mode`。未指定时使用上游默认档。目录级档位不代表每个模型都提供相同思考预算；档位传递不保证 token 数严格递增。

## Chat Completions

`POST /v1/chat/completions`

```json
{
  "model": "gateway-glm-5.3-flash",
  "messages": [{"role":"user","content":"你好"}],
  "stream": false,
  "think_mode": 1,
  "store": true
}
```

| 字段 | 说明 |
|---|---|
| `model` | 可选，默认 `gateway-glm-5.3-flash`；取模型目录的 ID |
| `messages` | 必须为非空数组；`content` 支持字符串、text 块和用户 image_url 块；文本保留原换行，图片见下节 |
| `stream` | 只有 `true` 开启 SSE，默认非流式 |
| `think_mode` / `reasoning.effort` / `reasoning_effort` | 思考设置，见上节 |
| `store` | 本项目扩展；`false` 不存正文/思考，但保留用量与最小续接数据 |
| `stream_options.include_usage` | 流式末尾附加 usage 帧 |
| `kuku_meta` | 流式末尾附加非标准 kuku 元信息帧，默认关闭 |
| `tools` | 客户端函数定义：`[{"type":"function","function":{"name":"...","description":"...","parameters":{...},"strict":false}}]` |
| `tool_choice` | `auto`（默认）、`none`、`required`，或 `{"type":"function","function":{"name":"..."}}` |
| `parallel_tool_calls` | 默认 true；false 时只允许一条工具调用 |

可选请求头：`x-kuku-account` 指定账号 ID 或别名；`x-kuku-session` 指定逻辑会话标识。指定账号不能绕过停用、冷却或失效状态。`x-kuku-allow-unavailable: 1` 是需管理员权限的诊断选项，不是普通模型调用的授权替代。

纯文本请求必须包含非空用户文本，支持 `system/developer/user/assistant`。新建会话发送完整历史；system/developer 内容同时传入上游自定义指令字段，仍受上游平台指令约束。显式续接普通上游会话时发送最新用户消息。

有工具定义或工具历史时启用原生 MCP 适配，支持 `assistant.tool_calls` 与 `role:"tool"` 往返。最后一条消息须为非空 user 或工具结果；所有历史调用必须有对应结果，未知、重复或缺失 `tool_call_id` 返回 400 `invalid_tool_history`。旧式 `functions/function_call`、`role:"function"` 不支持。详见 [客户端工具调用](#客户端工具调用)。

支持图片附件；其他文件、音频等内容块仍返回 400 `unsupported_content_type`，混合文本与不支持内容也整体拒绝。内容结构或 `text` 类型不正确返回 `invalid_message_content`，工具定义不是数组返回 `invalid_tools`。不会静默丢弃附件或发送 `[object Object]`。本地内容校验发生在开启 SSE 和访问上游前；远程图片还需通过下载与上游上传检查。

非流式响应包含 `id`、`object:"chat.completion"`、秒级 `created`、`model`、`choices`、`usage`，另有扩展块：

```json
{"kuku":{"account":"example-account","consume_points":0.01,"session_id":"upstream-session","reply_id":"upstream-reply"}}
```

数值仅为结构示例，不能视为固定费用。usage 可含 `prompt_tokens`、`completion_tokens`、`total_tokens`、`reasoning_tokens`、`cache_read_tokens`；兼容响应在上游缺失用量时可能包含粗略输出估算，管理统计不把未知上游量估算入账。工具模式增加 `kuku.tool_adapter:"native-mcp"`。

流式响应类型为 `text/event-stream`，逐个解析 `data:`：正文在 `choices[].delta.content`，思考在扩展 `delta.reasoning_content`；usage 或 kuku 帧不是正文。成功流以 `data: [DONE]` 收尾，错误帧需单独处理，不能仅看到 `finish_reason` 就认定整条流结束。

## Responses

`POST /v1/responses`

```json
{
  "model": "gateway-glm-5.3-flash",
  "input": "你好",
  "stream": false,
  "reasoning": {"effort":"low"},
  "store": true
}
```

`input` 接受非空文本或输入项数组。支持 `instructions`、`previous_response_id`、`stream`、`store` 及思考字段。`instructions` 只作用于本次请求，不随 previous ID 继承；需要时每次重传。

文本消息 `content` 支持字符串及 `input_text/output_text/text` 块；用户图片使用 `input_image`。工具模式还接受 `function_call`、`function_call_output`、`custom_tool_call`、`custom_tool_call_output`，工具结果可携带文本及图片内容块。返回的可见 reasoning summary 可原样放回，不能续传其他提供商的加密 reasoning。未知项返回 400 `unsupported_input_type`，其他不支持的内容块返回 `unsupported_content_type`。

函数工具采用扁平格式：`{"type":"function","name":"read_file","parameters":{...},"strict":false}`，指定选择为 `{"type":"function","name":"read_file"}`。同时支持 `{"type":"custom","name":"apply_patch","format":{"type":"text"}}`；其调用项使用 `input` 文本，结果使用 `output` 文本与 `call_id`。grammar 格式返回 400 `unsupported_tool_format`。

返回 Response 对象，含 `id`、`object:"response"`、`created_at`（秒）、`status`、`output`、`output_text`、`usage`、`kuku` 等字段。SSE 使用 Responses 事件名，包含创建、文本增量和完成事件；失败可能返回失败事件，应按事件状态处理。

| 请求 | 行为 |
|---|---|
| `GET /v1/responses?limit=20&after=<id>&session_key=<key>` | 新到旧分页；limit 默认 20，范围 1–100；后两项可省略 |
| `GET /v1/responses/:id` | 读取已保存的完整响应，未知/不保存正文的记录返回 404 |
| `DELETE /v1/responses/:id` | 返回 `{id,object:"response",deleted:true}`；删除对应对话归档，保留累计用量 |

列表形状为 `{object:"list",data,first_id,last_id,has_more}`。无效或不在过滤结果中的游标返回 400 `cursor_not_found`，不能当作空末页。

`store:false` 不出现在列表，详情返回 404。普通文本的最小映射仍可续接；工具模式不保存历史和工具定义，因此不能用 previous ID 续接，须重新发送完整 input 历史，否则返回 400 `agent_history_unavailable`。对话保留策略可能清理旧映射；独立备份不随在线删除自动清理。

## 客户端工具调用

### 工作方式与边界

真实上游验收已确认：直接加入 OpenAI `tools/tool_choice` 字段没有注册为模型工具；库库AI提供的是原生自定义 MCP connector 通道。后端用该通道提供 `tools/list`，接收结构化 `tools/call`，再转换成 OpenAI 调用项；不会从普通正文提取或猜测工具调用。

后端只返回调用建议，**读写客户端工作目录、命令和 MCP 工具的权限检查与执行全部由客户端负责**。上传的图片由上游图片读取能力解析；不会在本后端执行上游电脑端工具，也不接管其他桌面客户端的任务。其他二进制附件、托管 web/file-search/code-interpreter 工具、grammar 自定义工具及提供商加密推理状态尚不支持；不能据此宣称所有 Agent 客户端完全兼容。

每次工具轮使用独立上游会话；交出工具调用前结束该轮，不长期挂起桌面回调。下一次请求把完整历史和真实工具结果送入新会话。这样客户端执行长命令时不会占用等待中的上游生成任务。Chat 工具模式忽略 `x-kuku-session`，必须每轮重传历史及工具定义；Responses 可在 `store:true` 时通过 previous ID 从 SQLite 恢复历史，固定原账号与上游身份。

### 一次往返示例

首次请求：

```json
{
  "model":"gateway-glm-5.3-flash",
  "messages":[{"role":"user","content":"读取 demo.txt"}],
  "tools":[{"type":"function","function":{
    "name":"read_file","description":"读取客户端工作目录中的文本文件",
    "parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}
  }}],
  "tool_choice":"auto",
  "parallel_tool_calls":false
}
```

响应 `choices[0].message` 可能为（ID 仅作示例）：

```json
{"role":"assistant","content":null,"tool_calls":[{"id":"call_example","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"demo.txt\"}"}}]}
```

此时 `finish_reason:"tool_calls"`。客户端按自己的权限读取文件，下一轮保留原 messages 和完整 assistant 消息，再追加 `{"role":"tool","tool_call_id":"call_example","content":"实际文件内容或实际错误"}`，同时重传 tools。收到普通最终回答时 `finish_reason:"stop"`。多个调用的结果可逆序回传，但必须全部回传且 ID 不重复。

Responses 的同一往返使用 `output` 中的 `function_call.call_id`，下一轮提交 `{"type":"function_call_output","call_id":"...","output":"真实结果"}`；可附 `previous_response_id`，或自行携带完整历史。response output item 的 `id` 与 `call_id` 不可混用。

### 校验、流式与用量

- 最多 128 个工具，工具定义与序列化后的完整会话分别不超过 2 MiB。名称唯一，匹配 `[A-Za-z0-9_.:-]{1,128}`；函数参数根节点描述 JSON 对象。
- 参数在交给客户端前按 JSON Schema 校验：支持 type/properties/required/additionalProperties、数组、enum/const、anyOf/oneOf/allOf/not、本地 `$ref`、常见数值/长度约束。远程引用不支持。`strict:true` 遇到未支持的关键字（如 format）提前拒绝；这是本地验证，并非原生约束解码承诺。
- `required` / 指定工具 / `none` / `parallel_tool_calls:false` 会校验实际结果；模型违反选择、调用未知工具或参数不合规时返回 `invalid_tool_response`，不把半成品调用发给客户端，也不自动再次付费生成。尚未输出流时返回 HTTP 502；正文或思考已经输出时，Chat 发送 SSE error 后结束，Responses 发送 error / response.failed，客户端应将其视为失败而非成功回答。
- `stream:true` 的工具模式实时转发上游正文和思考增量，不再等待完整最终回答。正文、思考仅发送一次；Responses 的 item ID、output_index 及最终 output 按实际输出顺序保持一致。`stream:false` 仍返回完整结果。
- 工具调用独立缓冲，参数校验和原生轮交接完成后才交付。Chat 使用 `delta.tool_calls[index]`；Responses 使用 `response.output_item.added`、`response.function_call_arguments.delta/done` 或 `response.custom_tool_call_input.delta/done`，最后 `response.completed`。参数 delta 可以是一次完整字符串，不保证逐 token 到达；工具发现、上游思考和生成仍可能有等待，应保留合理的客户端超时。
- 两个控制连接、独立 ID 分配及图片准备可并行进行，全部就绪后才发送生成请求。SSE 带 `X-Accel-Buffering: no`，请求 Nginx 及时转发；代理配置若显式忽略该头，仍须配置 `proxy_buffering off`。参见 [OpenAI 流式事件约定](https://developers.openai.com/api/reference/resources/responses/streaming-events) 与 [Nginx 缓冲说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)。
- 工具模式的 system/developer 及 Responses instructions 通过带角色标签的 `custom_instructions` 完整发送一次，不再同时复制到普通会话 JSON 中。用户消息、assistant 调用与 tool 结果仍完整保留，客户端请求格式不变。
- 已收到本轮有效原生 MCP 调用时，随后到达的 AWAITING_INPUT / REQUIRE_EXTERNAL_EXECUTION 视为等待工具结果，继续按已校验调用交接。没有本轮有效调用的桌面等待仍明确失败，不会执行上游桌面命令。
- 每轮工具请求在 SQLite 系统日志增加一条 `agent timing: {...}`，可用现有管理员接口 `GET /pool/admin/logs?kind=system&level=info` 查询。记录 `turn_id`、模型、状态、实际思考档、工具/工具发现次数、输入字节数及相对本轮启动的毫秒时间：`ids_ready_ms`、`controls_ready_ms`、`images_ready_ms`、`prepared_ms`、`send_started_ms`、`send_ack_ms`、`tool_list_ms`、`tools_ready_ms`、`first_event_ms`、`first_reasoning_ms`、`first_text_ms`、`tool_call_ms`、`close_started_ms`、`close_done_ms`、`total_ms`。未发生的阶段不出现；`model_ends_ms` 最多记录 16 个模型结束时间。计时不包含进入原生适配前的排队/目录刷新或客户端执行工具的时间，不等于客户端实际首字延迟。日志不包含提示词、工具参数、结果正文或凭据；保留策略沿用系统日志设置。
- 原生工具轮可能包含多次内部推理。usage 合计当前已观察到的 MODEL_CALL_END，用量包含上游平台提示与工具发现开销，**不是客户端历史的上下文长度**。数据库标记 `usage_scope:"all_model_calls"`。交接时尚未报告的用量/积分保持未知，不编造费用。客户端不应单凭该合计值判断是否必须压缩上下文。
- 已开始上游生成后的失败不自动换号或重复发送。客户端同样应避免对不确定是否已执行的工具无限重试；执行状态由客户端记录。

## 图片附件

图片支持普通对话和工具调用混用。Chat 在用户 `content` 中使用：

```json
{"type":"image_url","image_url":{"url":"data:image/png;base64,<图片base64>","detail":"auto"}}
```

Responses 在用户消息 `content` 中使用：

```json
{"type":"input_image","image_url":"https://example.com/image.png","detail":"auto"}
```

两种形式均可使用完整 HTTP(S) URL 或 base64 data URL；同一消息可以混合多个文本块与图片，也可以只含图片。工具返回截图等图片时，Chat 的 tool content 数组和 Responses function_call_output / custom_tool_call_output 的 output 数组也支持相应图片块。system/developer/assistant 的图片内容不支持。

- 支持 PNG、JPEG、GIF、WebP；单张最多 10 MiB，一次完整请求历史最多 10 张、解码后总大小最多 20 MiB；JSON 请求体最多 32 MiB，超出返回 413 `request_too_large`。
- 图片按内容签名验证，base64 必须有效并匹配声明格式；不支持 SVG、PDF、音频、普通文件或其他服务的 file_id。未知文件引用返回 `unsupported_image_reference`；不是仅凭 URL 后缀判断图片。
- detail 接受 auto/low/high/original 以兼容客户端字段，原生接口没有等价预算设置；当前不保证这些值改变图片解析精度或费用。
- 远程下载不携带调用方密钥或百度 Cookie。DNS 结果全部检查，连接固定到已检查地址；拒绝本机、内网、链路本地及保留地址，最多跟随三次重新检查的重定向。下载超时为 30 秒，下载流同样受单张大小限制。
- 后端上传实际图片字节，完成上游安全检查与会话关联后才发送对话；不会把 URL 或 base64 拼成普通提示词代替图片。相同客户端凭据下缓存云文件 ID 一小时、最多 64 项，每个原生会话仍独立关联。账号或凭据之间不共享文件缓存。
- 请求中的图片随对话正文保存到 SQLite；store:false 不保存新正文和图片内容，仅保留用量。工具模式若依赖 previous_response_id，应使用 store:true；大量图片会增加数据库体积，可按隐私和容量需求自行重传完整历史并使用 store:false。**store:false 不等于删除上游已接收的图片或会话**，上游保留规则由其服务决定。
- `invalid_image`、`image_too_large`、`unsafe_image_url` 表示输入、大小或地址不合规；`image_download_failed`、`image_upload_failed` 表示获取/上传/关联失败；`image_rejected` 表示上游安全检查拒绝。不会删除图片后静默降级成纯文本生成。

已用 GLM Flash 真实验证图形颜色和图片中文字，DeepSeek v4.1 Flash 也通过图片识别并结构化回报正确标签与圆形数量；Pi 1.2.0 在 Chat 图片附件及 Responses 工具图片结果两种流程中均完成识图、写文件、执行固定检查。各模型的图片理解效果仍取决于上游，不将一次成功当作全部模型能力保证。

## 会话隔离

- 无明确标识时每次创建独立会话，不按相同消息正文匹配旧会话。
- Chat 通过 `x-kuku-session` 续聊；Responses 推荐只用上轮返回的 `previous_response_id`。
- 普通上游续聊发送最新用户输入；新建普通会话发送完整历史，系统/开发指令同时进入自定义指令字段。
- 工具模式每轮新建原生会话并重放客户端历史，不能用 Chat 会话标识代替历史；Responses 工具历史可保存在 SQLite 并通过 previous ID 恢复。
- 会话按本地账号、已验证的上游身份和逻辑标识隔离；不同账号使用相同逻辑标识也不会共用上游会话。
- Responses 续聊固定原账号。冲突指定账号、删除/替换身份、无法确认旧归属等情况会明确拒绝，不悄悄切到其他号。
- 同一账号会话请求串行，不同账号可并行。新对话仍可按号池状态选择可用账号。

相关稳定错误码包括 `response_account_mismatch`、`response_account_unavailable`、`session_account_mismatch`、`session_history_unavailable`。不要把上游 `session_id` 直接当作本地逻辑会话或 response ID。

## 号池查询与管理

### 查询

| 请求 | 返回内容 |
|---|---|
| `GET /pool/state` | `{accounts,sessions,admin_enabled,api_open,api_key_count,auto_claim}`，读取本地状态 |
| `GET /pool/health?account=<id>` | `{checked_at,accounts}`，只读上游登录态检查 |
| `GET /pool/points?account=<id>` | `{checked_at,total_balance_points,accounts}`，上游余额 |
| `GET /pool/sessions?account=<id>&offset=0&size=20` | `{checked_at,accounts}`，上游会话；size 范围 1–50 |

`account` 可省略以查询全池。状态账号含 `id`、`alias`、`priority`、`disabled`、`auth_dead`、`balance_dead`、`balance_retry_in_ms`、`cooldown_remaining_ms`、`has_credential`；不回显 Cookie。

`priority` 越小越优先。登录态检查失败可能更新失效标记，网络不可达用 `unreachable:true` 表示，不等同登录失效。余额账号结果含 `ok`、`code`、`message`、`assets`、`balance_points` 等；只有 token 资产是推理积分，时长、任务数等其他桶不能相加。

上游会话行含 `session_id`、`title`、`status`、`session_type`、`is_read`、`ctime`、`mtime`、`artifact_count`、`created_by_this_pool`。客户端建立的其他会话仅展示，不能直接接管；本池会话续聊仍需原逻辑标识或 response ID。

### 账号写入

| 请求 | 输入与结果 |
|---|---|
| `POST /pool/admin/accounts` | `{id,bduss,stoken,alias?,priority?,disabled?}`；或用 `ptoken` 替代 `stoken`；成功 201 |
| `PATCH /pool/admin/accounts/:id` | 修改 `alias`、`priority`、`disabled`、`bduss`、`stoken`；200 `{ok:true,account}` |
| `DELETE /pool/admin/accounts/:id` | 200 `{ok:true,accounts,gap:true}` |
| `POST /pool/admin/resequence` | 按当前顺序重排为连续优先级，返回账号列表 |
| `POST /pool/admin/reset-cooldown` | `{id?}`，省略则处理全池，清冷却、失效与余额暂不可用标记 |

添加返回 `{ok:true,accounts,minted_stoken,desktop_login}`。`stoken` 与 `ptoken` 不能同时传。凭据更新可只传一个字段，空值拒绝；更新先核实身份、保存数据库再生效，成功清除相关运行时失效标记。

本地 ID、相同标准化 Cookie 或相同上游用户冲突返回 409 `account_already_exists`，不覆盖已有账号。无法核实身份返回 502 `account_identity_unavailable`。同名别名不等于相同用户；历史重复记录不自动合并。

### 电脑端初始化

成功新增账号后，后端尝试用已配置的真实电脑端上下文初始化，结果放在 `desktop_login`。**账号新增成功与奖励是否到账独立**，初始化失败不会撤销账号。

- `GET /pool/admin/accounts/:id/desktop-login`：只读 `{ok:true,account_id,configured,initialization}`。
- `POST /pool/admin/accounts/:id/desktop-login`：`{}` 或 `{retry:true}`，显式补跑单号。

状态为 `credited`、`no_credit`、`balance_unknown`、`unavailable`、`failed` 或 `verification_pending`；附 `message`、`reported`、`claimed_points`、`claimed`、余额观测及必要诊断字段。`credited` 表示观察到余额增加，不承诺固定活动奖励。无真实上下文时返回 unavailable；结果不确定时仅验证余额，不重复可能已完成的发奖请求。

## 扫码与短信登录

所有登录路由和图片均需管理员令牌，不回显上游 Cookie。图片需携带认证头获取 Blob，不能直接依赖无法携带请求头的 `<img src>`。

### 扫码

`POST /pool/admin/login/qr` 接收 `{alias?,priority?}`，返回 201 与 `login_id`、`image_path`、`poll_path`、`prompt`、`expires_in_ms`、`scanned_by`。二维码图从返回路径获取。

每约 2 秒查询一次 `GET /pool/admin/login/qr/:id`。状态包含 `pending`、`scanned`、`confirmed`、`added`、`expired`、`failed`；added 带 `account_id`，终态停止轮询。相同会话重试重放结果，不重复入池。

### 短信

1. `POST /pool/admin/login/sms`：`{"phone":"<11位大陆手机号>","alias":"我的账号"}`。
2. `state:"sent"` 后，提交 `POST /pool/admin/login/sms/verify`：`{"login_id":"ls-...","code":"123456"}`。
3. 若 `state:"captcha_required"`，按 `captcha_stage` 处理下表。

| 阶段 | 提交路径 | 请求体 |
|---|---|---|
| `send` | `/pool/admin/login/sms/resend` | `{login_id,captcha:{code:"ABCD"}}` |
| `verify` | `/pool/admin/login/sms/verify` | `{login_id,code:"123456",captcha:{code:"ABCD"}}`，继续用原短信码 |

验证码图片使用返回的 `captcha_path`。图形码标识由后端保存，前端仅提交输入字符；不需也不能覆盖服务端的 vcodestr/vcodesign。`slide:true` 时提示改用扫码。

响应可能带 `expires_in_ms`、`retry_after_ms`、`sends_remaining`。固定会话有效 10 分钟；成功发送后冷却 60 秒，每会话最多实际发送 5 次，图形挑战不算成功发送，重发不延长有效期。

验证结果为 `added`、`captcha_required`、`refused`、`failed` 等。成功带账号 ID；上游业务拒绝可在 HTTP 200 中返回状态与真实数字 `code`，不能只按 HTTP 判断成功。无法识别的登录响应返回 `login_response_unrecognized`，不会猜测成功。

重复账号的登录终态示例：

```json
{"state":"failed","code":"account_already_exists","account_id":"example-account","reason":"该百度账号已存在于号池，请使用已有账号；如需更新登录凭据，请编辑该账号"}
```

本地参数与状态错误使用 HTTP：400 `invalid_phone` / `invalid_sms_code` / `captcha_required`，404 `login_session_expired`，409 `login_in_progress` / `login_session_finished` / `sms_not_sent`，429 `sms_cooldown` / `sms_send_limit`。同会话并发验证合并；完成后不能重发。

## 普通 API 密钥

| 请求 | 行为 |
|---|---|
| `GET /pool/admin/keys` | `{open,keys}`，只返回密钥元数据 |
| `POST /pool/admin/keys` | `{label?}`；201 `{ok:true,key:{...元数据,secret},warning}` |
| `DELETE /pool/admin/keys/:id` | 吊销数据库密钥，返回 `{ok:true,keys,api_now_unauthenticated}` |

完整 `secret` 仅创建时返回，列表无法再取回。来自环境 `API_KEYS` 的 `env-*` 密钥不能通过接口删除，应修改环境并重启。

## 积分领取

| 请求 | 输入/用途 |
|---|---|
| `GET /pool/admin/claim?account=<id>` | 只读任务列表，返回 `{accounts}` |
| `POST /pool/admin/claim` | `{id?,chat?,model?,text?}`；兼容 `account` 指定单号，省略则处理全池 |
| `GET /pool/admin/auto-claim` | 每日任务配置与运行状态 |
| `POST /pool/admin/auto-claim` | `{enabled,hour}`，hour 使用服务器本地时间 |
| `POST /pool/admin/auto-claim/run` | 显式立即运行，返回 `{ok:true,result}` |

手动领取返回 `{ok:true,accounts,points_earned}`。顶层 ok 表示已处理请求，每个账号的成功/失败看 `accounts[].ok`，实际奖励看 `claimed`、`points_earned` 与余额。账号可能部分成功，不能把后续失败解释为之前领取也未到账。

默认只领取可领取任务。显式 `chat:true` 且对话任务尚未完成、不可领取时，先执行一轮独立的纯文本短答，再上报 CHAT、刷新任务并领取；已完成或已可领取时不重复发对话。对话可能消耗积分，返回的 `chat_turn.consume_points` 是实际费用。

`reported` 表示确认成功的进度上报，`notes` 表示延迟、失败或不确定说明。任务上报成功和 reward_point 非零均不能独立证明到账，以 rewardClaim 成功和余额为准。失败不自动重复付费对话。

所有账号的领取共用当前后端进程的同一个队列，覆盖上述两个 POST 领取接口、单账号领取和定时自动领取。第一个账号可立即开始；每个账号处理完毕（包括失败）后至少等待 15 秒，再开始下一个账号，不会同时执行两个账号的领取。排队期间已删除或身份已变更的账号跳过并返回 `ok:false` 与 `message`。普通对话和只读任务查询不受该队列影响。

批量任务可能耗时数分钟。两个 POST 领取接口等待期间每 10 秒发送 JSON 空白字符保活，响应头包含 `X-Accel-Buffering: no`；最终仍是原有 JSON 对象，可用 `response.json()` 解析。不要按首个响应字节判断完成，也不要因等待而重复提交。鉴权及参数错误仍在开始领取前返回；若保活已发出后出现请求级异常，HTTP 状态已是 200，最终对象为 `{ok:false,error:{message,type:"server_error"}}`，客户端也须检查该错误对象。客户端断开后已提交的任务继续处理，避免取消后重新领取。

每日领取默认关闭，配置与结果保存 SQLite。开启后每天到指定小时运行；当日已过点且尚未运行会补跑，当天自动触发不重复。状态包括 `enabled`、`hour`、`last_run_at`、`last_result`、`next_run_at`、`running`。普通模型请求不会自动领取积分。

## 统计、对话与日志

以下接口仅管理员可用，生产入口已配置 SQLite；未配置数据库的嵌入进程返回 501。

### 通用过滤与分页

- `from` / `to` 接受 `YYYY-MM-DD`（UTC 零点）或带时区 ISO 8601，范围 `[from,to)`。
- `limit` 默认 50，范围 1–200；`offset` 默认 0，范围 0–1000000。
- 列表返回 `{ok:true,data,total,limit,offset}`，时间及稳定次序倒序；total 为过滤后的总条数。
- 本组记录的 `created_at` 为 **Unix 毫秒**，区别于 OpenAI 响应的秒单位。

### token 统计

`GET /pool/admin/stats/tokens?group_by=model`

过滤支持 `from,to,model,account,source,status`。`group_by` 为 `day`（默认）、`model`、`account`、`source`；日期桶为 UTC。`source` 为 `chat,responses,claim,legacy_response`，`status` 为 `completed,failed,cancelled`。

返回 `{ok,checked_at,summary,group_by,groups,groups_truncated,token_scope,timezone,historical_coverage}`。summary 和分组包含：

| 指标 | 含义 |
|---|---|
| `attempts` / `completed` / `failed` / `cancelled` | 上游尝试数与结果，重试各记一次，不等于 HTTP 请求数 |
| `usage_known_attempts` / `points_known_attempts` | 已知用量/积分的覆盖次数 |
| `prompt_tokens` / `completion_tokens` / `total_tokens` | 上游报告 token 合计 |
| `reasoning_tokens` / `cache_read_tokens` | 独立明细，不能再次加到 total 上 |
| `consume_points` | 已观测的积分消耗合计 |
| `partial_usage_attempts` | 多次模型调用仅按最后一次报告统计的记录数 |

一轮多次 MODEL_CALL_END 当前取最后一次，不盲目累加，完整事件另存。未知用量不估算入账；失败中已观测的用量仍计入。分组最多 1000 条，截断不影响总汇总。历史删除正文后统计仍保留，迁移前没有保存的 Chat 记录无法补齐。

### 对话

`GET /pool/admin/conversations` 支持 `from,to,model,account,source,status,session_key,limit,offset`。

列表行含 `id,created_at,source,model,account,session_key,session_id,status,content_stored,prompt_tokens,completion_tokens,total_tokens,consume_points,usage_scope,duration_ms`，不含正文。

`GET /pool/admin/conversations/:id` 返回 `{ok:true,data}`，详情另含 `reply_id,think_mode,messages,output_text,reasoning_text,reasoning_tokens,cache_read_tokens,model_call_count,usage_events,error_code`。未知积分或内容可能为 null，`content_stored` 为 0/1。`usage_scope` 为 `single_model_call,last_model_call,all_model_calls,reported,unknown`；all_model_calls 表示原生工具轮中已观察到的调用合计，last_model_call 仍表示旧文本链路只统计末次调用。含工具调用的 `output_text` 保存 `{content,tool_calls}` 的 JSON 文本。

这里的 `turn-*` ID 是归档记录 ID，不能作为 `previous_response_id`。客户端断开可能记录 cancelled，不保证上游不计费。`store:false` 不保存正文/思考；删除或清理正文不删除累计统计。

### 日志

`GET /pool/admin/logs` 支持 `from,to,level,kind,limit,offset`；level 为 `info,warn,error`，kind 为 `http,system,legacy`。

行字段为 `id,created_at,level,kind,method,path,status,duration_ms,message`。不记录请求头、请求体或查询字符串；系统消息脱敏并限长，旧导入时间不等于逐行真实发生时间。

## 系统设置

`GET /pool/admin/settings`：

```json
{
  "ok": true,
  "settings": {"site_name":"kuku2api","log_retention_days":7,"conversation_retention_days":0},
  "auto_claim": {"enabled":false,"hour":9,"last_run_at":null,"last_result":null,"next_run_at":null,"running":false},
  "storage": {"engine":"sqlite","schema_version":1}
}
```

`PATCH /pool/admin/settings` 直接提交 settings 的字段，例如 `{"site_name":"我的号池","log_retention_days":30}`。只允许站点名称（去空白后 1–80 字符）与两个保留天数（整数 0–3650，0 为长期保留）。省略字段保持原值，未知字段拒绝。

修改策略会立即清理已过期数据，之后启动/每小时继续执行；可能移除旧续聊映射，累计用量保留。每日领取通过独立 auto-claim 接口配置。这里不能读取/写入管理员令牌、Cookie、浏览器连接信息或任意数据库 settings 键。

v1.0.0 起，新安装的日志默认保留 7 天，对话默认长期保留。升级沿用数据库已有保留设置，包括此前保存的 30 天或 0，不强制覆盖。接口字段、允许范围与鉴权不变。

## 运行实例管理

`GET /pool/admin/runtime` 返回 `{ok:true,instance_id,pid,started_at,root,database_file}`，供安装升级核实目录、数据库和实例归属。仅生产运行实例提供。

`POST /pool/admin/shutdown` 提交 `{"instance_id":"<刚查询的实例ID>"}`。验证一致后返回 202，异步停止接收连接、关闭调度、等待已有请求及领取任务结束，再关闭数据库退出。202 表示接受请求，调用方必须等待 PID 退出与端口释放后再替换文件。

实例 ID 不匹配返回 409；管理员身份仍独立验证。不能只根据端口被占用就停止未知进程。

安装器现在默认后台启动并在验证成功后退出；接口字段和鉴权不变。Linux root + systemd 部署使用 `Restart=on-failure`，此接口的正常退出不会触发异常重启，但系统服务若仍启用，服务器重启后仍会启动。安装器升级/重启先停止对应 systemd 单元以取消待执行的重启，再等待端口释放。永久停用与日志查看见 [运行维护](operations.md#后台服务管理)。

## 错误处理

常见错误形状：

```json
{"error":{"message":"说明","type":"invalid_request_error","code":"model_not_found"}}
```

`code`、`type` 并非所有错误都有；按 HTTP 状态和存在的稳定 code 分支，message 用于显示。常见 type 包括 `invalid_request_error,pool_error,upstream_error,authentication_error`。

| HTTP | 典型情况 |
|---|---|
| 400 | 参数、模型、档位或游标错误；工具相关包括 `unsupported_tools`、`unsupported_tool_format`、`invalid_tools`、`invalid_tool_schema`、`invalid_agent_request`、`invalid_tool_history`、`agent_context_too_large`、`agent_history_unavailable`；图片相关包括 `invalid_image`、`image_too_large`、`unsafe_image_url`、`unsupported_image_reference`、`image_rejected` |
| 401 | 管理员令牌或普通 API 密钥不正确 |
| 402 | 全池积分不足，`insufficient_balance` |
| 404 | 账号、记录、会话或路由不存在 |
| 409 | 账号不可用、重复账号、续聊归属冲突或操作冲突 |
| 413 | `request_too_large`，JSON 请求体超过 32 MiB |
| 422 | `upstream_requires_client`，上游等待电脑客户端工具或输入 |
| 429 | 短信发送冷却或次数上限 |
| 500 | 服务或持久化异常 |
| 502 | 上游失败、响应不完整或身份无法核实；工具模式 `invalid_tool_response` 表示输出校验失败，`upstream_requires_client` 表示请求了不可用的原生桌面工具或输入；图片相关为 `image_download_failed`、`image_upload_failed` |
| 504 | `upstream_timeout`，上游未在等待上限内完成 |

流已经开始时不能再修改 HTTP 状态，应读取错误事件。短信业务拒绝、逐账号体检及积分领取可在 HTTP 200 中返回业务失败，必须检查其状态/账号结果。上游请求已经发送但结果不确定时，不自动换号重发，避免重复扣分。
