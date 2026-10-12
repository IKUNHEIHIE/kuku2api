# kuku2api 管理控制台

本目录是 kuku2api 的网页管理台，提供管理员登录、号池、积分、密钥、对话、日志及设置页面。

- 安装并使用项目：[项目首页](../README.md)
- 本地启动、代理、构建与测试：[开发说明](../docs/development.md)
- 后端对接：[API 文档](../docs/api.md)

控制台使用 React、TypeScript、Vite 和 Shadcn UI；生产环境由后端提供构建后的 `ui/dist`，开发环境通常使用 5173 端口并代理到后端 8787。

## 模板来源与许可

前端基于 [Sat Naing / Shadcn Admin](https://github.com/satnaing/shadcn-admin) 改造。原作者版权与 MIT 许可保留在 [LICENSE](LICENSE)；第三方依赖遵循各自许可。

模板原始版本历史见 [归档](../docs/archive/frontend-template-changelog.md)，不代表 kuku2api 的版本历史。项目原创代码的 0BSD 许可范围见 [第三方许可说明](../docs/licenses.md)。
