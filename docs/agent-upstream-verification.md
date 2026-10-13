# 上游工具通道与 Agent 验收

日期：2026-10-13。范围：v1.1.0 后端及已更新的云端服务；v1.0.1 不包含本次工具与图片适配，需运行一键升级。记录仅包含合成测试与协议结构，不包含账号凭据、真实用户会话或服务器密钥。

## 结论

库库AI本身具备 Agent 工具能力。此前根据等待电脑端事件推断“没有客户端工具通道”不准确：直接放入 OpenAI tools 字段不能注册工具，但原生自定义 MCP connector 可以提供外部工具定义并完成真实调用。

| 验证 | GLM 5.3 Flash | DeepSeek v4.1 Flash |
|---|---|---|
| 在 sendmsg 数据、外层和 SSE 请求加入 OpenAI tools/tool_choice | 模型返回 NO_CLIENT_TOOL | 模型返回 NO_CLIENT_TOOL |
| 原生 connector + tools/list + tools/call + callback | 完成调用与最终回答 | 完成调用与最终回答 |
| 新后端 Chat 工具往返：读文件、写文件、执行固定验证、最终回答 | 通过 | 通过 |
| 官方 OpenCode 1.19.0 实际 read、edit、bash、最终回答 | 通过 | 未另跑 OpenCode |

标准字段测试中的请求回显不等于模型收到工具。原生探测使用随机工具名称和只放在 schema 中的枚举值：模型通过 tools/list 得到定义，随后按工具名和枚举值发起 tools/call；测试端返回合成标记后，模型给出最终答案。这证明了结构化工具通路，结论不依赖模型口头声称“有工具”。

## 原生通路

原生 sendmsg / 对话 SSE 携带 `connector_list`。另外建立基础消息 SSE 与 sandbox SSE；sandbox task 中的 `local_connector` 请求携带 session_id、device_id、server_name、sub_method、request_id，以及调用时的 tool_name / arguments。工具发现与结果通过 sandbox callback 返回 JSON-RPC result。

后端适配仅处理自己分配的会话及设备任务，不调用库库AI的原生文件系统或 shell 工具，也不把其他已登录桌面端的任务转给 API 客户端。

当前实现向客户端交出工具调用前结束该原生轮；下一次 API 请求将真实结果和完整历史送入新的原生会话。初始探测验证了直接 callback 的完整闭环；正式适配采用独立轮交接，避免长时间等待客户端执行命令时保持原生任务挂起。

## 客户端验收与已知限制

真实测试使用临时文件，实际读取 `hello agent`、写成 `HELLO AGENT`、执行固定 Node 检查。两个模型都正确返回检查结果。OpenCode 在隔离目录中完成 read→edit→bash，固定命令输出 `OPENCODE_AGENT_OK`，最终回答同样为该标记；后台不代替客户端执行。

首次 OpenCode 验收发现启动器继承了错误 PWD，并且累计上游用量触发过早压缩。复测同时设置正确目录，关闭自动压缩与额外内部 Agent；后端也将客户端系统指令传入原生自定义指令字段。复测首个请求发生一次上游网络失败，随后四个成功模型轮完成任务，不能据此承诺上游连接永不失败。

图片支持加入后，额外验证了以下流程：

| 客户端与接口 | 任务 | 结果 |
|---|---|---|
| 原生 GLM Flash | 上传合成 PNG，识别形状、颜色和未写在提示词中的标签 | 红色矩形、两个蓝色圆形、PIXEL 7Q42 均正确 |
| GLM Flash / Responses | 公共 HTTPS 图片 URL→安全下载→上传关联→实际识图 | HTTP 200，正确描述蓝黄相扣图形 |
| DeepSeek v4.1 Flash / Chat | 合成 PNG→原生图片读取→结构化 report_observation 调用 | label=PIXEL 7Q42、blue_circles=2；报告积分 0.41 |
| Pi 1.2.0 / Chat | @图片附件→读文件→将看到的标签写入文件→执行固定检查→最终回答 | 4 次 API 调用，PI_AGENT_IMAGE_OK |
| Pi 1.2.0 / Responses | read 工具读取 PNG→图片工具结果回传→写入标签→执行固定检查→最终回答 | 4 次 API 调用，PI_AGENT_IMAGE_OK |

两次 Pi 测试均使用真实官方 CLI、客户端自身的内置工具、隔离工作目录和工具调用拦截器；模型不能读取含预期答案的检查脚本，也不能运行其他命令。图片答案没有出现在用户提示中，因此验证了实际图片输入，而非仅接收 image_url 字段。

上传协议验证还发现：会话关联必须提供 cfsPathType:1；发送对话的 fsid 必须使用字符串，数字 ID 会触发 STREAM_ERROR。后端已按实测格式处理，使用真实图片上传、风险检查和关联流程。

公开 GitHub PNG 的远程下载验证成功（8991 字节），也完成了 Responses 的完整 URL 图片请求并正确识图；Wikimedia 样例链接返回非成功状态，按 image_download_failed 拒绝，没有静默继续生成。DeepSeek 补充验收前两次遇到上游连接失败，带网络定位的有界复验成功，不能承诺上游网络持续可用。

本次完整后端回归 400 项通过；随后新增 DNS 失败与取消用例，图片、工具及文本兼容相关 55 项再次通过。覆盖图片格式/大小、地址与重定向防护、凭据缓存隔离、原生 ID 格式、普通图片对话、工具图片结果、SQLite 重启历史恢复和 32 MiB 请求体上限。首次完整回归遇到一次本地临时端口被 fetch 拒绝，安装测试单独复跑及第二次完整回归均通过。

用户随后在云端遇到旧版 Client tool calling is not supported 提示，检查确认正式服务仍缺少新适配文件。已保留旧后端备份并单独更新云端 11 个模块，数据库、账号、密钥和前端保留；通过实际 HTTPS 入口验证新参数校验、流式工具调用及结果回传，返回 native-mcp 标记，最终回答匹配真实诊断结果。两轮报告积分合计 0.14。上述改动纳入 v1.1.0 正式发布包，一键安装与升级使用该版本或后续正式版。

目前验收覆盖文本函数工具、流式/非流式 Chat、Responses 工具及图片结果、历史恢复和文本 custom tools。其他二进制附件、托管搜索/代码解释工具、grammar、自其他提供商加密推理状态仍明确拒绝；长任务自动压缩、所有 Agent 插件与全部模型未全面验收。API 参数、错误、用量及存储规则见 [API 文档](api.md#客户端工具调用)，客户端配置见 [使用说明](usage.md)。
