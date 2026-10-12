# 开发说明

[文档导航](README.md) · [API 文档](api.md)

## 后端

要求 Node.js ≥24.15.0。源码启动无需构建，后端运行时无第三方依赖。

```bash
git clone https://github.com/IKUNHEIHIE/kuku2api.git
cd kuku2api
npm install
npm start
```

首次安装初始化 SQLite 并生成管理员令牌，请保存终端输出。默认源码启动监听 `127.0.0.1:8787`；已有安装保存的端口/地址会优先使用。不要为了开发删除现有数据库，可通过 `DATABASE_FILE` 选择独立测试库。

后端提供 API；存在 `ui/dist` 时也提供控制台页面。生产安装下载预编译包，本节构建步骤仅用于开发环境。

## 前端

前端位于 `ui/`，使用 React、TypeScript 和 Vite。固定 pnpm 10.34.0 与锁文件：

```bash
cd ui
npm exec --yes --package=pnpm@10.34.0 -- pnpm install --frozen-lockfile --prod=false
npm exec --yes --package=pnpm@10.34.0 -- pnpm run dev
```

开发页面通常为 `http://localhost:5173`。`ui/vite.config.ts` 将 `/healthz`、`/pool`、`/v1` 代理到 `http://127.0.0.1:8787`；若后端使用其他端口，同步修改开发代理，或在控制台设置独立后端地址。

构建：

```bash
npm exec --yes --package=pnpm@10.34.0 -- pnpm run build
```

输出为 `ui/dist`，后端直接提供页面和静态资源。当前控制台采用项目管理员令牌鉴权，模板原有页面和依赖不代表本项目需要配置第三方登录服务。

## 验证

仓库根目录：

```bash
npm test
node --test test/publication.mjs
node test/installation-mutations.mjs
```

后端回归使用本地模拟上游，不消费真实账号积分。发布检查确认凭据、数据库、抓包和生成文件不会进入分发内容。

`ui/` 目录的浏览器测试：

```bash
npm exec --yes --package=pnpm@10.34.0 -- pnpm run test:browser:install
npm exec --yes --package=pnpm@10.34.0 -- pnpm test
```

真实上游脚本 `npm run accept` 会发送模型请求并消费积分，不属于离线测试或安装流程。只在明确准备好测试账号及费用后手动执行。

## 发布流程

`.github/workflows/ci.yml` 在 Windows/Linux 验证后端与安装逻辑，再构建控制台，打包已提交源码并执行无构建工具安装验证。main 推送通过检查后发布 `build-<commit>`，资产为 `kuku2api.tar.gz`、`kuku2api.zip` 和 `SHA256SUMS`。

安装器使用最新已验证发布包，校验归档与控制台清单。发布包包含项目 [0BSD](../LICENSE) 和前端模板 [MIT](../ui/LICENSE) 声明。

## 目录

| 路径 | 用途 |
|---|---|
| `src/` | 后端路由、上游适配、号池、登录和 SQLite |
| `scripts/` | 安装、启动、升级、预编译校验与打包 |
| `ui/` | 管理控制台源码 |
| `test/` | 离线回归、安装测试及单独的真实验收工具 |
| `docs/` | 当前使用及 API 文档，历史资料在 archive/ |
| `data/` | 私有运行数据，排除版本管理 |
| `.runtime/` | 私有 Node 运行时、维护状态与升级备份，排除版本管理 |

接口变化同步更新 `docs/api.md`。不要提交真实密钥、账号凭据、数据库或 capture/、analysis/ 中的本机调试文件。
