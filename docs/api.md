# kuku2api 后端接口文档（前端开发用）

版本 0.1.0 · 文档修订 2026-10-09 · 历史示例来自离线自桩与真实验收，公开版本已替换本机私有标识；当前持久化及安装行为以 §19–24 为准。

- 后端：Node ≥ 24.15，运行时**零第三方依赖**
- 默认监听：`http://127.0.0.1:8787`（只绑回环）
- 无构建步骤，直接 `node src/server.mjs`
- 回归状态：离线 **259 项**；SQLite 实际迁移及一条真实对话验收通过，详见 §19；历史 `npm run accept` 真上游 **15 项**在用户授权后全绿，详见 §15.5。本轮安装工作不执行付费验收。

### 本次修订（前端必读，有 breaking change）

| 变更 | 影响 |
|---|---|
| **新增「登录加号」整套路由**：百度App 扫码二维码 + 手机号验证码，见 §14 | 加号不再需要手工抠 cookie；二维码图片必须走我们的同源路由，验证码图也是 |
| **`/pool/admin/keys` 密钥可在运行时增删**（`API_KEYS` 仍可配多个） | 前端可做"发key/吊销key"面板；注意 §14.5 最后一条：吊销最后一个 key 会让 `/v1/*` 变成不鉴权 |
| **`think_mode` 现在会前置校验**：不在 `think_list` 里 → 400 `invalid_think_mode` | 以前乱填的档号会被上游默默接受并照样扣分，见 §14.6 |
| **`/v1/responses` 新增接受扁平 `reasoning_effort`**，且 `think_mode` 若同时给出则优先 | 以前只认嵌套 `reasoning.effort`，扁平写法被静默丢弃（默认档恰好等于 `high`，所以自测看不出来） |
| `POST /pool/admin/accounts` 可用 `bduss + ptoken` 代替 `stoken`（自动换 STOKEN） | STOKEN 是 httpOnly、DevTools 里看不到，这条是给你的兜底，见 §14.4 |
| `/pool/state` 新增 `api_open`、`api_key_count` | UI 该在 `api_open:true` 时挂醒目提示 |
| `GET /v1/models` 每个模型新增 `display_name` | 下拉框应显示它，提交仍用 `id` |
| **`/v1/models` 的 `default_model_id` 改名为 `default_model`**，且值从恒为 `null` 变成可用的 `model_name`（实测 `auto`） | **breaking**：读旧字段的地方要改 |
| 新增 `GET /v1/responses`（列表 + 游标分页 + `session_key` 过滤） | 对话列表可以走服务端了 |
| `model` 不在目录里 → **400 `model_not_found`**（错误体新增 `error.code`） | 前端要把模型名当作受控输入，别再"发了再说" |
| `created_at` 秒级，列表按创建序返回 | 同一秒内的多轮**不保证**按 `created_at` 单调 |
| 实测：`id` 里可能带 `/`（`ali-minimax/minimax-m3`） | 拼 URL 要 `encodeURIComponent` |
| 实测：`store:false` 的轮次仍入 ledger（供续接）但**不出现在列表里** | 别把列表当成全量历史 |
| **新增 `GET /pool/points`：账号剩余积分可查了**（详见 §8） | 之前"余额读不到、需要 native 签名"的结论**是错的**，前端可以做余额显示了 |
| **新增 `GET /pool/sessions`：上游会话列表可查了**（含客户端里建的，详见 §8） | 注意 `created_by_this_pool:false` 的项**不能续接**，只能展示 |
| **`PATCH /pool/admin/accounts/:id` 现在可改 `bduss` / `stoken`**（换凭据不用删了重加，详见 §9） | 死号补新 cookie 一条请求搞定；改成功自动清 `auth_dead` 与冷却 |
| **`GET /v1/responses` 的坏游标错误体加了 `error.code:"cursor_not_found"`** | 前端不用再匹配 `unknown 'after' cursor` 这个字符串 |
| **`/v1/models` 冷启动并发只做一次上游目录拉取**（in-flight 合并） | 前端并行开多个页面也不会向上游重复要目录 |
| **会话映射落盘 `sessions.json`：进程重启不再失忆**（详见 §8 末） | 行为变更：`/pool/state` 的 `sessions` 重启**不再清零**；`previous_response_id` / `x-kuku-session` 跨重启可续 |

---

## 0. 启动与环境变量

```bash
npm start                          # 等价于 node src/server.mjs
PORT=8787 API_KEYS=a,b ADMIN_TOKEN=xxx node src/server.mjs
```

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `API_KEYS` | 空 | 逗号分隔的环境普通 key。**环境及数据库普通密钥全部为空时不鉴权**（本机自用） |
| `ADMIN_TOKEN` | 自动生成或读取 SQLite 令牌 | 管理端令牌。非空显式值优先；未配置或仅空白时加载数据库，缺失则生成并保存强令牌。所有 `/pool/admin/*` 仍需正确令牌 |
| `CORS_ORIGIN` | `*` | `access-control-allow-origin` 的值 |
| `KUKU_BASE_URL` | `https://kuku.baidu.com` | 上游基址，仅测试用；每次请求现读，不是启动时固化 |
| `LEDGER_MAX` | `500` | 仅旧内存 ledger 兼容参数。SQLite 启动不按数量淘汰，使用数据库对话保留天数，0 代表长期保留 |
| `DATABASE_FILE` | `data/kukuai.sqlite`（项目根目录下） | SQLite 文件位置；运行账号需能写父目录，以创建 WAL/SHM。生产使用持久文件 |

后端要求 **Node >=24.15**，本轮实际验证环境为 Node 26.4.0 / SQLite 3.53.2。当前持久化机制以 §19 为准；下文旧 JSON 示例仅保留作迁移输入和历史兼容说明。

凭据文件 `accounts.json`（UTF-8，已 gitignore）：

```json
{
  "default_device_id": "<本机真实设备ID>",
  "accounts": [
    { "id": "kuku-0", "alias": "主号", "priority": 0, "bduss": "<192字符>", "stoken": "<64字符>" }
  ]
}
```

写盘走"备份 `.bak` → 写 `.tmp` → rename"。损坏的 JSON 保留原文件并报错，错误不引用文件内容。`keys.json` 损坏或结构非法时拒绝启动，避免悄悄退回无鉴权模式；修复文件或人工核对 `.bak` 后再恢复，详见 §15。

另有 `responses.json`（同为 UTF-8、已 gitignore）保存 `previous_response_id → 上游 session` 的映射，进程重启后 `previous_response_id` 与 `GET /v1/responses/:id` 仍然可用。

`sessions.json`（第三个状态文件，同样已 gitignore）保存**会话键 → 上游 `session_id`** 的映射，是后加的一次失忆修复，详见 §8 末尾"重启不再失忆"。

**三个文件都是凭据/状态文件，前端永远不要试图直接读它们，一律走接口。**

---

## 1. 概念模型（前端必须先建立这几个心智单位）

| 概念 | 含义 | 前端怎么用 |
|---|---|---|
| **account** | 一个百度号 = 一份 `bduss/stoken` | 号池列表的主体，`id` 是稳定主键 |
| **priority** | 整数，**越小越优先** | 语义是"先榨干最小序号那一档"，不是轮转 |
| **cooldown** | 失败后的临时摘出，单位 ms 剩余 | 显示"多久后恢复" |
| **auth_dead** | 登录态已死（业务码 1000004 / 200001） | 需要**人工重新登录**，冷却到点也不会自己好 |
| **disabled** | 人工停用 | 不参与调度 |
| **session** | 上游会话，`session_id` | 多轮记忆挂在这里，按 `x-kuku-session` 键复用 |
| **consume_points** | 这一轮真实扣的积分 | **唯一可信的成本口径**，不要用 token 估算 |
| **think_mode** | 思考强度档位 | 整数 1/2/3/4，来自 `/v1/models` 的 `think_list` |
| **asset bucket** | 上游把配额分成 4 个桶：`token` / `duration` / `scheduled_task` / `realtime_t` | **只有 `token` 是积分**（小数），即 `/pool/points` 的 `balance_points`；其余是别的名额，别相加 |

---

## 2. 通用约定

### 路由总表（鉴权列是硬边界，照它做 UI 权限）

| 方法 + 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /healthz` | 无 | 进程活着 |
| `GET /v1/models` | `API_KEYS` | 上游模型目录 |
| `POST /v1/chat/completions` | `API_KEYS` | Chat Completions |
| `POST /v1/responses` | `API_KEYS` | Responses（含流式） |
| `GET /v1/responses` | `API_KEYS` | Responses 列表 + 游标分页 |
| `GET /v1/responses/:id` · `DELETE` | `API_KEYS` | 回查 / 删除单条 |
| `GET /pool/state` · `GET /pool/health` | `API_KEYS`（**不是**管理令牌） | 号池只读 |
| `GET /pool/points` | `API_KEYS` | 账号剩余积分（真上游，零积分） |
| `GET /pool/sessions` | `API_KEYS` | 上游会话列表（真上游，零积分） |
| `POST/PATCH/DELETE /pool/admin/*` | `ADMIN_TOKEN`（普通 `API_KEYS` 进不来） | 号池写操作 |
| `POST/GET /pool/admin/login/*` | `ADMIN_TOKEN` | **登录加号**：扫码 / 短信验证码，详见 §14 |
| `GET/POST/DELETE /pool/admin/keys*` | `ADMIN_TOKEN` | 运行时密钥增删查，详见 §14.5 |
| `GET/POST /pool/admin/claim` | `ADMIN_TOKEN` | 免费积分：只读任务列表 / 领取，详见 §14.9 |
| `GET/POST /pool/admin/auto-claim[​/run]` | `ADMIN_TOKEN` | 每日自动领取的开关与立即执行，**默认关闭**，详见 §14.9 |
| `OPTIONS *` | 无 | 预检，204 |

未匹配任何路由 → 404 `not found`。`API_KEYS` 为空时**所有 `API_KEYS` 门形同不存在**（本机自用）。

**请求**
- `content-type: application/json; charset=utf-8`
- 鉴权：`Authorization: Bearer <key>` 或 `x-api-key: <key>`
- 管理端：`Authorization: Bearer <ADMIN_TOKEN>` 或 `x-admin-token: <token>`
- 跨源已放开：预检 `OPTIONS` 返回 204 + 允许的自定义头清单（`authorization, content-type, x-api-key, x-admin-token, x-kuku-account, x-kuku-session, x-kuku-allow-unavailable`）

**错误响应体统一为**

```json
{ "error": { "message": "…", "type": "invalid_request_error", "code": "model_not_found" } }
```

`type` 取值：`invalid_request_error`（默认）、`pool_error`（号池调度层面拒绝）、`upstream_error`（上游失败）、`authentication_error`（管理端鉴权）。

`code` **目前有三个取值**：`model_not_found`（`model` 不在 `/v1/models` 目录里）、`cursor_not_found`（`GET /v1/responses` 的 `after` 游标已被淘汰/不存在）、`invalid_think_mode`（思考强度档位不在 `think_list` 里）。登录路由另有 `login_qr_failed` / `login_poll_failed` / `login_sms_failed` / `stoken_exchange_failed`（都是 502，`type:"upstream_error"`）。其余错误体只有 `message` + `type`，前端按 `type` + HTTP 状态分支即可；遇到 400 想精确分支就判 `error.code`，**别去匹配 `error.message` 的文案**。

**message 已过脱敏**：`BDUSS=` / `STOKEN=` 的值一律替换成 `<redacted>`，前端可以直接展示。

**上游业务失败表现为 HTTP 200 + 业务码**——这是本项目最大的坑，后端已经把它翻译成真正的失败并触发切号，前端只要按 HTTP 状态判断即可，**不要**去解析 `status.code`。

---

## 3. `GET /healthz`

```json
{ "ok": true }
```
无需鉴权。用来探测服务是否活着（与"上游是否还认我们"是两回事）。

---

## 4. `GET /v1/models`

需要 `API_KEYS` 鉴权（若已配置）。

```json
{
  "object": "list",
  "data": [
    { "id": "auto", "object": "model", "owned_by": "kuku", "display_name": "Auto", "cost_ratio": "", "description": "" },
    { "id": "gateway-deepseek-v4-flash-tencent", "object": "model", "owned_by": "kuku", "display_name": "DeepSeek-V4-Flash", "cost_ratio": "0.15x", "description": "夜间折扣" },
    { "id": "glm-5.3", "object": "model", "owned_by": "kuku (vip)", "display_name": "GLM-5.3", "cost_ratio": "0.77x", "description": "会员优先" }
  ],
  "think_list": [
    { "id": "1", "think_name": "低", "description": "快速问答" },
    { "id": "2", "think_name": "中", "description": "一般性任务" },
    { "id": "3", "think_name": "高", "description": "专业办公场景（默认）" },
    { "id": "4", "think_name": "极高", "description": "高度复杂任务、中大型任务" }
  ],
  "default_model": "auto",
  "default_think_id": 3
}
```

实测共 13 个模型（2026-10-04 拉取），`id` → `display_name` 全量对照：

| `id`（请求里填这个） | `display_name`（UI 显示这个） | `cost_ratio` | `description` | vip |
| --- | --- | --- | --- | --- |
| `auto` | Auto | *(空)* | | |
| `gateway-deepseek-v4.1-flash-volcengine` | DeepSeek-V4.1-Flash | 0.16x | | |
| `gateway-deepseek-v4-pro-tencent` | DeepSeek-V4-Pro | 0.52x | 日常任务首选 | |
| `gateway-deepseek-v4-flash-tencent` | DeepSeek-V4-Flash | 0.15x | 夜间折扣 | |
| `gateway-glm-5.3-flash` | GLM-5.3-Flash | 0.07x | | |
| `glm-5.3` | GLM-5.3 | 0.77x | 会员优先 | 是 |
| `gateway-glm-5.2` | GLM-5.2 | 0.67x | 复杂任务优秀 | |
| `gateway-glm-5.1-kuaishou` | GLM-5.1 | 0.56x | | |
| `ernie-5.1` | 文心 5.1 | 0.53x | 中文旗舰 | |
| `ms-kimi-k3` | Kimi-K3 | 3.60x | 会员优先 | 是 |
| `gateway-kimi-k2.7-code-tencent` | Kimi-K2.7-Code | 0.58x | | |
| `gateway-kimi-k2.6` | Kimi-K2.6 | 0.56x | | |
| `ali-minimax/minimax-m3` | MiniMax-M3 | 0.35x | | |

要点：

- `data[].id` 是聊天请求里 `model` 要填的值（上游内部名）；`display_name` 才是给人看的名字，两者对不上的情况确实存在（`ali-minimax/minimax-m3` → `MiniMax-M3`、`ernie-5.1` → `文心 5.1`）。**下拉框显示 `display_name`，提交 `id`**
- **注意 `id` 里可能有 `/`**（`ali-minimax/minimax-m3`，实测真能跑通）。放在 URL 路径里时要 `encodeURIComponent`，放在请求体里不用
- `id` 与 `display_name` 都原样透传给上游（内部字段 `model_name` / `model_display_name`），所以 `display_name` 不是纯装饰，后端拿它是拼请求体的
- `model` 不在目录里 → **400 `model_not_found`**，不会打到上游。原因见 §11：让上游去拒一个拼错的模型名，代价是白烧一轮 + 该账号被冷却几分钟
- 目录端点挂了时**放行**（fail-open）：推理本身不依赖 `model/list`，不能因为目录拉不到就把所有请求 400 掉
- **冷启动并发只做一次上游拉取**：进程刚起来、目录还没落定时，N 个并发 `/v1/models`（或 N 个并发推理请求撞上未命中的模型 id）会被合并成**一次** `model/list` 调用。以前会打 N 次，白烧 N 个 RTT 还容易撞上游频控。前端可以放心并行拉
- `cost_ratio` 是字符串带 `x` 后缀，直接显示即可；`auto` 的倍率是空串
- `owned_by` 含 `(vip)` 表示当前账号大概率用不了 → **UI 应该置灰而不是允许点**
- `description` 是上游给的销售话术（"日常任务首选"/"夜间折扣"），做 tooltip 正合适
- `think_list[].id` 是**字符串**，`default_think_id` 是**数字**（后端从上游的 `default_think_id: "3"` 转换）。前端提交时请传数字，后端也会做 `Number()` 兜底
- ⚠️ **`think_list` 是目录级的，13 个模型共用同一份**。实测模型对象只有 `id / object / owned_by / display_name / cost_ratio / description` 六个字段，**没有任何"这个模型会不会思考"的能力位**。
  所以前端**没法**从目录判断"选了 Kimi-K3 之后第 4 档到底生不生效"。2026-10-06 已对 `gateway-glm-5.3-flash` 与 `gateway-deepseek-v4.1-flash-volcengine` 两个模型逐档实测，四档均有真实思考事件（见 §16）；其它型号仍未验证。档号传入不等于已证明固定预算或严格递增的思考深度。
  UI 的稳妥做法：档位下拉**始终可选项，但旁边标一句"具体是否生效取决于模型"**，不要把四档画成每个模型都保证生效的样子
- `default_model` 现在是**可用的 `model_name`**（上游给的是内部数字 id `"1"`，后端已解析成 `auto`），可以直接用来预选下拉框
- 结果会缓存在进程内；服务重启后第一次调用会打上游

---

## 5. `POST /v1/chat/completions`

### 请求

```json
{
  "model": "gateway-glm-5.3-flash",
  "messages": [{ "role": "user", "content": "用一句话介绍你自己，不超过30字" }],
  "stream": false,
  "think_mode": 3,
  "kuku_meta": false,
  "stream_options": { "include_usage": true }
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `model` | 否 | 默认 `gateway-glm-5.3-flash`（最便宜，0.07x）。**取值必须是 `GET /v1/models` 的 `data[].id`**，不在目录里直接 400 `model_not_found` |
| `messages` | **是** | 非空数组，否则 400 |
| `stream` | 否 | **默认 `false`**。只有 `true` 才走流式（严格按 OpenAI 语义，不是"默认流式"） |
| `think_mode` | 否 | 1/2/3/4，缺省用上游默认档。**填了目录里没有的档号 → 400 `invalid_think_mode`，不会打到上游**（实测上游对乱档不报错、照样扣分，所以前置拦） |
| `kuku_meta` | 否 | 流式时在末尾追加一帧非标准的 kuku 元信息，见 §7 |
| `stream_options.include_usage` | 否 | 流式末尾补一帧带 `usage` 的 chunk |

**多轮怎么发**：上游 session 自己持历史。你**只需要发最新一句 user 内容**（后端也是这么做的），要延续同一段对话就带 `x-kuku-session: <固定字符串>`。

### 请求头

| 头 | 作用 | 注意 |
|---|---|---|
| `x-kuku-account` | 定向某个号（按 `id` 或 `alias`） | **不得绕过 disabled / cooldown / auth_dead**；未知 id → 404 |
| `x-kuku-allow-unavailable: 1` | 管理端探活专用，允许打停用/冷却中的号 | 普通前端**不要用** |
| `x-kuku-session` | 复用同一段上游会话 | 不带则按"首个 user 消息前 200 字"自动派生 key |

### 响应（非流式，实测）

```json
{
  "id": "chatcmpl-738962a1-b99a-4b16-9d59-40477a5cc1d1",
  "object": "chat.completion",
  "created": 1791086022,
  "model": "gateway-glm-5.3-flash",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "我是库库AI，能帮你调研、分析、创作并落地执行。（24字）" }, "finish_reason": "stop" }
  ],
  "usage": {
    "prompt_tokens": 30604, "completion_tokens": 20, "total_tokens": 30624,
    "reasoning_tokens": 0, "cache_read_tokens": 30080
  },
  "kuku": {
    "account": "kuku-0",
    "consume_points": 0.14,
    "session_id": "6ac6a1cdab24793e0912a21614791711cd7979d9",
    "reply_id": "095307108476443610661ed9ad51f01dc28157af"
  }
}
```

`kuku` 是本项目的扩展块，前端拿它做记账与会话映射：
- `account`：这轮实际由哪个号服务（失败切号后是最终成功的那个）
- `consume_points`：真实扣分
- `session_id` / `reply_id`：上游侧标识，可用于排查；`session_id` 与 `x-kuku-session` 一对多

### `usage` 的正确解读

```
prompt_tokens 30604  → 其中 cache_read_tokens 30080 是缓存读
consume_points 0.14  → 真实成本
```

**`prompt_tokens` 里绝大部分是上游系统提示词，且大量走缓存读。所以：任何"按 token 估算费用"的 UI 展示都会严重失真（可差两个数量级）。要么显示 `consume_points`，要么明确标注"token 数仅供参考，非账单"。**

实测同一句 5 字提问（`prompt_tokens ≈ 2.9–3.1 万`）不同模型的单价，用来给 UI 的倍率标签校准预期：

| 模型 | `cost_ratio` | 一轮 `consume_points` |
|---|---|---|
| `gateway-glm-5.3-flash` | 0.07x | 0.01–0.03 |
| `ali-minimax/minimax-m3` | 0.35x | **2.61** |

也就是说倍率差 5 倍、实际扣分差了约 **100 倍**（`cost_ratio` 与实扣不是线性关系，别拿它做除法反推）。**联调阶段一律用 `gateway-glm-5.3-flash`**，需要验证别的模型时也只发最短提问。

---

## 6. 流式（`stream: true`）

响应头：`content-type: text/event-stream`、`x-kuku-account: <首发账号>`。

帧序列（实测，`kuku_meta: true` + `include_usage: true`）：

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"gateway-glm-5.3-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"…","choices":[{"index":0,"delta":{"content":"cat"},"finish_reason":null}]}

data: {"…","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"…","choices":[{"index":0,"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":30123,"completion_tokens":2,"total_tokens":30125,"reasoning_tokens":0,"cache_read_tokens":29824}}

data: {"kuku":{"account":"kuku-0","consume_points":0.01,"session_id":"dee72ac5…","reply_id":"753d0258…"}}

data: [DONE]
```

解析规则：

1. 逐行取 `data: ` 前缀，`[DONE]` 结束。上游没有 `event:` 行，后端也不产出
2. **思考内容在 `delta.reasoning_content`**（不是 OpenAI 标准字段）。渲染成可折叠的"思考过程"，不要拼进正文
3. `delta.content` 是正文增量
4. 倒数第二帧可能是纯 `usage`（`choices[0].delta` 为空对象），别当正文渲染
5. `kuku` 帧**只在请求带 `kuku_meta: true` 时出现**，且排在 `[DONE]` 之前。默认不发，保证给标准 OpenAI SDK 用时不会因为陌生帧报错——**前端自己解析时要允许遇到"没有 choices 的对象"**
6. 流中途失败切号时，会先补一帧 `finish_reason: "stop"` 再续上另一个号的增量。所以"看到 stop"不等于流结束，**唯一终止条件是 `[DONE]`**

---

## 7. `POST /v1/responses` — OpenAI Responses API

契约字段名与事件序列**按 openai SDK 7.27.0 的类型定义核对**（`resources/responses/responses.d.ts`），不是凭记忆实现。

### 请求

```json
{
  "model": "gateway-glm-5.3-flash",
  "input": "用一个词回答：苹果是什么颜色",
  "instructions": "Reply very briefly",
  "previous_response_id": "resp_58f83acbaf9542868ed701efe1e361e1",
  "stream": false,
  "reasoning": { "effort": "high" },
  "store": true
}
```

| 字段 | 说明 |
|---|---|
| `model` | 否，默认 `gateway-glm-5.3-flash`。**必须是 `/v1/models` 里的 `data[].id`**，否则 400 `model_not_found` |
| `input` | **必需**。字符串，或 item 数组（`{role, content:[{type:'input_text'\|'output_text'\|'text', text}]}`）。`developer` 角色会被归一成 `system`；**带其他 `type` 的 item（`function_call`、`item_reference` 等）会被静默丢弃**，所以空内容不会报错、只会当没说过 |
| `instructions` | 原样回显在响应对象上。注意：上游历史由 session 持有，instructions 不做跨轮继承（与 OpenAI 语义一致） |
| `previous_response_id` | 续接上一轮。**id 不存在 → 404**，不会静默开新会话 |
| `reasoning.effort` 或扁平 `reasoning_effort` | `minimal`/`low`→1，`medium`→2，`high`→3，`xhigh`→4；`none` 与 `max` **不支持**，未知值 → **400 `invalid_think_mode`**（不再静默走默认档） |
| `stream` | 默认 `false` |
| `store` | 原样回显（缺省即 `true`）。**无论 true/false 后端都会记入 ledger**，否则 `previous_response_id` 无法解析；但 `store:false` 的轮次**不会出现在 `GET /v1/responses` 列表里**（`GET /v1/responses/:id` 仍能取到） |

Responses 侧**也**接受 `think_mode`（本项目的非标准扩展），且它优先于 `reasoning.effort`；两种都给了以 `think_mode` 为准，见 §14.6。

### 响应（真实取数）

```json
{
  "id": "resp_be7202c9b92547e09e2f027b2f8ccbaa",
  "object": "response",
  "created_at": 1791088056,
  "status": "completed",
  "completed_at": 1791088056,
  "error": null,
  "incomplete_details": null,
  "instructions": null,
  "model": "gateway-glm-5.3-flash",
  "output": [
    {
      "id": "msg_be7202c9b92547e09e2f",
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [{ "type": "output_text", "text": "Tangerine", "annotations": [] }]
    }
  ],
  "output_text": "Tangerine",
  "parallel_tool_calls": true,
  "previous_response_id": "resp_58f83acbaf9542868ed701efe1e361e1",
  "store": true,
  "temperature": null,
  "top_p": null,
  "tool_choice": "auto",
  "tools": [],
  "reasoning": null,
  "service_tier": "default",
  "usage": {
    "input_tokens": 31081,
    "output_tokens": 4,
    "total_tokens": 31085,
    "input_tokens_details": { "cached_tokens": 30848, "cache_write_tokens": 0 },
    "output_tokens_details": { "reasoning_tokens": 0 },
    "kuku_consume_points": 0.01
  },
  "metadata": null,
  "kuku": { "account": "kuku-0", "session_id": "040386fa…", "reply_id": "7dd3cf86…", "consume_points": 0.01 }
}
```

**优先用 `output_text`**，不要假设 `output[0]` 就是答案——有思考时 `output[0]` 是 `reasoning` 项，答案在末位。

### 流式事件（真实取数，无思考的那一轮）

```
event: response.created            data.sequence_number = 0
event: response.in_progress        1
event: response.output_item.added  2   item = message 空壳
event: response.content_part.added 3   part = {type:'output_text', text:''}
event: response.output_text.delta  4..N
event: response.output_text.done   ·    text = 全文
event: response.content_part.done  ·
event: response.output_item.done   ·
event: response.completed          最后   response = 完整对象（含 usage）
```

- **每帧都带 `event:` 行，且与 `data.type` 完全一致**；`sequence_number` 从 0 严格递增
- 有思考内容时，前面会多一组 reasoning 项（`output_index=0`）：`response.output_item.added` → `response.reasoning_summary_part.added` → `response.reasoning_summary_text.delta/done` → `response.reasoning_summary_part.done` → `response.output_item.done`，然后 message 项从 `output_index=1` 开始
- 失败时发 `error` 事件（`type:"error"`，带 `message`）后关闭，**不会**发 `response.completed`
- 与 chat/completions 不同：这里**没有** `data: [DONE]`，终止信号就是 `response.completed` 或 `error`

### 会话与状态

`previous_response_id → 上游 session` 的映射存在 **`responses.json`**（默认最多 500 条，`LEDGER_MAX` 可调，**已 gitignore**）。实测跨进程重启仍可解析：重启后 `GET /v1/responses/<旧 id>` 依然返回完整 Response 对象。

| 路由 | 行为 |
|---|---|
| `GET /v1/responses` | 列表。参数 `limit`（默认 20，非法值回落 20，钳制 1–100）、`after`（游标 = 某个 response id，取比它更早的一页）、`session_key`（按内部会话键过滤）。返回 `{object:"list", data:[完整 Response 对象，新→旧], first_id, last_id, has_more}`，空页时 `first_id`/`last_id` 为 `null` |
| `GET /v1/responses` + `after` | 游标认不出来（被 FIFO 淘汰、已删、或不在 `session_key` 过滤结果里）→ **400 + `error.code:"cursor_not_found"`**，而不是返回一个看起来像"翻到底"的空页。错误体实测形状：`{"error":{"message":"unknown 'after' cursor: resp_xxx","type":"invalid_request_error","code":"cursor_not_found"}}` |
| `GET /v1/responses` 与 `store:false` | 创建时传 `store:false` 的轮次仍会落 ledger（`previous_response_id` 要靠它），但**不出现在列表里**；`GET /v1/responses/:id` 仍然能取到 |
| `GET /v1/responses/:id` | 返回存下来的完整 Response 对象；未知 id → 404 |
| `DELETE /v1/responses/:id` | 删除映射，返回 `{id, object:'response', deleted:true}`；未知 id → 404 |

实测样本（真号 ledger，零积分，纯本地读）：

```json
{
  "object": "list",
  "data": [
    { "id": "resp_dd0eeb23196d41f6917d442dbd6e5474", "created_at": 1791088079, "output_text": "stream ok", "kuku": { "account": "kuku-0" } },
    { "id": "resp_be7202c9b92547e09e2f027b2f8ccbaa", "created_at": 1791088056, "output_text": "Tangerine", "kuku": { "account": "kuku-0" } },
    { "id": "resp_a80cdb9684654e62a9cd30dbd343e0b0", "created_at": 1791088051, "output_text": "Tangerine", "kuku": { "account": "kuku-0" } }
  ],
  "first_id": "resp_dd0eeb23196d41f6917d442dbd6e5474",
  "last_id": "resp_a80cdb9684654e62a9cd30dbd343e0b0",
  "has_more": true
}
```

（`data[]` 每项实际是完整 Response 对象，这里只留了判断形状所需的字段。）

排序按 ledger 插入序（= 创建序）反转，**不是**按 `created_at` 排：`created_at` 只有秒级精度，同一秒内的多轮如果按它排会翻成"旧→新"（已被回归测试钉住）。

"对话列表"的做法：`GET /v1/responses?limit=20` 拿到最近 20 轮，翻页用 `after=<last_id>`。想按会话聚合就先取一批、按 `data[].id` 的链条或你自己的会话名在前端分组；`session_key` 过滤是给"我已经知道内部会话键"的场景准备的。

内部会话键的真实形状（两种，实测而非推测）：
- 请求带了 `x-kuku-session` → **键就是你传的那个字符串本身**，原样落 ledger（实测 `x-kuku-session: <redacted-local-value>` → ledger 里 `session_key` 就是 `<redacted-local-value>`）
- 没带 → 由后端推导成 `k:<account>:<首条 user 消息前 200 字>`（`previous_response_id` 续接时沿用上一轮存下来的那个键，不会重新推导）

所以**想让会话键可预测，就一直自己带 `x-kuku-session`**；靠 `k:` 那个形状去硬拼迟早会被账号 id 或首条消息变化坑到。

### 多轮语义对照（前端最容易搞混的地方）

| | Chat Completions | Responses |
|---|---|---|
| 会话延续靠 | 请求头 `x-kuku-session: <你自定的字符串>` | 请求体 `previous_response_id: <上一轮返回的 resp_id>` |
| 前端要存的 | 自己的会话名 | 服务端返回的 id |
| 建议 | 二者别混用。Responses 客户端**只**用 `previous_response_id` | |

同一 `session` / 同一 `previous_response_id` 链上的请求**已在后端串行化**，并发发两轮不会互相插队污染历史。

---

## 8. 号池状态与体检（只读）

这两条走**普通 `API_KEYS`**（不是管理令牌），因为它们只读。实测（本机当前池内一个号）：

### `GET /pool/state`

```json
{
  "accounts": [
    { "id": "kuku-0", "alias": "主号", "priority": 0, "disabled": false,
      "auth_dead": false, "balance_dead": false, "balance_retry_in_ms": 0,
      "cooldown_remaining_ms": 0, "has_credential": true }
  ],
  "sessions": 1,
  "admin_enabled": true,
  "api_open": true,
  "api_key_count": 0
}
```

- `has_credential`：**凭据本身永不回显**。UI 只能知道"有没有配好"
- `balance_dead` / `balance_retry_in_ms`：该号上一次被上游判"积分不足"（`errno 11002`），以及**还有多久自动回到轮换**。这是重试窗口不是永久标记，`GET /pool/points` 读到余额就会立刻清（见 §14.8）
- `admin_enabled`：服务端是否有有效管理员令牌（显式 `ADMIN_TOKEN` 或本机自动生成值）。正常命令行启动会自动初始化，返回 `true`；嵌入调用 `createApp` 而未传令牌时仍为 `false`，管理按钮应禁用
- `sessions`：当前认得的上游会话数。**行为已变更**：原先"重启清零"，现在会话映射落盘在 `sessions.json`，重启后这个数会带回来（见本节末尾）

### `GET /pool/health?account=kuku-0`

零成本、不烧积分的登录态体检（打上游一个只读接口 `clientmessage/list`）。实测：

```json
{
  "checked_at": "2026-10-04T05:26:58.915Z",
  "accounts": [
    { "id": "kuku-0", "alias": "主号", "ok": true, "code": null, "message": "" }
  ]
}
```

死号那一路径长这样（当时池里挂了一个失效凭据）：

```json
{ "id": "kuku-1", "alias": "二号(测试)", "ok": false, "code": 1000004, "message": "code=1000004 not login" }
```

- 不传 `account` = 检查全部（会把全池都标一遍，UI 上要给"全池体检"和"单号体检"两个不同入口）
- 体检失败的号会被标 `auth_dead` 并进长冷却，**下次 `pick` 就跳过它**
- 网络不通只记 `unreachable: true`，**不会**冷却或标死（抖动不定罪）

### `GET /pool/points?account=kuku-0` — 账号剩余积分

上游接口 `/bizapi/gfpro/getgfvipremain`，**只要 cookie，不需要任何签名参数**，零积分。实测完整响应（本机真号）：

```json
{
  "checked_at": "2026-10-04T12:30:32.219Z",
  "total_balance_points": 2567.22,
  "accounts": [
    {
      "id": "kuku-0", "alias": "主号", "ok": true, "code": null, "message": "",
      "is_vip": false, "vip_type": 0, "vip_end_time": null, "is_trial": false,
      "assets": [
        { "asset_type": 1, "asset_name": "token",          "total_point": 2567.22, "bonus_point": 2567.22, "vip_point": 0, "charge_point": 0, "freeze_point": 0 },
        { "asset_type": 2, "asset_name": "duration",        "total_point": 7200,   "bonus_point": 0, "vip_point": 0, "charge_point": 0, "freeze_point": 0 },
        { "asset_type": 3, "asset_name": "scheduled_task",  "total_point": 2,      "bonus_point": 0, "vip_point": 0, "charge_point": 0, "freeze_point": 0 },
        { "asset_type": 4, "asset_name": "realtime_t",      "total_point": 0,      "bonus_point": 0, "vip_point": 0, "charge_point": 0, "freeze_point": 0 }
      ],
      "balance_points": 2567.22,
      "duration_points": 7200,
      "scheduled_task_points": 2
    }
  ]
}
```

四个桶是**四种不同单位的配额，绝不能相加**：

| `asset_type` | `asset_name` | 含义 | 与本项目关系 |
|---|---|---|---|
| 1 | `token` | 积分，**小数精度** | **推理就扣这一个**。`consume_points` 扣的就是它 |
| 2 | `duration` | 时长配额（整数，像分钟） | 语音/实时类用途，不是钱 |
| 3 | `scheduled_task` | 定时任务个数 | 客户端的定时任务额度 |
| 4 | `realtime_t` | 实时类配额 | 本反代用不到 |

- `balance_points` = **只取 `token` 桶**；`total_balance_points` = 全池各号 `token` 桶之和。**后端不会把四个桶加起来**，前端也不要自己加
- 上游把这些数字当**字符串**下发（`"2567.39"`），后端已 `Number()` 归一；`token` 有小数，**展示时别 `Math.round`**
- 依据（可交叉验证）：跑一次真上游验收后，`token` 桶从 `2567.39` 掉到 `2567.22`，差额与该几轮 `consume_points` 之和一致 —— 说明 `token` 桶就是账本
- 登录态死的号：`ok:false` + `code:200001`（`user not login`），并把该号标成 `auth_dead` 上长冷却。**注意这一族的 not-login 码是 `200001`，`/wenchain/*` 探针那族是 `1000004`**，后端两个都认
- 网络不通时 `ok:false` + `unreachable:true`，**不**标 auth_dead（抖动不定罪）
- **这是真上游调用**：零积分但占一次 RTT，别放进每次推理的路径。建议"进入控制台拉一次 + 手动刷新按钮"，多号时串行返回（本接口就是串行）
- **拿不到消费流水**：客户端积分详情页 `/browse/pointdetail` 是个网页收银台（HTML），不是 API；历史消耗只能靠前端自己累加每轮 `consume_points`

### `GET /pool/sessions?offset=0&size=20` — 上游会话列表（含客户端里建的）

上游接口 `/api/genflowpro/workspace/getsessionlist`（POST），同样**只要 cookie、零签名、零积分**。实测（真号，示例里把标题换成了假值）：

```json
{
  "checked_at": "2026-10-04T12:55:00.000Z",
  "accounts": [
    {
      "id": "kuku-0", "alias": "主号", "ok": true, "code": null, "message": "",
      "offset": 0, "size": 2, "total": 98,
      "sessions": [
        { "session_id": "4bf676e6…（40 位）", "title": "你好", "status": 3, "session_type": 1,
          "is_read": false, "ctime": 1791116830, "mtime": 1791116839, "artifact_count": 1,
          "created_by_this_pool": true },
        { "session_id": "abcedd12…（40 位）", "title": "帮我写个脚本", "status": 3, "session_type": 1,
          "is_read": false, "ctime": 1791116700, "mtime": 1791116760, "artifact_count": 2,
          "created_by_this_pool": false }
      ]
    }
  ]
}
```

字段语义（全部来自实测，不是推测）：

| 字段 | 实测情况 | 前端怎么用 |
|---|---|---|
| `session_id` | **40 位字符串** | 与响应里的 `kuku.session_id` 同源，可直接比对 |
| `title` | 客户端自动起的会话名 | 列表主标题 |
| `total` | 全量条数，**会随使用增长** | 分页用 |
| `status` | 83 条里 82 条是 `3`、1 条是 `1`；**含义未确认** | 原样存着，**别拿它做分支** |
| `session_type` | 全是 `1`；客户端枚举是 `CHAT:1 / AUTOMATION:2` | 只想列对话就取 1 |
| `is_read` | 上游 0/1，后端转成 `boolean` | 未读点 |
| `artifact_count` | 由 `download_list` 折叠成个数 | 上游原始 `download_list` 是 `{data_url, message_id}`，**`data_url` 是会过期的链接，后端故意不往下传** |
| `created_by_this_pool` | 后端自己算的 | **见下面那条，最重要的一个字段** |

- **`created_by_this_pool` 决定能不能续接**：`true` = 本反代建的会话（进程内会话表或 `responses.json` 里认得），可以继续用 `x-kuku-session` / `previous_response_id`；`false` = 客户端 App 里建的，**这里只能"看到"，接不上** —— 我们的 `sendmsg` 每次都通过 `idallochstr` 自己分配 `session_id`，没有"接管一个已存在会话"的路径。UI 应该把 `false` 的项显示成只读，别让用户点了没反应
- 已交叉验证：本反代 ledger 里 7 个 `session_id` 有 3 个落在前 50 条内，且这 3 个都被正确标成 `true`
- **副作用**：每轮推理都会在上游建一个可见会话，`total` 会一直涨（实测同一号 83 → 88 → 98，就是几轮验收跑出来的）。"我的库库AI 客户端里怎么多了一堆会话"——是本反代建的，不是 bug。客户端同族还有 `deletesession` / `updatesession` / `readsession` / `getsessiondetail`（本反代未接，要做清理功能可以接，估计同样免签）
- `size` 后端钳在 1–50（上游默认 20），`offset` 最小 0
- 这一族的成功判据是 **`errno === 0`**（响应里没有 `status` 块），死号是 **`errno:-6` + `show_msg:"未登录"`**。后端已按家族分别判信封；`-6/-7/-8` 都算登录态失效
- 和 `GET /v1/responses` 别混：那条列**本反代的 response ledger**（有 `output_text`/`usage`/`kuku`，能续接），这条列**上游账号里的全部会话**（含客户端建的，只有标题和时间）。历史列表 UI 可以并排用，但语义不同

### 重启不再失忆（`sessions.json`）

这不是假设，是**实测到的缺陷**：原来只在内存里存 `会话键 → 上游 session_id`，进程一重启就归零，而后端**仍然返回 200**、只是悄悄换了一个新的上游 `session_id`。实测那次：种入"我的水果是 PurpleOtter"→ 重启 → 用同一个 `previous_response_id` 追问"我的水果是什么"，模型答了"Tangerine"（即上一个测试会话的内容），**接口没有任何报错**。对前端就是"多轮记忆莫名其妙串了/忘了"。

现在这份映射落盘到 `sessions.json`，行为变成：

| 场景 | 现在 |
|---|---|
| `previous_response_id` 跨重启续接 | 续到**同一个**上游 `session_id`，记忆还在 |
| `x-kuku-session`（自定义会话键）跨重启 | 同上，同一键恒映射到同一上游会话 |
| `/pool/state` 的 `sessions` | 重启后从盘上读回，不再清零 |
| `/pool/sessions` 的 `created_by_this_pool:true` | 走 `/v1/chat/completions` + `x-kuku-session` 建的会话，重启后**依然标 `true`**（以前重启就掉成 `false` 了——那些号不在 ledger 里，只能靠内存会话表认） |
| `ledger`（`responses.json`） | 本来就已落盘，不受影响 |

实测（真上游，走 HTTP 而不是内存对象）：种一轮存住 codeword → `taskkill` 整个进程 → 重新 `node src/server.mjs` → 带 `previous_response_id` 追问，返回同一 `session_id` 且答出正确 codeword。

- 写盘是**建会话时**触发的（一轮一次，500ms 去抖），不是每轮都写，所以不会有磁盘抖动
- 这个文件删掉不会坏掉服务，只是所有会话重新分配 id（表现为"记忆从头开始"）
- **别把它当成"多轮记忆的唯一保证"**：上游侧的会话也要还在。上游每轮都会新建一个会话、`total` 一直涨，会话本身没有清理接口（见 §11）

---

## 9. 号池管理（写操作，需 `ADMIN_TOKEN`）

全部在 `/pool/admin/*` 下，全部要求管理令牌，**普通 `API_KEYS` 也进不来**（实测响应体）：

```json
{ "error": { "message": "admin token required", "type": "authentication_error" } }
```

| 方法 + 路径 | 作用 | 说明 |
|---|---|---|
| `POST /pool/admin/accounts` | 加号 | body `{id, bduss, stoken, alias?, priority?, disabled?, device_id?}`；`id` 重复 → 409；成功 201 |
| `PATCH /pool/admin/accounts/:id` | 改号 | 可改 `alias` / `priority` / `disabled` / **`bduss` / `stoken`**；改完自动按 priority 重排 |
| `DELETE /pool/admin/accounts/:id` | 删号 | 返回 `{"ok":true,"accounts":[…],"gap":true}` |
| `POST /pool/admin/resequence` | 重排序号 | 按当前顺序压成 `0…N-1`，**专门用来补删号留下的洞** |
| `POST /pool/admin/reset-cooldown` | 清冷却 | body `{id?}`；不带 `id` 清全部；同时清 `auth_dead` |

**换凭据（`PATCH` 里传 `bduss` / `stoken`）** —— 号池里的号 cookie 死了不用再"删了重加"：

```
PATCH /pool/admin/accounts/kuku-0
{ "bduss": "<新的192字符>", "stoken": "<新的64字符>" }
→ 200 {"ok":true,"account":{…}}   # 注意 PATCH 回的是单个 account，其它写操作回的是 accounts 数组
```

- 两个字段**可以只传一个**（另一半保持原值）。服务端拿到的值会先去掉空白与 `;` 再校验
- **空字符串 → 400 `bduss/stoken must be non-empty`，且这次 PATCH 什么都不会改**。这点是刻意设计的：如果先赋值再校验，一个只带 `bduss:""` 的请求会把本来还能用的号直接弄瞎——实测过这个坑，已改成"校验通过才整体生效"
- 换成功后**自动清 `auth_dead` 和冷却**（`cooldown_until=0`），下一次 `pick` 就会再用到这个号，不需要额外调 `/pool/admin/reset-cooldown`
- 响应体里**永不回显新凭据**，只回 `has_credential: true`
- 后端**不会**主动去上游验证新凭据是否真的能用。要确认，换完自己发一次 `GET /pool/health?account=<id>`（零积分）——这是"换完立刻体检"最便宜的做法
- 凭据只走内存替换，`accounts.json` 里的旧值会被这次 PATCH 的新值覆盖落盘

约定：
- 所有写操作**立即落盘**并返回最新的 `accounts` 数组（形状同 `/pool/state`），前端可以直接用它刷列表，不必再 GET 一次
- 加号是"明文提交凭据"，UI 要有：粘贴后立即清空输入框、不回显、不写 localStorage
- 删号返回 `gap: true`，UI 应该在删完后提示"要不要顺手重排序号"，而不是自动调 `/resequence`（自动改会破坏用户对序号的心智）

实测样例（本机，加了一个假号）：

```
POST /pool/admin/accounts  → HTTP 201，accounts 长度 3
POST 同 id                 → HTTP 409
PATCH a2 {priority:0}      → 200，account.priority=0
DELETE a0                  → 200，gap=true
POST /pool/admin/resequence→ 200，priorities=[0,1]
```

---

## 10. 状态码语义（前端分支就照这个表写）

| HTTP | 含义 | 前端应该怎么表现 |
|---|---|---|
| 200 | 成功 | 正常渲染 |
| 400 | 你的请求不合法：`error.code` 可能是 `model_not_found`（模型名不在 `/v1/models` 里）或 **`cursor_not_found`**（`GET /v1/responses` 的 `after` 游标已被淘汰/不存在），也可能是 `PATCH` 换了个空凭据或上游参数校验失败 | 表单校验提示；模型名报错就把下拉框指回 `/v1/models`；**`cursor_not_found` 表示分页起点已被 FIFO 挤掉，直接从第一页重新拉**，别去匹配 message 字符串（**这种失败不会让任何号进冷却**，所以不要显示"账号被惩罚"） |
| 401 | key 不对 / 管理端缺令牌 | 跳登录或提示配置 |
| 404 | 路径不存在；`x-kuku-account` 指定的号不存在；`previous_response_id` 或 `GET /v1/responses/:id` 里的 id 不存在 | 分别提示"号不存在"/"会话已失效，请重新开始" |
| 409 | 号池没有可用号，或指定的号被停用/冷却/登录态死 | 提示"该号当前不可用"，并给"查看号池状态"入口 |
| **402** | **整池都没积分**：`error.code:"insufficient_balance"`，message 是上游原话（`积分不足，无法继续任务。`）。单号没积分时**不会**走到这里 —— 网关会自动换号，只有全部号都空了才报 | 提示"所有账号积分耗尽"，给"查看余额"入口；**不要**当成模型故障重试 |
| 502 | 上游网络不通 | 提示"链路不通，可重试"，**不要**显示成账号坏了 |
| 500 | 其它 | 展示 `error.message`（已脱敏） |

---

## 11. 已知限制 / 后端待补（前端排期请看这里）

**本轮加固（2026-10-05，前端要按新行为写）**：

| 变更 | 之前 | 现在 |
|---|---|---|
| 流式遇到号池失败 | 一进来就写 200 头，失败只能压成空 `[DONE]` | **首个 delta 才写头**；没发出任何内容前失败 → 正常换号，全池空则回 **402 JSON**；内容已发出后失败 → 流里带一条 `{"error":{message,code}}` 帧再 `[DONE]` |
| `x-kuku-allow-unavailable: 1` | 任何 api key 都能用它打停用/冷却中的号 | **必须同时带 `ADMIN_TOKEN`**，普通 key 带它无效（仍 409） |
| 扫码取图 | passport 偶发回 `200 + 0 字节`，UI 一片空白 | 后端自动重试 3 次（250/500ms 退避）；仍空则 **502 明说**，不再给空图 |
| 登录失败后继续轮询 | 每次轮询都重跑 `bdusslogin` + 换 STOKEN | 失败态**粘住**：同一 `login_id` 后续轮询原样重放失败，不再重复打 passport |
| `GET /pool/points` 判死号 | 上游回 `status.code:0` 但资产列表缺失时也算"0 分" → 号被踢出轮换 | 只有**真的读到 `token` 桶**才判；列表缺失视为未知，号留在轮换 |
| 加/删/改一个号 | 重建号池会**洗掉所有号**的冷却、`auth_dead`、`balance_dead` | 按 id 保留运行时状态 |
| 全池都因积分被排除 | 第二次请求退化成 `409 no available account` | 稳定回 **402 + `insufficient_balance`** |
| passport 异常 | 两条短信路由无兜底，未处理 rejection 会**带走进程** | 整个 handler 有兜底：网络类 → 502，其它 → 500，并且绝不崩 |


**已补齐**（原先在这里，现已实现并有回归覆盖）：

- ~~并发串号~~ → 同一会话键的请求已在后端串行化（`pool.serialize`）
- ~~响应无法回查~~ → `GET /v1/responses/:id` + `DELETE`，ledger 落盘、跨重启可用
- ~~CORS 缺失~~ → 预检与响应头都已放开，`CORS_ORIGIN` 可收紧
- ~~没有对话列表接口~~ → `GET /v1/responses?limit=&after=&session_key=`，游标信封与 SDK 的 `CursorPage` 一致（`data/first_id/last_id/has_more`）
- ~~模型名打错会连累账号~~ → 现在在路由层就 400 `model_not_found`。这轮实测到的真实后果是：错误的 `model_name` 打到上游 → 上游回 ERROR 帧 → 后端把它当"确定性上游失败"给该号上冷却（实测 ~5 分钟），也就是**任何一个前端的拼写错误都能把共享账号锁掉几分钟**，还白烧一轮
- ~~`/v1/models` 没有展示名~~ → 每个模型带 `display_name`（上游 `model/list` 本来就有，之前被我丢掉了）。`default_model_id` 换成了可用的 `default_model`（内部数字 id `"1"` 已解析成 `auto`）
- ~~余额读不到~~ → **`GET /pool/points` 已能查真实剩余积分**（见 §8）。原先"需要 native 签名"的结论是**错的**：我当时探的是猜出来的 `/api/quota`，而客户端真正用的是 `/bizapi/gfpro/getgfvipremain`，纯 cookie 零参数就能拿到 `status.code:0` 与四个资产桶。上游其实有三条接口家族（`/wenchain/*` 不校验签名、`/api/genflowpro/*` 不校验、`/bizapi/gfpro/*` 不校验），签名参数 `rand/rand2/time/logid/devuid` 在这三族上**都不需要**
- ~~没有上游会话列表~~ → `GET /pool/sessions` 已接（`/api/genflowpro/workspace/getsessionlist`，实测免签、零积分、`{offset,size}` 生效，能列出客户端里建的会话）
- 顺带修了一个信封判定的坑：上游有**两种成功信封**（`/wenchain/*` 与 `/bizapi/*` 用 `status.code`，`/api/genflowpro/*` 用 `errno` 且没有 `status` 块）。原先只认前者，会把后者的**成功响应判成失败**——"这些接口需要签名"那个错结论就是这么来的。现在按家族分别判，`errno:-6/-7/-8` 也归入登录态失效
- 另修一个静默 bug：`JSON.stringify` 会把值为 `undefined` 的键整个丢掉，所以进程启动时目录拉取失败会让请求里**根本没有 `model_name` 这个键**。实测（直连上游、故意省略该字段）：上游不报错，而是自己换成 `gateway-deepseek-v4.1-flash-tencent` —— 连它目录里声明的默认模型（`default_model_id` 指向 `auto`）都不是。前端会看到"我指定 A 却回答了 B"，全链路 200 且零报错。现在未命中的 id 会现场重拉目录（60 秒节流，避免每个坏请求一次 RTT），目录端点本身不可达时放行
- **重启失忆**（原先埋在最深处的一条）：会话映射只在内存里，进程重启后 `previous_response_id` 依然回 **200**，却悄悄换了一个新的上游 `session_id` —— 不报错、不冷却、只是"记忆换了个人"。现已落盘 `sessions.json`，并做了真进程重启 + 真上游的验收（见 §8 末尾）
- **死号换凭据不用删了重加**：`PATCH /pool/admin/accounts/:id` 现在接受 `bduss` / `stoken`，成功后自动清 `auth_dead` 与冷却（见 §9）。以前只能 `DELETE` + `POST`，代价是 priority 留洞、账号 id 变、`x-kuku-session` 里拼的键也跟着变
- **坏游标有了结构化错误码**：`GET /v1/responses` 的 `after` 认不出来 → 400 + `error.code:"cursor_not_found"`，前端不必再匹配 message 字符串
- **`/v1/models` 冷启动并发合并**：N 个并发只打一次上游目录（见 §4）

### 外部评审里我没有照改的三条（附判定依据，别重复提）

这份文档收到过一轮外部代码评审，六条建议里四条成立已修（上面四条）。剩下三条我核过没改，理由是：

1. **"CORS 的 `allow-methods` 漏了 `PUT`"** —— 不成立。全仓 `grep` 下来**没有任何一条 `PUT` 路由**（管理端全是 `POST`/`PATCH`/`DELETE`），预检里加 `PUT` 只是把没用的方法放开。真要做 `PUT` 接口时再一起加，改动量是一行。
2. **"`DELETE /pool/admin/accounts/:id` 建议支持 `?auto_resequence=true`"** —— 故意不做。删号留洞是本设计的**特性不是缺陷**：priority 是管理员手工排的稳定心智，删一个就自动把后面的号全压上前移，会让"3 号是我留给备用的"这种约定一夜失效。所以删号只回 `gap:true`，重排必须显式调 `/pool/admin/resequence`（多一次往返换的是可预期）。
3. **"把 session 状态持久化到 SQLite/Redis 以支撑多进程集群"** —— 超出本项目边界。持久化本身做了（`sessions.json`，这也是它该做的部分），但多 worker 共享状态不是这个反代的目标形态：它只绑 `127.0.0.1`、单进程、靠一个真号跑。真要上多进程，先决问题是上游账号的风控与并发语义，不是我们的存储选型。

**仍然存在**：

1. **上游会话列表能看不能接**。`GET /pool/sessions` 已能列出账号里全部会话（含客户端建的），但 `created_by_this_pool:false` 的那些**无法续接**——本反代的 `sendmsg` 每次都自己分配 `session_id`，没有"接管已存在会话"的路径。要能接着聊，得再加一条"以指定 session_id 发下一轮"的能力（未做）。
2. **`x-kuku-account` 响应头是"首发账号"**，流式中途切号后不会更新。要精确知道最终哪个号服务的：Chat Completions 看 `kuku.account`（非流式）或加 `kuku_meta: true`；Responses 看 `kuku.account`（流式末帧 `response.completed` 里就有）。
3. **上云注意**：本机反代让 socket 恒为 `127.0.0.1`，若以后套 nginx，任何"只允许本机"的来源判断都会形同虚设，管理端必须纯靠 `ADMIN_TOKEN`；同时 `trustProxy` / `X-Forwarded-For` 要一起想清楚。
4. **SSE 断点续传没透传**。上游支持按 `msg_id` 续读，目前只在单轮内部用，没对前端暴露 resume 接口。
5. **没有消费流水**。`/pool/points` 给的是**当前余额快照**，不是账本；上游那个积分详情页 `/browse/pointdetail` 是网页收银台（HTML），没有对应 API。累计消耗要么前端自己累加每轮 `consume_points`，要么我给 ledger 加一个跨重启的汇总账本。（`/pool/state` 的 `sessions` 已不再是进程内的了，见 §8 末尾。）
6. **Anthropic Messages 未实现**（按你的决定跳过）。
7. **`/v1/models` 在目录拉不到时回 `200 {"object":"list","data":[]}`**，和"上游真的没有模型"分不开。前端如果拿空列表要先看 `/healthz` 与 `/pool/state` 再决定提示"目录暂不可达"。我暂时没把它改成 503，怕打断你已有的读取逻辑——要改说一声。
8. **`sessions.json` 只增不减**：每个新会话键一条，永不过期、永不压缩（ledger 有 `LEDGER_MAX` FIFO，它没有）。单人自用一年也就是几千条、几十 KB，暂时没做淘汰；但它确实是**无上限**的，前端不用管，运维上别把它当"可以随便 `rm` 也不影响"的文件——删了就等于所有旧会话重新分配上游 id。另外落盘是 **500ms 去抖**的，建会话后立刻 `taskkill` 有极小概率丢那一条。
9. **单进程假设**。`sessions.json` / `responses.json` / `accounts.json` 都是"最后一个写的人赢"，没有文件锁，也没有跨进程合并。同时起两个 `node src/server.mjs` 会互相覆盖状态（这条本来就在"上云暂缓"的范围内，写在这里免得以后有人踩）。

---

## 12. 联调建议

- 你现在是前后端同一人、且直接用真号联调，这条路是通的。两点提醒：
  - **真号联调前先看 `/pool/health`**，登录态死了要先补号，否则前端会一直收到 409，容易误判成前端 bug
  - **别把 `consume_points` 丢掉**。它是唯一可信的成本口径，联调阶段就能顺手把记账 UI 做出来，比事后补便宜
- 需要离线开发时用自桩：`KUKU_BASE_URL=http://127.0.0.1:<桩端口> node src/server.mjs`（桩在 `test/offline.mjs` 里，复刻了实测契约）。要我固化成 `npm run dev:stub` 就说一声。
- **别在 Git Bash 里用 `-d '{"content":"中文"}'` 测**：这台机器 argv 走 GBK，中文会变成乱码发出去（实测会误导你以为是后端的编码 bug）。用 `--data-binary @utf8文件`。
- 回归命令：
  - `npm test` → 离线 **150 项**，零凭据零积分（含"确实在打桩而不是打了真上游"的守卫断言）
  - `npm run accept` → 真上游 **15 项**（含 Responses 契约与流式序列、跨 id 多轮记忆、真实余额、上游会话列表与死号拒绝），花约 1.5 积分
  - 两套结论不要混用，也不要合并进同一个门禁
- **重启续接这一条，离线桩证不了全部**：桩只会原样回显，测的是"映射有没有被重新加载"。要证"记忆真的还在"，只能走真 HTTP + 真进程重启：种一轮记住一个 codeword → `taskkill` 监听 8787 的 node → 重新起 → 带 `previous_response_id` 追问（本轮实测代价 0.97 + 0.22 积分，答复正确、`kuku.session_id` 前后一致）。这条**没有**进 `npm run accept`（它需要杀进程，不该混进一次跑完的验收），要复现照上面三步手工来。

---

## 13. 后端代码地图

```
src/upstream.mjs  288  上游 HTTP 客户端 + SSE 解析（两种成功信封的判定在这里）
src/gateway.mjs   567  事件→delta 映射、号池调度、体检、余额、免费积分领取、会话列表、串行化、模型目录索引
src/responses.mjs 196  Responses API 契约：输入归一、Response 对象、流式事件机、思考档位换算
src/ledger.mjs    56  previous_response_id → 上游 session 的持久映射
src/store.mjs     101  accounts / sessions / keys / settings 原子写 + 备份 + 密钥环
src/passport.mjs  409  百度 passport 客户端：签名换 STOKEN / 登录二维码 / 短信验证码
src/logins.mjs    189  登录加号状态机（扫码与短信会话、验证码、失败态、入池前验证）
src/scheduler.mjs 114  每日免费积分定时领取（默认关闭、一天一次、状态落 settings.json）
src/server.mjs    806  路由、鉴权、CORS、管理端写操作、登录与积分路由、两套 API 编排、进程级兜底
test/offline.mjs  2002  自桩（含 passport 桩）+ 137 项回归
test/live.mjs     249  真上游验收脚本
合计              4977  行
```

改上游交互时，先跑 `npm run accept` 确认契约没变，再动 `offline.mjs` 里的桩（桩必须跟着实测契约走，不许比真的更宽容）。改 Responses 输出格式时，以 `analysis/openai-spec/` 里那份 SDK 类型定义为准，别照记忆改字段名。

---

## 14. 登录加号（扫码 / 手机号验证码）

这一节是**新增能力**：不用再去浏览器里手工抠 cookie 就能往号池里加号。全部逻辑在 `src/passport.mjs` + `src/logins.mjs`，全部走 `ADMIN_TOKEN`。

### 先说三条硬结论（实测 + 反编译，不是猜测）

| 你要的 | 结论 | 依据 |
|---|---|---|
| **微信扫码登录** | ❌ **这个产品没有这条路**。登录框 `loginType` 只有 `password / sms / qrcode`，而 `qrcode` 是**百度App扫码**；`weixin` 只是"绑定/快捷登录"按钮（authsite），要**先有百度登录态**才能用 | 库库登录页配置 `qrcodeLogin:0, userPwdLogin:0, sms:5`；`authsiteLogin: ['tsina','qzone','weixin','dingtalk']`（`act:'implicit'`）|
| **QQ 扫码登录** | ❌ **不存在**。整条链路里 `connect.qq.com / graph.qq.com / QTangram` **0 命中**，`qzone:'QQ账号'` 只是一个 UI 标签 | 同上 |
| **手机号验证码登录** | ✅ **这正是库库官方登录页唯一开着的入口**（`sms:5` + `userPwdLogin:0`）。已实现，见下面 §14.3 | 登录页 bundle 的 widget 配置 |

所以本项目的"扫码"= **百度App 扫码**（不是微信）。前端文案要照这个写，别写"微信扫码"，否则用户拿微信扫会扫不出任何东西。

### 14.1 路由总表

| 方法 + 路径 | 作用 | 请求 | 响应 |
|---|---|---|---|
| `POST /pool/admin/login/qr` | 生成登录二维码 | `{alias?, priority?}` | `{login_id, image_path, poll_path, prompt, expires_in_ms, scanned_by}` |
| `GET /pool/admin/login/qr/:id.png` | 取二维码图片 | — | `image/png`（服务端带自己的设备 cookie 去上游取图） |
| `GET /pool/admin/login/qr/:id` | 轮询一次状态 | — | `{state, ...}`，`state ∈ pending / scanned / confirmed / added / expired / failed` |
| `POST /pool/admin/login/sms` | 发验证码 | `{phone, alias?, priority?, captcha?}` | `{state: sent / captcha_required / refused / unregistered, login_id, captcha_path?, message}` |
| `GET /pool/admin/login/sms/captcha/:id` | 取图形验证码图片 | — | `image/*`（**必须走我们**：验证码绑定的是本进程的设备 cookie，前端自己去加载必然对不上） |
| `POST /pool/admin/login/sms/resend` | 填完图形码后重发 | `{login_id, captcha:{vcodestr, vcodesign, code}}` | 同 `sent / captcha_required` |
| `POST /pool/admin/login/sms/verify` | 提交短信验证码 | `{login_id, code}` | `{state: added / captcha_required / refused / failed, account_id?, message?}` |

全部要求 `ADMIN_TOKEN`，`x-api-key` 进不来。**任何一条响应都不会回显 BDUSS / PTOKEN / STOKEN**（有回归测试盯着这条）。

⚠️ **两张图（`.png` 与 `captcha/:id`）也在 `ADMIN_TOKEN` 后面**，而 `<img src>` 发不出 `x-admin-token` 头，直接写死必然 401。前端正确做法：用 `fetch()` 带管理头取成 `Blob`，再 `URL.createObjectURL()` 喂给 `<img>`，组件卸载时 `revokeObjectURL`。`image_path` / `captcha_path` 是相对路径，拼到 `base` 上用。

### 14.2 状态机（前端照这个画就行）

```
POST /login/qr            → pending      （二维码已生成，5 分钟内有效，本项目钳到 4 分钟）
GET  /login/qr/:id  轮询   → scanned      （手机已扫、还没点确认，文案给"请在手机上确认"）
                         → confirmed     （内部态，紧接着会自动换票并入池）
                         → added         ★ 成功，带 account_id，直接刷号池列表
                         → expired       （二维码过期，提示"点击刷新"并重新 POST 一次）
                         → failed        （带 reason，例如 STOKEN 换取被拒）
```
轮询建议 **2 秒一次**，`GET` 是幂等的：同一个 `login_id` 重复轮询不会重复加号，已经 `added` 的会话再问还是 `added`。服务端内部还做了"同一会话并发轮询合并成一次上游调用"。

`added` 之后号池里那个号立即可用 —— 因为在入池前服务端已经拿新 `(BDUSS, STOKEN)` 真打了一次上游登录探针（零积分），**验不过就不入池**，所以前端不用再加"这个号能不能用"的判断。

### 14.3 实测边界（2026-10-05 已真扫验收，扫码全链路 ✅）

| 环节 | 状态 |
|---|---|
| `passport /v2/api/getqrcode?lp=pc` 出码 + 图片可取 | ✅ 真上游实测（201，PNG 874–896B，`prompt:"登录后威马将获得百度账号的公开信息…"`） |
| `/channel/unicast?channel_id=<sign>` 轮询 | ✅ 实测：没人扫 `{"errno":1}` → `pending`；**手机已扫未确认 `channel_v.status:"1"` → `scanned`**；确认 `status:"0"` 且带 `v` → 进入换票 |
| 扫码后 `channel_v` 的字段 | ✅ **真扫实测**：字段就是 `status,v,u` 三个（`probe.unicast_fields` 回传）。**`v` 是 32 位票据，不是 BDUSS** |
| `?getapi` 取 token | ✅ 实测（两个坑已写进代码：必须带 `Referer`，必须已有 `BAIDUID`，否则 200 里塞的是错误句） |
| `bdusslogin` | ✅ **真扫实测**：成功时响应是 `{data, errInfo}`、**没有 errno 字段**；只有失败才带 errno（假票据回 `{"errno":-9999}`）。真 BDUSS(192) / PTOKEN(32) / STOKEN 由这一步 **Set-Cookie** 下发 |
| `/v3/login/api/auth` 换 STOKEN | ✅ **真扫实测通过**，账号已入池并成功服务真实推理。契约见 §14.7 |
| `senddpass` 发验证码 | ⚠️ 仅合同实测（未放号的 `10000000000` 回 `errno:1 "手机号格式错误"`，说明参数被接受）；**真下发/图形码分支仍待你用自己的号验一次** |
| `?login`（isdpass=1 短信完成登录） | ⚠️ 未实测（要真短信码） |

**扫码那条已经是完整可用链路**：出码 → 百度App 扫 → 手机确认 → 换 STOKEN → 真打一次库库登录探针 → 入池。2026-10-05 07:46 用真号验收，`{"state":"added","account_id":"kuku-1","login_type":"qr"}`，随后该号真实服务了一次推理（扣 0.01 分）。剩下两个 ⚠️ 只影响短信登录。

### 14.4 兜底：粘 cookie 也能加号（而且现在只要两个值）

`POST /pool/admin/accounts` 原来必须给 `bduss` + `stoken`，但 **STOKEN 是 httpOnly，DevTools 里根本看不到**。现在支持：

```json
{ "id": "kuku-1", "alias": "二号", "bduss": "<粘这个>", "ptoken": "<粘这个>" }
```
只给 `bduss + ptoken` 时后端自己去 `/v3/login/api/auth` 换 STOKEN，成功回 `minted_stoken: true`。`bduss+stoken` 的老写法照旧可用；`stoken` 与 `ptoken` **同时给会 400**（免得你以为换的其实没换）。PTOKEN 同样是 httpOnly，所以这条主要给"从客户端本地存储里导"的场景用，日常还是走 §14.2。

### 14.5 密钥管理（`/pool/admin/keys`）

`API_KEYS` 一直支持**多个**（逗号分隔）。现在多了运行时管理：

| 方法 + 路径 | 作用 |
|---|---|
| `GET /pool/admin/keys` | 列表。只回 `hint`（形如 `sk-kuku-6db…50e0`）、`label`、`created_at`、`from_env` |
| `POST /pool/admin/keys` | 发一个 `sk-kuku-<32hex>`，**`secret` 只在这一次响应里出现**，之后任何接口都拿不到 |
| `DELETE /pool/admin/keys/:id` | 吊销，下一个请求立即生效（不用重启） |

- 落盘在 `keys.json`（已 gitignore），重启不丢
- `API_KEYS` 里配的 key 标记 `from_env:true`，**删不掉**（返回 400），防止管理令牌泄露时被人一把清空运维自己的配置
- ⚠️ 语义要说清楚：**一个 key 都没有时 `/v1/*` 是不鉴权的**（本机自用模式）。所以吊销最后一个 key 会让 API 变成裸的 —— 响应里带 `api_now_unauthenticated: true`，`/pool/state` 里也常年带着 `api_open` / `api_key_count` 两个字段，**UI 必须在 `api_open:true` 时显示醒目提示**。`/pool/admin/*` 不受影响，它只认 `ADMIN_TOKEN`

### 14.6 思考强度（think_mode）到底传没传过去

顺带把这轮的实测结论写在这，前端下拉框照这个做：

| 入口 | 能传什么 | 现在会不会被校验 |
|---|---|---|
| `POST /v1/chat/completions` | `think_mode: 1\|2\|3\|4` | ✅ 不在 `think_list` 里 → **400 `invalid_think_mode`**，且**不会**打到上游 |
| `POST /v1/responses` | `reasoning: {effort}`（标准）**或扁平** `reasoning_effort`（很多客户端只发这个），也接受 `think_mode` | ✅ 同上；`think_mode` 优先于 `reasoning.effort` |

实测（真上游，`gateway-glm-5.3-flash`）：

- 上游请求确实携带 `think_mode`，且返回 `THINKING_BLOCK_DELTA` 是**真事件名**（抓到过 49 / 21 / 9 个 delta），思考内容确实落在 `delta.reasoning_content`（Chat）与 `response.reasoning_summary_text.delta`（Responses），`usage.output_tokens_details.reasoning_tokens` 也确实上报
- **但上游对乱填的档号不报错**：`think_mode=99` 照样跑完照样扣分。这就是为什么要在前置校验 —— 否则前端的拼错只会表现为"模型变笨了"
- 档位**不是**成本保证：同一 prompt 下 `mode1` 出现过 180 reasoning tokens / 0.97 分，`mode4` 反而 69 tokens / 0.03 分。想省钱要靠选模型，不是靠调低档位
- 换算表 `minimal/low→1`、`medium→2`、`high→3`、`xhigh→4`，注意 **`high` 正好是上游的默认档 3**，想要"极高"必须显式给 `xhigh`

**验证范围**：此前仅 GLM 被逐档实测；2026-10-06 已追加 GLM-5.3-Flash 与 DeepSeek-V4.1-Flash 的低、中、高、极高四档对照，详见 §16。两者参数均正确传入、均返回真实思考，但单次样本不能确认严格递增的四级预算；其余 11 个目录模型仍未验证。

观察思考的直接证据是 `THINKING_BLOCK_DELTA` 映射到流式 Chat 的 `choices[].delta.reasoning_content`。当前 Chat 的 token 字段是 `usage.reasoning_tokens`；Responses 对应 `usage.output_tokens_details.reasoning_tokens` 或 `output[].type='reasoning'`。一轮包含多个 MODEL_CALL_END 时，现有 usage 只保留最后一个，不能用它推断全轮思考总量。

### 14.7 换 STOKEN 的真实契约（本轮最硬的坑，改代码前必读）

`POST https://passport.baidu.com/v3/login/api/auth` **不是** `bduss + ptoken` 两个字段。客户端由原生引擎
（`genflowengine.dll` 的 `genflow_engine_get_login_auth_param`）生成一个**七字段带 md5 签名**的 body：

```
签名原像： appid=1&bduss=<BDUSS>&ptoken=<PTOKEN>&return_type=1&tpl=genflowpro&tpl_list=genflowpro|netdisk&sign_key=<常量>
实际发出： appid=1&bduss=<BDUSS>&ptoken=<PTOKEN>&return_type=1&tpl=genflowpro&tpl_list=genflowpro|netdisk&sig=<md5(原像)>
```

- `sign_key` 是编译进 DLL 的常量 `34868b316de55815273b2616954b0286`（见 `src/passport.mjs` 的 `ENGINE_SIGN_KEY`）
- `tpl_list` 里的竖线**不转义**（原样 `genflowpro|netdisk`）
- 请求头用客户端 UA `genflow;1.6.5;PC;PC-Windows;10.0.26200;GenFlowPro`，cookie 带 `BAIDUID` + `gfprotpl=genflowpro`
- 成功响应：`{"code":0,"errno":0,"errmsg":"Auth Login Success","stoken_list":{"genflowpro":"<64hex>","netdisk":"…"}}`，**我们只取 `stoken_list.genflowpro`**

**验证方式（三重，不是推测）**：① 用 koffi 直接调真 DLL，合成输入 `A×192 / P×64` → `9cf3a33e3b6f19324853970abf2d00a2`；② 第二组 `X×192 / Y×64` → `a3d861ea0946b617a7235b6b36c65add`，公式复算一致；③ 拿抓包里那条**真实成功请求**解出它自己的 bduss/ptoken，用我们的 `loginAuthBody()` 复算 → 与真实 body **逐字节相同**。离线套件里 `loginAuthBody reproduces the engine-signed STOKEN exchange form` 这条测试钉死了前两组向量。

**两个必须记住的失败码**：

| 上游返回 | 真实含义 |
|---|---|
| `errno 4` + `unknow error(110003)` | **签名/字段缺失**（例如只发 `bduss+ptoken`）。不是"凭据无效" —— 真凭据配错 body 一样是这个码，别误判 |
| `errno 2` + `Auth Login Params Not Corret` | 字段齐了但**值不对**：最常见是把 32 位扫码票据当成 192 位 BDUSS 传了 |

以及 `bdusslogin` 的判据：**成功时响应里没有 `errno` 字段**（是 `{data, errInfo}`），只有失败才带 errno。
把"没有 errno"当失败会让每次真登录都静默走偏 —— 这个 bug 真实发生过。

### 14.8 积分不足的语义（新号尤其要看）

上游对**没积分的号**不是报错，而是在 SSE 里发两个商业帧然后直接结束：

```
COMMERCIAL_NOTICE  data:{reason:"insufficient_balance", text:"积分不足，无法继续任务。"}
COMMERCIAL         data:{errno:11002, reason:"insufficient_balance", uk:"…"}
TURN_DONE
```

一个 `TEXT_BLOCK_DELTA` 都没有。网关现在的处理：

- 抛成 `UpstreamError{code:11002, insufficient_balance:true}`，**标记该号 `balance_dead_until`（默认 10 分钟窗口）并自动换下一个号**
- 全池都空了才回 **402 + `error.code:"insufficient_balance"`**，message 是上游原话
- `/pool/state` 每个号多两个字段：`balance_dead`（布尔）与 `balance_retry_in_ms`
- **是窗口不是闩锁**：`GET /pool/points` 读到 `token` 桶 > 0 会立刻清标记，`POST /pool/admin/reset-cooldown` 也清

为什么必须是窗口 —— 实测时间线（2026-10-05，真号 `kuku-1`，刚扫码入池）：

| 时刻 | 观测 |
|---|---|
| 07:46 | 扫码入池成功 |
| 07:47 | `/pool/points` 四个桶**全 0**（连 `duration` 都是 0） |
| 07:49 | 真发一轮 → 上游回 `COMMERCIAL errno 11002`，确认当时真的不能消费 |
| 07:57 | 同一份凭据 `/pool/points` = **648.86**，真发一轮正常服务，扣 0.17 |

也就是说**新换出的 STOKEN 有一段 provision 窗口**，期间余额读 0、推理被 11002 拒，几分钟后自己就好。
如果把它当永久标记，每个新扫的号都会在第一次撞窗口时被踢出轮换，得人工 reset —— 所以是 10 分钟自动重试。
（注意：这**不是**"要去客户端领每日免费额度"，那个解释当时被证伪了 —— 那个号几分钟后自己就有 648 分了。
领额度确实有接口，但**不是** `taskComplete`：那只是上报进度。真实领取见 §14.9。）

### 14.9 免费积分：读取、领取、每日定时（本轮新增）

三个端点分工不一样：成功对话还需要显式上报 CHAT 进度，再领取奖励。`taskComplete` 返回成功或 `reward_point` 非零都不能证明积分到账，实际领取以 `rewardClaim.claimed_point` 与余额变化为准。

| 端点 | 作用 | 请求 | 响应 |
|---|---|---|---|
| `GET /api/genflowpro/freepoint/homenew` | 列任务 | 只需 cookie | `data.activities[].{activity_key,period_no}` → `tabs[].tasks[].{task_key,task_type,task_status,single_reward_point,claimable_point}` |
| `POST .../freepoint/taskComplete` | **上报**进度（LOGIN、成功对话后的 CHAT、邀请类） | form `task_type=CHAT&device_id=<18位数字>` | `{complete_status:"SUCCESS", reward_point:0或50}`；不作为到账证明 |
| `POST .../freepoint/rewardClaim` | **领取，这才是给分的** | form `activity_key=genflow_free_points&period_id=4&task_key=daily_chat` | `{claim_status:"SUCCESS", claimed_point:50}` |

判别口径只有一条：**`claimable_point > 0` 才是"现在能领"**。`task_status` 是 FINISHED/UNFINISHED 不代表能不能领（实测两个号的 `daily_login` 都是 FINISHED 且 claimable 0，而 `daily_chat` 是 UNFINISHED 却 claimable 50）。
`period_id` 原样取自 `period_no`；`device_id` 用号池里已有的数字 `default_device_id`（18 位，与聊天 body 里那个是同一个）。

**本网关的路由**（全部 `ADMIN_TOKEN`）：

| 方法 + 路径 | 作用 |
|---|---|
| `GET /pool/admin/claim?account=<id>` | 只读任务列表（不花积分、不写账号） |
| `POST /pool/admin/claim` | 领取当前可领的。body `{id?, chat?, model?, text?}`；`chat:true` 会**先花一轮最小推理**去挣 `daily_chat`，再领 —— **但上报/计数是否成功仍以上游为准**，见下方实测边界 |
| `GET /pool/admin/auto-claim` | 定时器状态 `{configured, enabled, hour, last_run_at, last_result, next_run_at, running}` |
| `POST /pool/admin/auto-claim` | 开关与小时 `{enabled, hour}`（hour 越界回落 9），落盘 `settings.json` |
| `POST /pool/admin/auto-claim/run` | 立刻跑一次每日任务（等价于定时器触发） |

`GET /pool/state` 也带 `auto_claim`，UI 直接读。

**默认必须关闭**：领取是对百度账号的写操作，`chat:true` 还会真花一轮推理，所以只能由管理员点按钮或显式打开定时器触发，绝不在后台默认跑。打开后每天到 `hour` 点开始执行一次；当日超过该小时而尚未执行时，会在下一次 tick 补跑（**自动触发同一天不会重复领**），跨重启从 `settings.json` 恢复；启动时也可用 `AUTO_CLAIM=1` 打开。没有 `settings.json` 时不存在该文件，重启即回到关闭状态。

真机验收（2026-10-05，`kuku-1`）：`POST /pool/admin/claim` → `claimed:[{task_key:"daily_chat", claimed_point:50, claim_status:"SUCCESS"}]`，余额 **648.68 → 698.68（正好 +50）**，再读该任务变 `FINISHED / claimable 0`。

**历史观测（2026-10-05，旧实现未上报 CHAT）**：此前将计数异常归因于客户端占用，2026-10-06 的补上报实验已推翻「关闭客户端是必要前提」的推断。保留当时的观测记录（`claimable` 指 `claimable_point`）：

| 号 / 条件 | 我们发的对话 | `daily_chat` 结果 |
|---|---|---|
| `kuku-1`（只有反代在用） | 07:57 一轮 | 08:13 读到已是 **`claimable 50`**，领到（真实延迟未知，那次只是 16 分钟后才去看） |
| `kuku-0`（桌面客户端登录着） | 08:57 / 09:23 / 10:40 / 10:41 四轮，均 `created_by_this_pool:true`，真实扣分 | 1h45m 后仍 **`UNFINISHED / claimable 0`** |
| `kuku-0`（**退出登录并关掉客户端**后） | 11:01:58 一轮 | **11:02:02 就 `claimable 50`（4 秒）** → 领到，余额 2610.24 → **2660.24（+50）**，状态转 `FINISHED` |

当时桌面客户端自己的「免费领积分」面板也显示"未完成、不可领"，这只能说明 API 和 UI 状态一致，不能排除网关缺少完成上报；见下方修正。

### 2026-10-06 修正：对话完成后缺少 CHAT 上报

官方客户端证据：`analysis/asar/out/renderer/assets/new-task-CImNAhDq.js` 在 `GenerateComplete` 后调用 `Fe('CHAT', userId)`；该函数来自 `runtime-C3nUDBY3.js` 的 `Qe`，最终调用 `taskComplete`，传 `task_type=CHAT` 和设备 ID。旧网关只发对话、读取任务列表，遗漏了这个上报。

真实验证（两个账号此前均已成功对话，但任务一直 `UNFINISHED / claimable 0`）：

| 账号 | 操作 | 真实结果 |
|---|---|---|
| kuku-1 | 为此前已完成的对话补上报 CHAT，再领取（未新增对话） | 上报 `SUCCESS / reward_point:50` → `claimable 50` → `rewardClaim SUCCESS / claimed_point:50`；余额 746.89 → 796.89 |
| kuku-0 | 修复后的 `claimFreePoints({runChat:true})` 完整流程 | 一轮对话消耗 0.05，`reported:['CHAT']`，领取 50，余额 2709.49 → 2759.44；任务 `FINISHED / claimable 0` |
| kuku-0 | 完整流程成功后重复调用 | `chat_turn:null / reported:[] / claimed:[] / points_earned:0`，没有再发送对话 |

当前流程：

1. 已有 `claimable_point > 0` 的任务直接领取；不为已经可领的登录奖励重复上报 LOGIN。
2. 只有显式 `chat:true` 且 CHAT 任务尚未 `FINISHED`、无可领积分时，才尝试一轮最低思考档对话。
3. 对话成功返回后，调用 `taskComplete(CHAT)`；`complete_status:SUCCESS` 才加入 `reported`，再读取任务并通过 `rewardClaim` 领取。
4. 对话失败不会上报 CHAT。上报返回未成功状态或读取后仍不可领时返回 `notes`，不再猜测客户端占用，不自动重复发对话。
5. 普通 Chat Completions / Responses 请求不会自动上报或领取。自动领取开关仍默认关闭。

费用不是固定 ~0.01 分：本日已观测到 0.05、0.50、0.51 分，应使用 `chat_turn.consume_points` 与余额核对。手动失败后的再次点击仍可能发送对话，调用方不要建立自动重试循环。

验证：离线 137 项通过（新增 CHAT 上报、已完成任务不扣分、重复执行、失败对话不误上报、拒绝上报提示、普通推理不写任务的覆盖）；真实上游验收 15 项通过；移除 CHAT 上报或已完成任务保护的变异版本都会使离线测试失败。

## 15. 后端可靠性修复（2026-10-06）

本轮不新增路由，不改前端。下面是既有 API 的行为修复和自动领取结果的兼容性字段扩展。

### 15.1 领取并发与部分成功

`POST /pool/admin/claim` 和 `POST /pool/admin/auto-claim/run` 共用同一个按账号串行的领取队列。后到请求必须在前一个完成后重新读取任务状态，避免同一账号并发读取到“未完成”，重复发送收费对话或领取同一奖励。这是单进程保证；跨进程仍不支持。

`accounts[].points_earned` 现在始终是数字，默认 0；每次 `rewardClaim.claim_status === 'SUCCESS'` 后即时累计。若后续任务失败，已成功领取的部分仍保留在 `claimed` 和 `points_earned`，顶层总积分包含这部分。

上游即使 HTTP 200 / errno 0，只要 `claim_status` 不是 `SUCCESS`，该账号也返回 `ok:false`，并在 `message` 写明失败状态；不能将其 `claimed_point` 计入到账。失败任务不加入 `claimed`。不新增错误码，业务码存在时仍走 `accounts[].code`。

例如先领到 LOGIN 50 分、再领取 CHAT 遇到业务码 123，HTTP 200 的响应结构为：

```json
{
  "ok": true,
  "points_earned": 50,
  "accounts": [{
    "id": "example-account",
    "ok": false,
    "points_earned": 50,
    "claimed": [{"task_key":"daily_login","task_type":"LOGIN","claimed_point":50,"claim_status":"SUCCESS"}],
    "code": 123,
    "message": "reward refused"
  }]
}
```

这是省略其他既有字段的示例。顶层 `ok:true` 表示请求已处理，各账号成功与否看 `accounts[].ok`；一个失败账号可以同时有已到账积分，不能把全部结果视为 0。

### 15.2 自动领取当天补跑与诊断

- `enabled` 仍默认关闭；不开启就不会自动上报、发对话或领积分。
- `hour` 使用服务所在机器的本地时间。指定小时到达或已过、且当天未自动执行时，在下一次 tick 执行一次（默认间隔 60 秒）。服务晚启动也会在当天补跑，不补以前日期。
- 当天已执行过则跳过自动 tick；`POST .../auto-claim/run` 是显式手动操作，仍可以主动执行。领取队列会重新检查已完成任务，完成的对话不再次消费。
- `next_run_at`：尚未到时间返回当天计划时间；当天已过点且未执行，返回当前时间表示等待下次 tick；当天已执行则返回次日计划时间；关闭时为 null。
- `last_result.accounts[]` 新增 `reported:string[]` 与 `notes:string[]`（均默认空数组），保存到 settings.json 后跨重启保留，避免自动任务显示“无新增积分”时丢失上游未计入等提示。

返回样例（节选）：

```json
{"last_result":{"accounts":[{"id":"example-account","ok":true,"points_earned":0,"reported":["CHAT"],"notes":["已完成对话，但上游尚未计入可领取积分"]}]}}
```

### 15.3 密钥文件与持久化失败

- `keys.json` 不存在且未设置 API_KEYS 时，保留既有的本机无鉴权模式；合法 `{"keys":[]}` 也允许该模式。
- 文件存在但 JSON 损坏、缺少 keys 数组或记录缺少非空字符串 id/key：服务拒绝启动，即使配置了环境密钥也不静默丢弃持久化密钥。错误只给文件名与恢复建议，不引用文件内密钥片段；原文件不会被自动改名或删除。
- 通过管理员 API 发放/吊销密钥时，必须先成功写盘才改变内存状态。保存失败仍返回既有 500 错误；未返回给调用方的新密钥不会被启用，吊销失败的旧密钥仍有效，吊销最后一个失败时也不会放开匿名访问。
- 不自动恢复 .bak，避免恢复已经吊销的旧密钥。由管理员核对备份后修复文件再启动。

### 15.4 账号 PATCH 的校验原子性

`PATCH /pool/admin/accounts/:id` 在改账号字段前校验完整请求。priority 不是有限数字或 BDUSS/STOKEN 为空时返回既有 HTTP 400，alias / priority / disabled / 凭据 / 冷却和登录状态都不改变；不会留下“返回失败但前半段已修改”的内存状态。

这保证参数校验失败的原子性；不承诺全部账号写操作在磁盘 I/O 失败时都有事务回滚。

### 15.5 验证与仍需改进的地方

离线回归：原有 137 项 + `test/backend-hardening.mjs` 的 13 项，共 150 项通过。后端可靠性测试用虚构账号和模拟方法，不联网、不发短信、不花积分；去掉领取串行、积分累计、补跑、密钥事务、坏文件保护或 PATCH 校验保护，相关回归会失败。

本轮经用户明确授权，直连真实上游、使用最低成本模型完成 15 项验收，全部通过；覆盖模型目录、鉴权、余额、会话列表、推理、多轮记忆以及 Responses 流式和非流式接口。新修复的并发、磁盘失败、损坏文件等故障场景由离线模拟测试验证，不对真实账号注入故障。

后续建议：上游请求统一超时与取消；账号身份去重；退出时及时落盘会话和响应映射；登录会话到期检查与清理；长期运行的服务托管。保持本机优先和单进程约束，短信登录仍需用户自己的真实手机号验收。

## 16. GLM / DeepSeek 思考档位真实检查（2026-10-06）

测试范围仅两个型号：`gateway-glm-5.3-flash` 与 `gateway-deepseek-v4.1-flash-volcengine`。各测试低（1）、中（2）、高（3）、极高（4），共八轮。使用同一道五人过桥题、同一账号、每轮独立会话，经过现有 `POST /v1/chat/completions` 路由，开启 stream / include_usage / kuku_meta。未修改后端 API 行为、未改前端。

### 16.1 实际观察

八轮均 HTTP 200、无错误，答案均给出最短时间 28 分钟。记录了 sendmsg 与 SSE 两次上游请求中白名单字段；每轮的 model_name 都与所选模型 ID 一致，think_mode 都是正确的数字档号，没有被网关覆盖为默认 3。

| 模型 | 档号 | 思考 delta 数 | 思考字符数 | MODEL_CALL_END 数 | API 最后调用 reasoning_tokens | 实际消耗积分 |
|---|---:|---:|---:|---:|---:|---:|
| DeepSeek-V4.1-Flash | 1 | 312 | 5204 | 3 | 102 | 0.27 |
| DeepSeek-V4.1-Flash | 2 | 445 | 7127 | 3 | 16 | 0.35 |
| DeepSeek-V4.1-Flash | 3 | 130 | 2145 | 3 | 19 | 0.15 |
| DeepSeek-V4.1-Flash | 4 | 267 | 4174 | 3 | 10 | 0.25 |
| GLM-5.3-Flash | 1 | 772 | 11603 | 3 | 15 | 0.51 |
| GLM-5.3-Flash | 2 | 783 | 12536 | 1 | 4708 | 0.39 |
| GLM-5.3-Flash | 3 | 611 | 10771 | 5 | 473 | 0.54 |
| GLM-5.3-Flash | 4 | 235 | 3787 | 3 | 13 | 0.24 |

总消耗 2.70 积分，余额 2759.06 → 2756.36。两者四档均返回真实 `THINKING_BLOCK_DELTA`，并映射为客户端可见的 `delta.reasoning_content`。因此可以确认它们确实执行了思考，档位参数也已到达上游；低档不代表关闭思考。

### 16.2 结论边界

**没有证据证明四档是固定 token 预算或严格递增的计算深度。**本题中两个模型的极高档思考文本都比低档短；这不等于参数失效，也不能据此宣称四档预算已经验证成功。题目、随机生成、上游多步调用和缓存都可能影响观测；每个组合只测了一轮，不能把时延、字符长度或积分当作档位生效的唯一判据。只有服务端确认的预算映射或更充分的对照，才能进一步验证档位间的计算量差异。

### 16.3 本次发现的统计限制（待修复）

当前 `Pool.chat` 每收到一个 MODEL_CALL_END 都覆盖 usage。本次一轮出现 1、3 或 5 个事件，因此表内 reasoning_tokens 是**最后一次调用**的数值，并非整轮总和；这解释了上万思考字符与十几个 token 同时出现的现象。需要结合调用标识与事件语义设计汇总，不能直接用当前数字比较四档深度，也不应未经核实直接将所有事件求和。

另：非流式 Chat 当前只返回最终正文，未将 turn.reasoning 放入 message.reasoning_content；这不证明模型没有思考。流式 Chat 和 Responses 的思考映射可用于检查，非流式字段补全属于后续 API 改动。

原始结果：`capture/think-depth-2026-10-06.json`（仅白名单指标与本次测试题答案，不含凭据或思考正文）。复现脚本：`test/think-depth-live.mjs`，不加入 npm test，只有明确授权时手动执行，会真实消耗积分。

## 17. 前端领取未到账：运行中的后端版本核查（2026-10-07）

`http://localhost:5173/users` 的领取代码将勾选状态作为 `chat` 传给 `POST /pool/admin/claim`，接口接收方式一致。此次 CHAT 未到账的原因是 8787 后端进程启动于 2026-10-06 00:57:04，早于 CHAT 完成上报修复，一直未重启；磁盘代码更新不会自动替换 Node 已加载的模块。

已重启后端加载现有修复，保留账号、10 个持久化会话、原管理配置及自动领取关闭状态；未修改前端或 API 契约。150 项离线回归通过。北京时间 2026-10-07 03:04，经运行中的本机接口对 `kuku-0` 执行一次 `chat:true` 验收：`reported:['CHAT']`、`rewardClaim SUCCESS / claimed_point:50`、对话消耗 0.01、余额 2805.85 → 2855.84，CHAT 状态为 `FINISHED / claimable_point:0`。结果保存在 `capture/claim-runtime-2026-10-07.json`。

另有前端提示局限：它没有展示每个账号的 `notes`，定时任务立即执行按钮仅检查顶层 `ok` 就显示“执行成功”；因此任务请求完成的提示不能代替每账号领取凭证。应核对 `claimed[].claim_status`、`points_earned`、`notes` 和刷新后的真实余额。本次遵循后端范围限制，不修改这部分前端展示。

## 18. 安装时初始化管理员令牌（2026-10-07）

> 本节记录第一版 JSON 实现；现行实现已改为 SQLite，详见 §19。生成规则、显式配置优先及仅显示一次的规则保持不变。

继续沿用既有管理员令牌鉴权，不新增账号密码登录或登录接口。`npm install` 的 `postinstall` 执行 `src/admin-token.mjs`；项目 `.npmrc` 设置 `foreground-scripts=true`，确保安装终端显示生成结果。`npm ci` 同样执行该钩子。若使用 `--ignore-scripts` 跳过安装脚本，首次 `npm start` 会补初始化。

令牌解析顺序：非空显式 `ADMIN_TOKEN` → 已保存的 `admin-token.json` → 创建新令牌。新令牌是 `kuku-admin-` 加 32 字节密码学随机数的 base64url 编码（256 位随机性），通过独占创建写入 `{ "token": "<secret>" }`。仅保存成功后在终端显示完整值一次，并提示用户立即保存、填入控制台系统设置。重复安装或启动不会重新生成或回显；显式环境值也不回显或写入该文件。空白环境值视为未设置。

`admin-token.json` 及其衍生文件已加入 `.gitignore`。文件使用 `0600` 创建模式（Windows 访问权限遵循目录 ACL）；文件存在却不可读、JSON 损坏或令牌结构不合法时拒绝初始化，保留原文件，不自动换令牌。可从已保存的原值/备份恢复；不要为了排障随意删掉文件。该文件是本机明文凭证，需与账号凭据文件一样妥善保管。

所有管理员请求仍使用 `Authorization: Bearer <token>` 或 `x-admin-token: <token>`，错误或缺失令牌仍返回 401，普通 API key 不能代替。`GET /pool/state` 的 `admin_enabled` 会反映初始化后的管理员配置，不返回令牌。`createApp` 作为嵌入接口仍需调用者传入 `adminToken`，不自动创建文件或打印凭证。普通 API 的 `API_KEYS` 空值规则保持不变。

**前端对接**：本轮不修改前端。用户须将终端显示的令牌填入「系统设置」管理员令牌字段；当前前端内置的演示默认值不能用于自动生成的令牌。已有部署若继续显式设置旧 `ADMIN_TOKEN`，会继续使用该值；移除该配置后重新启动才采用本机生成值，需同步更新前端填写的令牌。

新增 6 项离线回归覆盖：随机生成及提示、重启复用、显式配置优先、坏文件拒绝启动、保存失败不显示凭证、生成值授权成功且演示值被拒绝；全量离线回归共 156 项。不需要真实账号或收费对话。

隔离安装目录实测 `npm install --offline`：安装钩子成功显示完整令牌及保存提示，第二次安装令牌不变且不回显，删除隔离测试文件后直接执行初始化入口能够补生成。生成的测试令牌未输出到验收记录。三项变异检查（固定随机值、忽略显式配置、允许坏令牌结构）均被回归捕获。现有运行进程及其显式令牌本轮未切换，避免前端填写的值突然失效；下次安装/启动按以上顺序解析。

## 19. SQLite、token 统计、对话、日志和系统设置（2026-10-07，现行契约）

### 19.1 存储及升级

方案评估见 `docs/sqlite-plan.md`。生产入口 `npm start` 使用 Node 内置 SQLite，默认文件 `data/kukuai.sqlite`，支持 `DATABASE_FILE`。开启 WAL、foreign_keys、5 秒 busy_timeout，使用绑定参数及短事务；面向单实例。数据库、WAL/SHM 和备份都含私人数据，不可提交或公开。Windows 权限继承目录 ACL；文件以私有模式创建。当前 schema_version 为 1。

数据库表：`accounts`（上游凭据和账号元数据）、`api_keys`、`sessions`、`responses`、`settings`（系统设置、定时器、设备 ID、自动生成管理令牌）、`conversation_turns`、`usage_records`、`logs`、`metadata`。对话正文与累计用量分离。会话和对话即时提交，不再依赖 JSON 延迟写入；Responses 数量不再受 LEDGER_MAX 限制，列表改用 SQL 游标分页。

升级前停止旧后端，首次安装或启动事务导入根目录的 `accounts.json`、`keys.json`、`sessions.json`、`responses.json`、`settings.json`、`admin-token.json`（存在时），以及 `capture/server.log`、`capture/backend-current.log`、`capture/backend-current-error.log` 三份日志。指定旧日志单文件超过 4 MiB 时需先归档再迁移；导入日志会脱敏，时间采用文件修改时间，不代表逐行原始发生时间。任何输入无效都回滚整个导入。原文件完整保留；数据库的迁移标记提交后，旧 JSON 不再读写。数据库损坏、已版本化的表缺失或版本高于当前支持值时拒绝启动，不回退成空配置。

安装生成的管理员令牌现在直接存 SQLite，仅生成时打印一次；已有 `admin-token.json` 会迁入。非空显式 ADMIN_TOKEN 仍优先，环境令牌不自动另存，当前部署沿用原显式配置。所有原管理 API 仍要求正确令牌。普通 API 密钥全部为空时的本机匿名模式保持不变。

备份应停止服务后保存完整数据库，或通过 SQLite 的一致性快照（如 VACUUM INTO）制作在线备份；不能在运行中只复制主文件遗漏 WAL。恢复前先停止服务并保存当前数据库，再恢复指定快照。备份及旧 JSON 不会随在线删除/保留策略自动清理。

### 19.2 新接口总览

全部位于 `/pool/admin/*`，使用原 `x-admin-token` 或 `Authorization: Bearer <token>`；缺失/错误令牌及仅普通 API key 均 401。未注入 SQLite 的嵌入测试进程访问这些 API 返回 501。生产启动已配置 SQLite。

| 方法与路径 | 用途 |
|---|---|
| `GET /pool/admin/stats/tokens` | token、积分及上游尝试状态统计 |
| `GET /pool/admin/conversations` | 对话尝试列表，分页，无正文 |
| `GET /pool/admin/conversations/:id` | 单条记录详情，含请求消息、答复、思考及用量事件 |
| `GET /pool/admin/logs` | 请求、系统及导入日志分页 |
| `GET /pool/admin/settings` | 后端系统设置、定时器状态、存储类型 |
| `PATCH /pool/admin/settings` | 修改站点名称和保留策略 |

新接口不提供任意 SQL、文件下载、私人 settings 枚举或令牌回显。不支持的方法返回 405，参数错误返回 `400 / invalid_request_error`，详情不存在返回 404。

通用查询参数：`from`、`to` 接受 `YYYY-MM-DD`（UTC 零点）或带时区的 ISO 8601；范围是 `[from,to)`，必须 from < to。省略边界表示不限制。所有记录 `created_at` 均为 **Unix 毫秒**，区别于 OpenAI Responses 的秒单位。`limit` 默认 50、范围 1..200；`offset` 默认 0、范围 0..1000000。列表形状 `{ok:true,data:[],total,limit,offset}`，按时间和稳定次序倒序。`total` 是过滤后的全部行数，不能拿本页行数作为总数。

### 19.3 token 统计

`GET /pool/admin/stats/tokens?from=2026-10-01&to=2026-11-01&group_by=model`

可选过滤：`from,to,model,account,source,status`。`group_by` 为 `day`（默认）、`model`、`account`、`source`；daily bucket 为 **UTC 日期**，前端应正确标明时区。`source` 为 `chat`、`responses`、`claim`（挣对话奖励）、`legacy_response`（导入旧 Responses）；`status` 为 `completed,failed,cancelled`。分组至多返回 1000 个，超出时 `groups_truncated:true`，汇总仍针对完整过滤范围。

```json
{
  "ok": true,
  "checked_at": "2026-10-06T19:55:01.785Z",
  "summary": {
    "attempts": 1, "completed": 1, "failed": 0, "cancelled": 0,
    "usage_known_attempts": 1,
    "prompt_tokens": 30092, "completion_tokens": 2, "total_tokens": 30094,
    "reasoning_tokens": 0, "cache_read_tokens": 28672,
    "consume_points": 0.03, "points_known_attempts": 1, "partial_usage_attempts": 0
  },
  "group_by": "model",
  "groups": [{"bucket":"gateway-glm-5.3-flash", "attempts":1, "total_tokens":30094}],
  "groups_truncated": false,
  "token_scope": "reported_per_attempt; multi-call turns use last MODEL_CALL_END",
  "timezone": "UTC",
  "historical_coverage": "legacy Responses only; earlier Chat Completions were not saved"
}
```

示例 groups 行省略其余字段；实际每行包含与 summary 相同的指标。attempts 是**上游尝试数**，不是 HTTP 请求数：跨账号重试各记一次，挣 CHAT 奖励的对话也计入；参数在本地被拒绝而未进入网关的请求不记为推理尝试。失败若已经观测到 token/积分也计入对应合计。未知用量不会按字符估算：合计不纳入未知量，并用 known_attempts 指示覆盖率；不能将未知值解释为实际免费或零 token。

token 口径沿用接口报告用量：一轮多次 MODEL_CALL_END 时取最后一次，`partial_usage_attempts` 表示这类记录数，不盲目累加。全部事件另存供后续核实。统计不能当作完整计费账单；reasoning/cache 是独立明细，前端不可直接再加到 total_tokens 上。历史只覆盖旧 Responses，迁移前未持久化的 Chat、领取任务对话和更早日志无法补齐。历史删正文后用量仍保留，故 attempts 可大于对话列表 total。

### 19.4 对话记录

列表可过滤 `from,to,model,account,source,status,session_key,limit,offset`。每项字段：

```json
{
  "id":"turn-<uuid>", "created_at":1791316490000,
  "source":"chat", "model":"gateway-glm-5.3-flash", "account":"kuku-0",
  "session_key":"client-session-key", "session_id":"upstream-session",
  "status":"completed", "content_stored":1,
  "prompt_tokens":30092, "completion_tokens":2, "total_tokens":30094,
  "consume_points":0.03, "usage_scope":"single_model_call", "duration_ms":1000
}
```

`id` 是记录 ID，不是 OpenAI response ID；导入记录形如 `legacy-<response id>`。列表不返回正文。详情形状 `{ok:true,data:{...}}`，额外包含 `reply_id,think_mode,messages,output_text,reasoning_text,reasoning_tokens,cache_read_tokens,model_call_count,usage_events,error_code`。

`messages` 为规范化消息数组或 null；旧 Responses 没有原始用户消息，导入时无法补回。`usage_events` 是每次上游报告的 `{prompt_tokens,completion_tokens,total_tokens,reasoning_tokens,cache_read_tokens}` 数组。`usage_scope` 为 `single_model_call`、`last_model_call`、`reported`（旧报告/无事件）、`unknown`。未知积分为 null。SQLite `content_stored` 是数字 0/1，前端按布尔解释。

两个对话接口的流式和非流式均保存记录。客户端断开时记录已观测的部分信息，状态可为 cancelled，HTTP 日志内部状态为 499；这不保证上游停止生成或不计费。磁盘写入失败返回错误，不会为存储失败再切到另一账号花积分重试。

`store:false` 不保存正文/思考，仅保存用量及最小续接元数据。Responses 仍能用 previous_response_id 续接，但不会出现在原列表，`GET /v1/responses/:id` 对它返回 404。该行为修正了旧版仍可读取 store:false 内容的缺口。`DELETE /v1/responses/:id` 在 SQLite 中同时删除对应对话归档，保留累计统计；备份不会自动删。Chat 请求也支持 `store:false` 作为本项目扩展。

对话历史 ID 不能直接作为 previous_response_id。需要续接 Responses 时仍使用原 `/v1/responses` 的 response ID；新的全来源历史用于查看记录。Chat 续接使用相应 session_key 作为 x-kuku-session，必要时定向原 account；账号已删除或不可用时应正常展示服务端错误。

### 19.5 日志

`GET /pool/admin/logs?kind=http&level=warn&limit=50&offset=0`

可过滤 `from,to,level,kind,limit,offset`；level 为 `info,warn,error`，kind 为 `http,system,legacy`。行字段 `id,created_at,level,kind,method,path,status,duration_ms,message`。系统/旧日志的 method/path/status 可为 null；HTTP 日志 message 为空，提供路径、状态和耗时。日志查询本身也会产生后续 HTTP 日志。

不记录请求头、请求体、URL 查询字符串；系统日志和指定导入日志脱敏 Cookie/Bearer/token 及已知实际凭据，消息上限 2000 字符。手动领取写入每账号结果摘要，自动领取日志与结果均入库；失败推理记录脱敏原因。

### 19.6 后端系统设置

GET 示例：

```json
{
  "ok":true,
  "settings":{"site_name":"kuku2api","log_retention_days":30,"conversation_retention_days":0},
  "auto_claim":{"enabled":false,"hour":9,"last_run_at":null,"last_result":null,"next_run_at":null,"running":false},
  "storage":{"engine":"sqlite","schema_version":1}
}
```

PATCH 只接收 settings 的三个直接字段，例如 `{ "site_name":"我的号池", "log_retention_days":30 }`；省略字段保持不变。site_name 为去首尾空格后的 1..80 字符；保留天数为整数 0..3650，0 表示长期保留。未知字段拒绝，整份参数先校验再保存。修改策略会立即清理已过期数据，随后启动/每小时继续清理。对话清理也移除旧 Responses 映射，可能使旧 previous_response_id 无法续接，但累计 token/积分统计仍保留。

定时领取的 enabled/hour 仍调用原 `/pool/admin/auto-claim`，不能通过 PATCH settings 修改；状态和结果保存 SQLite。保存失败时不会激活未保存的配置。连接用 baseUrl、浏览器填写的 API key/管理员令牌仍属前端本机连接配置，不能通过此接口上传、枚举或获取服务端凭据；PORT/CORS_ORIGIN/DATABASE_FILE 等启动配置仍使用环境变量。

### 19.7 验证记录及前端配合

离线回归共 180 项：原 137 + 后端可靠性 19 + SQLite 24。隔离 npm 安装验证首次令牌保存 SQLite、显示一次、重复安装复用。移除迁移回滚、日志脱敏、正确 token 合计或 store:false 保护的变异版本均被回归捕获。

正式迁移 3 个账号、10 个会话、20 条旧 Responses、5 行旧日志；保留原文件，一致性初始备份为 `data/backups/initial-migration-1791316101616.sqlite`。真实验收只发一条主号最小 GLM Flash 对话，消耗 0.03 分，余额 2855.84 → 2855.81；30092 输入 + 2 输出 = 30094 总 tokens，API、SQL 对话和过滤后的统计完全一致。验收后会话 11、对话 21；PRAGMA integrity_check=ok、foreign_key_check 无异常。未触发领取，自动领取保持关闭。结果：`capture/sqlite-live-acceptance-2026-10-07.json`。

本轮未修改前端。给前端开发员的完整任务提示词见 `docs/frontend-update-prompt.md`。原账号、密钥、任务、流式接口继续使用；新增页面读取上述受保护的 API，不访问数据库文件，不把完整管理员令牌硬编码进源码。

## 20. 百度账号去重（2026-10-07）

账号的本地 `id`、alias 和 Cookie 都不能代表稳定的上游用户身份：同一百度用户重新扫码会获得新 Cookie。后端现在通过库库客户端使用的只读 `/api/genflowpro/settings/profile` 接口核实 `uk`，转换为字符串作为内部 `upstream_user_id` 保存 SQLite；该字段不通过账号列表或登录响应暴露，也不接受前端声明的身份作为去重依据。账号别名相同不会因此被误判。

### 20.1 手动添加及修改凭据

- `POST /pool/admin/accounts`：本地 ID 已占用、标准化 BDUSS 相同，或验证到相同百度用户时，返回 **409**，`error.code = "account_already_exists"`；不新增账号，不自动覆盖已有账号的凭据、别名、优先级、禁用状态或会话。
- `PATCH /pool/admin/accounts/:id`：修改 BDUSS/STOKEN 时重新核实身份；不能改成号池里已有的另一个百度用户，冲突同样返回 409。更新同一用户的登录凭据仍保留原本地 ID、别名、优先级、禁用状态及会话，成功后清除该号的运行时登录失效/冷却标记。纯元数据修改不读取上游资料。
- 新账号身份无法核实，或仍未记录身份的旧账号无法核实而不能排除冲突时，返回 **502**，`error.type = "upstream_error"`，`error.code = "account_identity_unavailable"`；请重试、更新失效账号凭据，或由管理员处理不再使用的旧记录。失败时不会猜测账号身份并继续添加。
- 账号添加和凭据修改共用串行队列，身份检查与写入不可被同时扫码或手动添加绕过；保存成功后才更新内存号池。身份检查是只读请求，不发送 AI 对话、不领取或消耗积分。

```json
{
  "error": {
    "message": "该百度账号已存在于号池，请使用已有账号；如需更新登录凭据，请编辑该账号",
    "type": "invalid_request_error",
    "code": "account_already_exists"
  }
}
```

### 20.2 扫码及短信登录

既有登录路由、成功状态 `added` 和 HTTP 状态保持原约定。扫码轮询或短信验证完成登录后，如果对应百度用户已在号池，返回 HTTP **200** 的终态：

```json
{
  "state": "failed",
  "reason": "该百度账号已存在于号池，请使用已有账号；如需更新登录凭据，请编辑该账号",
  "code": "account_already_exists",
  "account_id": "kuku-0"
}
```

`account_id` 指向已存在的本地账号，不是新建账号；`code` 在此情形为字符串（旧上游失败仍可能是数字或 null），QR 响应仍可能包含不含凭据值的 `diag`。身份读取失败则为 `state:"failed"`、`code:"account_identity_unavailable"`，不新增账号。前端应在终态停止轮询，显示 reason；可用 account_id 定位已有账号。相同 login_id 的终态重试重放结果，短信同一会话的并发验证合并为一次，不反复兑换票据或入池。无需新增请求字段。

### 20.3 旧记录及验证范围

旧账号缺少身份字段时，添加检查会按需核实并保存身份，后续检查及重启复用。历史重复记录不自动删除、合并或禁用，以保留本地账号 ID、会话及历史统计；但相同用户不能继续新增。管理员可核对并删除不需要的副本。

真实只读核实发现当前 5 条记录对应 3 个百度用户，两组各有 2 条重复记录；没有读取输出 Cookie、真实用户标识或私人资料。专项回归涵盖 Cookie 更换后去重、同名不同用户、身份伪造忽略、并发插入、扫码/短信终态重放、凭据冲突、写盘失败及 SQLite 重启。当前完整离线回归共 194 项（原 137 + 新增登录 2 + 可靠性 19 + SQLite 24 + 账号去重 12）。

2026-10-07 已补存全部 5 条记录的身份并重启实际后端。正式接口重复添加实测返回 409 / account_already_exists，账号数 5 → 5；两组重复账号的不同 Cookie 在隔离号池中，通过真实上游资料读取均被识别并拒绝。会话仍为 12，数据库 integrity_check=ok、foreign_key_check 无异常，未发送对话或领取积分。结果见 `capture/account-dedup-acceptance-2026-10-07.json`；修改前一致性备份为 `data/backups/before-account-identity-1791318193502.sqlite`。去掉身份比较、入池串行队列或先保存再生效保护的三个变异版本，均被专项回归捕获；变异过程未改动正式源码。

## 21. 新用户电脑端初始化及积分补领（2026-10-07）

缺陷：原登录流程只换取凭据并加入号池，遗漏官方电脑端正常执行的 `/api/genflowpro/common/userreport` 和 `taskComplete(SELF_DOWNLOAD, auto_claim=true)`。现已补齐，并对真实的新用户样本验证到账。额度、资格和同设备规则仍由上游决定，不保证固定赠送额度。

### 21.1 触发方式

- 成功添加一个新账号后，后台使用已保存的真实本机电脑端设备上下文执行一次初始化。覆盖扫码、短信和手动添加。重复账号被拒绝时不执行；启动/重启不遍历号池补领。
- 手动添加仍返回 **201**，原响应新增 `desktop_login` 对象。扫码/短信成功仍为 `state:"added"`，新增同名对象；重复查询该登录会话继续返回该结果。
- **账号新增成功和积分初始化成功独立**。即使初始化失败、设备信息缺失或结果不确定，账号已保存，仍返回新增成功；前端应显示 desktop_login.message，不误报奖励到账，也不要再 POST 一个重复账号。
- 修改账号凭据不自动重新初始化。已有账号的补跑使用下面的独立管理员接口。

| 方法及路由 | 输入 | 行为 |
|---|---|---|
| `GET /pool/admin/accounts/:id/desktop-login` | 无 body | 只读返回 `{ok:true, account_id, configured:boolean, initialization:对象或null}`，不调用上游、不触发领取；结果是历史观测，当前余额另读 `/pool/points?account=:id` |
| `POST /pool/admin/accounts/:id/desktop-login` | `{}` 或 `{retry:boolean}` | 指定单个账号补跑，HTTP 200 返回 `{account_id, ...初始化结果}`；POST 只应由用户明确点击触发，前端不自动遍历号池 |

两接口都需要现有管理员令牌。未授权 401、未知账号 404、不支持的方法 405；body 包含 retry 之外字段或 retry 不是 boolean 时 400；账号尚未核实稳定用户身份则 409 / account_identity_unavailable。GET 的 configured 只表示设备上下文是否完整，不表示用户具有奖励资格。

### 21.2 结果字段与状态

成功样本：

```json
{
  "account_id": "kuku-4",
  "ok": true,
  "status": "credited",
  "attempted_at": "2026-10-06T20:44:58.000Z",
  "is_new": true,
  "reported": ["USER_REPORT", "SELF_DOWNLOAD"],
  "task_status": "SUCCESS",
  "claimed_points": 0,
  "claimed": [],
  "balance_before": 48.49,
  "balance_after": 648.49,
  "balance_delta": 600,
  "message": "已观察到积分余额增加，实际额度以上游为准",
  "notes": ["balance_delta 是两次余额的观测差额；并发使用、其他赠送或扣费也可能影响，不等同于单项奖励金额"]
}
```

| status | 含义 |
|---|---|
| `credited` | 上报完成，读到 token 资产余额增加（delta>0）；这是观测差额，不是可无条件归因于单项奖励的金额 |
| `no_credit` | 上报完成，余额未增加；可能已领过、无资格、延迟或有其他扣费。ok=true 仅代表流程完成，不能显示“领取了固定积分” |
| `balance_unknown` | 上报完成，但操作前或后余额无法读取。余额及差额未知字段为 null，不能替换为 0 |
| `unavailable` | 缺少真实本机电脑端设备上下文/身份，未上报；code=desktop_context_unavailable。账号保留 |
| `failed` | 收到明确的上游拒绝/校验失败；ok=false，附 code、phase、余额及已确认的部分结果。可由管理员显式 retry=true 重试未完成步骤 |
| `verification_pending` | 网络异常、保存异常或进程中断导致结果不确定；ok=false。后续 POST 只读取余额验证，不再次发送可能已经完成的发奖请求，即使 retry=true 也不绕过保护 |

- `is_new` 为上游的新用户标记，boolean/null，不等同到账或固定活动资格。
- `reported` 记录已确认上报的阶段；`task_status` 是 SELF_DOWNLOAD 的上游 complete_status。
- `claimed_points`/`claimed` 只统计本流程通过明确 `rewardClaim SUCCESS` 返回的 SELF_DOWNLOAD 金额。自动发放可能令 balance_delta>0 而 claimed_points=0，两者不相加。`reward_point` 本身不作为到账证明。
- `code` 为字符串、数字或缺失；`phase` 在失败时为 login_report/self_download/reward_claim 等阶段。上游原始错误正文、uinfo、bdstoken、Cookie 和设备指纹不返回给前端。
- `replayed:true` 表示复用了先前结果。完成后的 POST 不重新上报，字段里的余额为原次操作历史观测；当前余额请读积分接口。余额延迟到账时也应刷新积分接口/任务列表。
- 若上游自动领取后仍返回可领取的 SELF_DOWNLOAD 任务，本流程只领取该类真实现存任务。不模拟邀请、不执行每日签到/对话，也不发送付费 AI 消息。

### 21.3 本机设备配置及持久化

设备上下文私有存放 SQLite settings 的 desktop_context 键，不从公共系统设置接口暴露，不接受前端提交 devuid/device_id 来更换。初始化记录按验证后的上游用户身份的 SHA-256 索引保存（同用户重复本地记录共用），并与该号日常领取共用队列。请求前先保存检查点；完成阶段和部分领取结果会保存，重启可恢复，正常重试不重复已经确认的步骤。

本机已安装 Windows 官方客户端时，可以运行一次导入工具：

```powershell
node test/import-desktop-context.mjs --client-dir 'D:\x86 soft\KukuAI'
```

工具使用现有的 `analysis/asar/node_modules/koffi` 2.16.3；其他位置可通过 `--koffi-dir` 指向本机现有 Koffi 模块目录。此工具只在独立进程运行官方安装目录的 genflowengine.dll，不给原生组件设置账号 Cookie、不调用奖励接口、不打开客户端 UI；正式 API 请求进程不加载原生 DLL，也不新增运行时 npm 依赖。

已核实：原生参数 3 提供 common/devuid，参数 4 是指纹而非任务所需数字 ID，**数字任务设备 ID取参数 7（CHANNEL_DEVICE_ID）**。应用 buildVersion 取安装包 resources/package.json 的 win_version，不能使用 native kernel 的 get_version 作为应用版本。只读取这些真实设备字段，不调用 setParamById 修改或随机化身份；已保存的身份与新读取值不一致时工具拒绝自动替换。同机器不同账号共用真实设备，不给每个账号生成假设备标识。

没有官方客户端/设备信息时会返回 unavailable，不影响入池或正常 AI 对话。管理员可先在实际电脑端正常登录，再根据真实设备环境配置和活动资格补跑；不要从别的电脑复制设备指纹规避限制。

### 21.4 验证记录

完整离线回归 210 项，新增电脑端初始化 16 项覆盖并发、持久化、未知网络结果、部分领取、身份不匹配、未知余额、鉴权和正常日常领取不受影响。去掉完成缓存、自动领取参数、实际余额判断或首次持久化检查点的四个变异版本均被回归捕获。

2026-10-07 本机官方设备信息跨独立进程读取一致。只对 kuku-4 补跑一次真实初始化，is_new=true，USER_REPORT 和 SELF_DOWNLOAD 成功，余额 48.49 → 648.49（+600）。没有发送 AI 对话、模拟邀请或领取签到任务；重复 POST 复用已保存结果。详情见 `capture/desktop-login-acceptance-2026-10-07.json`；修改前备份为 `data/backups/before-desktop-login-1791319485921.sqlite`。此样本验证流程可触发真实赠送，不代表每个账号都有同样额度。

随后实际重启后端再次验收：原初始化时间及 +600 历史观测恢复，重复 POST 为 replayed=true，未重新上报。结果见 `capture/desktop-login-restart-acceptance-2026-10-07.json`。另读真实余额仍为 648.49；当前 3 个账号、12 个会话，SQLite integrity_check=ok、foreign_key_check 无异常。

## 22. 对话领取挂起修复与超时语义（2026-10-07）

### 22.1 修复内容

`POST /pool/admin/claim` 的路径、请求参数和正常返回字段保持兼容，前端现有 `{id, chat:true}` 可直接使用。

上游原生对话流会发送 `TURN_DONE`、`FINISH`，而且不一定发送 `[DONE]` 或立即关闭连接。后端现在识别这些完整回合结束事件，结束读取并释放上游连接，再继续 `taskComplete(CHAT)` → 重新读取任务 → `rewardClaim`。结束事件携带 reply_id 时须匹配本次回复；`MODEL_CALL_END` 和 `REPLY_END` 仍是中间事件，不能单独证明整轮对话完成。SSE 支持 LF/CRLF 以及跨网络分片的分隔符。

只在明确完成的对话之后上报 CHAT。没有结束事件就关闭的流判为中断，不再当作成功并发奖；已经观察到的用量、部分输出和扣费仍记录到 SQLite。普通 AI 对话同样使用该结束判断，但仍不会自动上报或领取积分。

领奖默认 `text` 从容易触发工具的“签到”改为“请只回复 OK，不要调用工具或执行任何任务。”。未传 text 的现有前端直接使用该默认值；显式传 text 仍会使用调用者的文字。每次真正需要赚取 CHAT 时使用新的独立会话，避免复用以前挂起的工具流程；已完成/可领任务仍先读取任务状态，不为了创建独立会话而再发对话。

上游 `REQUIRE_EXTERNAL_EXECUTION` / `AWAITING_INPUT` 代表等待电脑客户端工具执行或用户补充输入。后端没有执行这些工具的运行环境，收到后立即返回明确失败并释放连接，而非继续无限等待或假定对话完成。

### 22.2 等待上限和失败结果

普通上游 JSON 请求每次最长等待 30 秒，包含响应正文读取；单次 SSE 请求最长等待 180 秒，包含连接及响应正文读取。限制按上游请求计算，不是整个领取 HTTP 请求统一 180 秒。客户端取消对话也会中断实际的上游请求。

领取接口继续返回 HTTP 200 的批量结果；顶层 `ok:true` 仅代表批量请求已处理，必须查看各项 `accounts[].ok`、`code`、`message`、`claimed`、`points_earned`：

| accounts[].code | 含义与处理 |
|---|---|
| `upstream_timeout` | 等待上游超时，单账号 `ok:false`、`unreachable:true`；请求释放，不再无限等待。上游可能已执行部分操作，应先刷新任务和余额 |
| `upstream_incomplete` | 收到部分对话后连接关闭，但未收到完整回合结束事件；单账号 `ok:false`、`unreachable:true`，不继续上报 CHAT |
| `upstream_requires_client` | 对话等待电脑客户端执行工具或补充输入；单账号 `ok:false`，不标记 unreachable、不上报 CHAT。默认领奖使用纯文本短答；显式自定义文字也应避免工具任务 |

对于 `/v1/chat/completions`、`/v1/responses`，尚未开始返回流时超时为 HTTP 504、中断为 HTTP 502、等待客户端执行为 HTTP 422，`error.code` 对应上述三值；已经开始的流通过原有错误事件返回错误。结果不确定或等待客户端工具的已发送对话不会自动换另一个账号重发，以免重复扣费。这些失败不直接判账号掉线或积分不足。

前端无需修改即可领取。可选的体验改进：领取过程中禁用重复点击，失败先刷新任务和余额；不要把 HTTP 200、顶层 ok 或单项 ok=true 且 points_earned=0 显示成“到账了积分”，以 `rewardClaim SUCCESS` 的 `claimed` 和真实余额为准。后端不增加自动重试对话循环。

### 22.3 回归与验收

后端完整离线回归 222 项全部通过。新增 `test/claim-stream.mjs` 的 12 项覆盖：保持连接开启的 TURN_DONE/FINISH/[DONE]、CRLF 分片、真实管理员领取路由、已领重复调用、未完成 EOF、错误回复结束事件、超时释放队列、正文超时、客户端取消、不确定扣费后的换号保护、两种客户端等待事件、纯文本默认领奖提示及独立会话。数据库模拟上游也补齐完整回合结束事件。

`node test/claim-stream-mutations.mjs` 的七项变异（忽略原生结束事件、接受不完整 EOF、遗漏正文超时、重复不确定扣费对话、遗漏客户端等待错误、复用挂起会话、恢复有歧义的领奖提示）全部被回归捕获。

首次仅修结束判断/超时的真实验收仍超时，kuku-4 余额 648.40 → 648.29，没有确认领取，未自动重发。随后通过官方客户端使用的只读 getsessiondetail/getmessages 和静态归档 GET 核实：旧领奖会话存在 REQUIRE_EXTERNAL_EXECUTION / AWAITING_INPUT，不能由无客户端工具运行环境的后端继续。只读归档检查没有创建会话、发送消息或调用生成流；脱敏结构见 `capture/claim-stream-archive-inspection.json`。因此补上纯文本默认提示、独立会话以及等待事件的明确失败处理。

真实验收只使用显式指定的账号：`node test/claim-stream-live.mjs --account kuku-4`，需配置当前管理员令牌；最多发起一次完成对话并领取请求，不纳入 npm test。结果保存在 `capture/claim-stream-live-2026-10-07.json`。

在用户明确批准再次验收后，最终版本对 kuku-4 的真实领取成功（北京时间 2026-10-07 05:37:13）：约 5.15 秒完成，CHAT 上报成功、daily_chat 的 rewardClaim=SUCCESS，奖励 50 分，短答 consume_points=0.01；余额 648.29 → 698.28，净增加 49.99，任务由 UNFINISHED/claimable 0 变为 FINISHED/claimable 0。前端继续使用原接口，未修改 ui/。首轮超时证据保留于 `capture/claim-stream-timeout-acceptance-2026-10-07.json`；最终成功结果见上面的 live 文件。修改前数据库备份为 `data/backups/before-claim-stream-1791322030222.sqlite`。

## 23. 号池账号的会话隔离与续聊归属（2026-10-07）

### 23.1 请求兼容性与会话范围

前端继续传原来的 `x-kuku-session`、`x-kuku-account` 和 `previous_response_id`，无需改变参数格式。外部会话标识视为不透明字符串，后端将它与实际服务账号 ID 一起编码为内部映射键和执行队列键；即使不同账号使用相同标识，也不会复用同一个上游 session_id。冒充内部编码格式的字符串仍会被再次编码，不能选取其他账号的会话。

Chat Completions、Responses 和领奖对话统一在 Pool 会话层排队：同一账号、同一逻辑会话串行；不同账号使用相同标识时队列独立。新请求需要换号时，按最终实际账号查找/新建其专属会话，不把前一账号的上游 session_id 带过去。账号 ID 匹配优先于别名，避免某个账号的别名恰好等于另一账号 ID 时选错账号。

SQLite 的会话映射保存所属账号、已验证上游用户身份和外部逻辑标识，重启后恢复校验。账号凭据换成另一个百度用户时，原会话不能继续复用；排队期间以及等待上游分配 ID/确认归属期间账号被删除或更换身份的请求都会在发送前拒绝。同一百度用户正常刷新 Cookie 不改变身份绑定。消息发送后若保存失败，不再通过换号重复发送。

外部 `session_key` 的查询/历史记录过滤继续使用原逻辑标识；内部编码格式不要求前端了解。本次隔离对象是号池内的上游账号，管理员和现有普通 API 密钥仍沿用共享服务权限，不增加按 API 密钥划分的租户权限，也不改变出口 IP 或真实设备标识。

### 23.2 Responses 续聊规则

`previous_response_id` 将续聊固定到该回复保存的账号和上游会话。显式指定其他账号将被拒绝；原账号删除、停用、掉线、冷却或积分不足时，续聊不能悄悄改用其他账号。管理员现有的显式 `x-kuku-allow-unavailable:1` 检测权限继续适用，普通调用不能绕过状态检查。续聊执行过程中失败也不跨账号重试；新建对话仍保留原有换号规则。

| HTTP / error.code | 含义 |
|---|---|
| 409 / `response_account_mismatch` | `x-kuku-account` 与历史回复所属账号不一致；请新建对话后切换账号 |
| 404 / `response_account_not_found` | 历史回复所属账号已删除 |
| 409 / `response_account_unavailable` | 原账号当前不满足服务条件；恢复原账号或新建对话，不自动换号续聊 |
| 409 / `response_account_unverified` | 历史回复缺少可信的账号或会话元数据 |
| 409 / `session_account_mismatch` | 映射账号/上游用户身份不匹配，或请求排队期间账号已删除/换身份 |
| 409 / `session_history_unavailable` | 原上游会话无法恢复、归属不明、归属冲突或上游确认失败；不静默新建并假装续聊成功 |

这些检查在上游对话发送前执行，不给无效的跨账号续聊扣费或触发换号。流尚未开启时使用上表 HTTP 错误；已经开启的 Responses 流沿用原有失败事件。前端现有错误处理可直接显示 message；可选地对上述错误提供“新建对话”操作。

### 23.3 旧映射的兼容处理

旧映射不含明确归属，因此不能凭会话键前缀或首次访问者认领。后端联合已保存的对话记录和 Responses 元数据核实唯一账号，并用该账号的 Cookie 调用只读 `getsessiondetail`（size=0，不读取消息）确认可访问准确的上游会话，确认后才保存带账号/用户身份的映射。后续使用已保存的身份绑定。

原始旧映射保留；归属不明或多个账号都关联过的旧记录不会自动沿用。普通新请求为当前账号建立独立会话；明确续聊请求返回 `session_history_unavailable`，要求重新开始，不假装保留了历史。网络故障导致无法确认时不发送付费对话。保存失败会回滚内存中的迁移，避免出现只存在于内存的映射。

### 23.4 验证

新增 `test/session-isolation.mjs` 29 项，覆盖相同标识跨账号隔离、编码碰撞、两种 API 的共同队列、跨账号并行、SQLite 恢复、历史迁移/冲突、身份替换、删除/停用/冷却/余额门禁、续聊固定账号、自动换号后的归属、归属探针、等待上游期间身份变更与发送后保存失败。完整后端回归 251 项全部通过；八项变异检查覆盖去掉账号范围、队列、旧归属冲突检查、续聊账号检查、续聊换号保护、历史恢复检查、身份复核和上游归属确认。

真实只读校验使用已有的 kuku-4 测试会话：kuku-4 的凭据可访问，kuku-0 的凭据被上游业务码 141002 拒绝。未发送新的 AI 对话或领取积分，也不输出上游会话 ID、Cookie 或对话内容。

已部署服务的跨账号 `previous_response_id` 验收返回 HTTP 409 / response_account_mismatch，SQLite 推理记录增加 0；完整性检查 ok、外键错误 0、3 个账号及关闭的自动领取设置保留。脱敏结果见 `capture/session-isolation-upstream-owner-2026-10-07.json`、`capture/session-isolation-deployed-acceptance-2026-10-07.json`。部署前数据库备份：`data/backups/before-session-isolation-1791327578201.sqlite`。

## 24. 一键安装与生产控制台（2026-10-09）

新增 `install.sh`（Linux/macOS x64、arm64）与 `install.ps1`（Windows x64、arm64）。远程入口从 GitHub 下载源码；已有源码目录直接复用。Node.js 低于 24.15 或未安装时，下载 nodejs.org 的 Node 24 私有运行时并校验官方 SHA-256，不修改系统 Node。默认安装在用户目录的 kuku2api；拒绝覆盖无关非空目录。重复安装不自动更新源码。

默认安装使用固定 pnpm 10.34.0 和 `ui/pnpm-lock.yaml`，先完成控制台依赖安装与构建，再初始化 SQLite 和管理员令牌；构建失败不初始化数据库。首次令牌仍为 256 位密码学随机数，只在生成时显示一次；重装与重启复用已有值，显式 ADMIN_TOKEN 优先。已有账号、普通密钥、设置和领取开关不重置；新安装自动领取默认关闭。安装器不执行真实模型验收、领取或桌面设备伪造。

安装参数：Unix `--dir PATH` / Windows `-InstallDir PATH`；`--no-start` / `-NoStart` 仅安装；`--backend-only` / `-BackendOnly` 不构建控制台；`--skip-dependencies` / `-SkipDependencies` 使用已有前端依赖重新构建。PORT 仍由环境指定；默认启动前检查端口冲突，拒绝影响已有服务。安装成功默认以前台运行，关闭终端或 Ctrl+C 停止；通过 `start.sh` / `start.ps1` 再次启动。启动器清除所有大小写的 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 并设置 NODE_USE_ENV_PROXY=0，账号流量直连。安装不注册系统服务、开放端口或改变监听地址。

### 24.1 新增静态访问行为

后端 `createApp` 提供 `ui/dist` 构建产物：`GET/HEAD /` 与 `/users`、`/settings` 等无扩展名路径返回 index.html；资源从公开构建目录读取。同源控制台和 API 均使用 `http://127.0.0.1:8787`，无需前端修改请求格式。未构建控制台时保持原有 404 行为。

- index.html 与页面路由 `Cache-Control: no-cache`；`/assets/` 下构建资源为一年 immutable。
- 缺失资源不会伪装成 HTML；点文件、路径越界、指向公开目录外的链接/Windows junction 不提供访问。
- `/v1`、`/pool` 和 `/healthz` 保留后端路由及鉴权，绝不回退到 HTML。控制台静态文件公开可读，不包含账号或数据库信息；管理员操作仍使用原令牌校验，普通 API 密钥规则不变。
- 不提供源码目录、抓包、日志、数据库及令牌文件下载。HTTP 方法除 GET/HEAD 外不提供静态回退。

### 24.2 发布与验证

公开源码排除 data/、capture/、analysis/、所有凭据 JSON 与其备份、环境变量私密文件、私有运行时、node_modules、构建输出及浏览器测试截图。前端保留现有源码和模板许可声明。上线命令见项目 README；完整后端回归与安装专项验证均不消费积分。
