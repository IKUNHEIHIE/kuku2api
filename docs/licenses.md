# 许可证与第三方声明

## 项目许可证

kuku2api 的原创代码和文档采用 [Zero-Clause BSD（SPDX：0BSD）](../LICENSE)。允许免费或收费使用、复制、修改、分发，允许商用及闭源使用，不要求署名或公开修改后的源码。软件按原样提供，无担保。

规范文本与许可证说明见 [Open Source Initiative](https://opensource.org/license/0bsd)。根目录 `package.json` 的 `license` 字段为 `0BSD`；安装及升级发布包包含根目录 `LICENSE`。

## 第三方代码

项目许可证不替代第三方组件自身的许可，也不改变上游服务的使用规则。

| 组件 | 来源 | 许可证及保留要求 |
|---|---|---|
| 前端管理台模板 | [Sat Naing / Shadcn Admin](https://github.com/satnaing/shadcn-admin) | [MIT](../ui/LICENSE)，Copyright (c) 2024 Sat Naing；分发对应代码或其重要部分时保留版权与许可声明 |
| 前端依赖及开发工具 | `ui/package.json`、`ui/pnpm-lock.yaml` | 各依赖采用自身许可证，随依赖源码或发行文件提供 |
| 自动下载的 Node.js 运行时 | [Node.js](https://nodejs.org/) | 官方发行包自带许可及第三方声明；本项目不重新授权这些文件 |

前端对模板的修改不会取消原作者许可要求。原模板版本历史保留在 [归档](archive/frontend-template-changelog.md)，不是 kuku2api 的版本记录。
