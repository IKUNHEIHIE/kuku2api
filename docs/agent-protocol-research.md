# Agent 原生续接与提示词依赖研究

日期：2026-10-15。范围：当前工作树、库库AI Windows 客户端 1.6.5.130 的本地解包代码、2026-10-13 已完成的真实协议验收记录。本次没有发送新的上游生成请求，没有修改运行逻辑或部署云端。客户端代码只能证明该版本的实现线索，不能替代当前服务器的行为验收。

## 结论

提示词并非库库AI原生工具调用的必要前提。当前适配把历史包装成一条消息、在交出工具调用时结束原生轮次，再为下一次请求创建新会话，因此需要额外文字解释历史、工具归属和调用限制。

最有证据支持的改进方向是保留原生待完成工具调用，将客户端结果通过原生 callback 回传，再继续原来的生成轮次。它有望减少历史重放和重复发现工具，但跨 HTTP 请求、长时间等待和重启后的可靠性尚未验收，不能直接切换为生产默认行为。

## 能力与证据

| 研究项 | 证据 | 判断 |
|---|---|---|
| 原生工具结果回传后继续生成 | 既有 GLM Flash、DeepSeek Flash 实测完成 connector → tools/list → tools/call → callback → 最终回答 | 已有真实闭环证据；当时回调立即发生，不能证明长时间挂起可靠 |
| 原轮次断线续流 | 客户端 SDK 的 `getResumeSnapshot`、`canResumeFrames`、`resumeChat` 使用原 reply_id 和最后事件 msg_id | 官方客户端有实现；本项目尚未对待完成工具任务的断线、重启恢复做实测 |
| 保留同一会话历史 | 客户端 sendMsgImpl 复用 session_id；本项目普通文本路径也有持久会话映射 | 原生会话续聊有实现；不等于可以导入任意 OpenAI 历史 |
| 任意结构化历史导入 | 检查的消息构造代码以 text、rich_input_params、附件等字段发送；未找到 messages/assistant/tool 历史导入通道 | 尚无支持证据，不能断言上游不存在其他通道 |
| 工具定义预加载 | 客户端 a4 只构造 connector 的 name、description、type；定义通过 tools/list 返回 | 未找到已验证的预加载入口 |
| 直接传 OpenAI tools | 既有两模型实验未完成工具调用；原生 connector 实验成功 | 这些位置直接传 tools 未成功，不代表全部可能字段都已排除 |
| messageadd 是否可导入历史 | 客户端 Y3 调用 beforeEnqueue/afterEnqueue，构造 CHAT_CREATE；被 addBootSequenceMessage 使用 | 属于待发送消息队列，不应当作历史写入接口使用 |
| premake_data 是否可传工具定义 | 客户端输入构造从 premake_query_id、scene 或前次 premakeData 生成 | 没有工具预加载证据，不应凭字段名称尝试生产接入 |

既有实测见 [上游工具通道与 Agent 验收](agent-upstream-verification.md)。本次未用“模型说它有某种能力”作为协议证据。

## 当前实现中可替换的部分

- `src/native-agent.mjs` 每次分配新会话、设备和控制通道。tools/call 后只保存工具名、参数，交接前调用 closeTurn，finally 结束控制连接。它没有把原生任务映射保留到下一次 API 请求。
- `src/agent.mjs` 的 renderAgent 把历史放进 CONVERSATION_JSON；validateAgentTurn 为客户端生成新的 call ID。原生续接需要保存这个最终公开 ID 到 task_id/request_id 的映射，不能重新验证时再生成一套 ID。
- `src/server.mjs` 的 Chat 和 Responses Agent 路径均使用随机 sessionKey。Responses 的 previous_response_id 当前主要用于恢复历史，不代表续接原生挂起任务。
- `src/gateway.mjs` 的账号工作锁覆盖单次请求。跨请求续接需要单独管理待完成任务的账号占用及失效条件，不能简单删除 closeTurn。
- 用量当前按一次 nativeAgentTurn 汇总；续接后同一个上游 reply 对应多个客户端响应，必须对重复事件去重，并核实积分字段是累计值还是增量，避免重复统计。

## 建议落地方案

先做隔离原型，保持现有新会话重放路径可用。第一阶段只处理同一进程内、短时间等待、文本工具结果的连续调用；其他输入明确走现有路径或返回可解释的续接失败。

1. 首次请求注册 connector，返回经过验证的工具调用，同时保存原生会话、设备、控制通道标识、帧游标，以及公开 call ID → 原生 task_id/request_id 的映射。先完成状态保存再交出调用。
2. 下一次请求先匹配待完成调用，再选择账号。核对调用方授权范围、账号身份、完整历史前缀、模型、实际思考设置、系统指令、工具定义、tool_choice 与并行设置。不能只用工具名称或消息相似度匹配。
3. 收齐本批次结果后回传原生 callback，继续原轮次。只转发新产生的正文和工具调用，避免把上一请求已显示的文字再次返回。
4. 会话使用有界等待时间和数量。账号失效、任务取消、历史分支、参数变化、状态过期必须显式处理。不能把某个账号的 pending task 转到其他账号。
5. 回调响应丢失时，不假定上游没有接收；先核实状态。不能无条件重复 callback，更不能自动重发原始用户任务。缺失、冲突或重复工具结果要在恢复生成前处理。
6. 只有在原生轮次明确结束、且具备完整真实工具历史时，才考虑安全切回现有重放路径。无法确认状态时应返回错误，避免产生重复调用。

内部续接不一定需要客户端增加字段：Chat 可使用返回的 tool_call_id 匹配，Responses 可结合 previous_response_id。但调用方隔离、store:false 的临时状态保留、过期错误和账号切换语义需要在正式实现时补充到 API 文档。

服务重启恢复是后续阶段：SQLite 可以保存映射，不能保存活跃连接。只有确认控制通道重建、任务恢复、帧去重和回调幂等语义之后，才能宣称支持重启续接。

## 最小真实验收设计

每次只运行一条合成工具链，不执行真实文件或系统命令。GLM 5.3 Flash 与 DeepSeek v4.1 Flash 分别验证：

1. 工具使用随机名称及仅放在 schema 内的随机枚举参数；提示词不泄露这些值。
2. 第一轮收到真实 tools/call 后向测试客户端交出调用，短暂停留，再提交只存在于工具结果中的随机标记。
3. 验证最终回答使用该结果，原生 session_id/reply_id 没有变化，没有第二次 chat_create，没有重发用户任务；记录 tools/list 次数，而不是预设它一定只发生一次。
4. 分开验证控制流保持连接、对话流携带游标重连。只有通过短等待后才增加长等待、并行调用、断线和重启场景。
5. 对照现有路径，保持模型、实际思考档位、系统指令和工具定义一致，比较首个有效工具调用时间、最终回答时间、模型调用次数、推理 token、积分、重复正文与重复调用。单次结果只作功能证据，不宣称性能提升百分比。

关闭连接、重新打开 SSE、迟到 callback 都可能影响生成和积分，应各自作为明确测试步骤；不自动循环复验。

## 本地复核位置

以下是本机已有客户端包的检索锚点，不随项目分发第三方解包代码：

- `analysis/asar/package.json`：版本 1.6.5 / 1.6.5.130。
- `analysis/asar/out/renderer/assets/new-task-CImNAhDq.js`：`async function a4`、`sendMsgImpl`、`buildChatCreateMessage`、`async function Y3`、`beforeEnqueue`、`reopenForReconnect`。
- `analysis/asar/out/renderer/assets/dist-BIw2NGt8.js`：`getResumeSnapshot`、`canResumeFrames`、`async resumeChat`、`msg_id:t.lastEventId`。
- `capture/probe-native-mcp-loop.sh`：既有合成原生闭环探测脚本；本次仅阅读，未执行。

当前证据支持开展原生续接原型，尚不支持承诺完全去除适配提示词或恢复为纯模型 API 的行为。上游应用自身的 Agent 指令、工具发现策略和调度仍可能影响模型输出。

## 研究后的实现进展

已增加 `src/agent-continuations.mjs` 和原生轮分段交接逻辑，支持同进程、短时文本工具结果回传；由 `NATIVE_AGENT_CONTINUATION=1` 启用，默认关闭。原生流保持连接，没有实现断线游标恢复或服务重启续接。

本地模拟验证了一次初始发送、多个客户端请求、同一 session/reply、原生结果回调、分段用量及正文隔离。覆盖 API 密钥隔离、历史/配置改变、并行结果乱序、重复提交、取消、等待超时、凭据替换、持久化失败、回调应答丢失和迟到工具调用。未将这些模拟结果作为真实上游可用性或速度提升证据。

当前版本真实上游验收仍待完成，启用条件与兼容性限制见 [API 文档](api.md#实验性原生工具续接)。
