# DeepSearch

部署到 Cloudflare Workers 的个人网页搜索引擎。原生 HTML / CSS / JavaScript，Google 风格首页与结果页，无用户鉴权。凭证只存在 Worker 服务端。

## DeepSeek 接口核实

2026-10-18 已在线读取 DeepSeek 官方文档：

- https://api-docs.deepseek.com/api/search/
- https://api-docs.deepseek.com/guides/search/

官方公开 Search API 为 `POST https://api.deepseek.com/v1/tools/search`，使用 `Authorization: Bearer <DeepSeek API Key>`。本项目直接调用此搜索 API，不调用聊天模型，不生成假搜索结果，也不切换其他供应商。

请求 JSON：`{"query":"关键词","count":10,"need_content":false}`。query 为 1–128 个 Unicode 字符；count 为 1–50。响应为 `{"results":[{"title":"标题","url":"https://example.com","snippet":"摘要", ...}]}`。界面仅展示原始 title/url/snippet，不需要全文。保留 site:、引号等搜索语法。不自动重试付费请求。

**文档联网核实不等于真实搜索调用成功。当前未提供 API Key，未验证真实上游搜索。** 需要用户补充有效 DeepSeek API Key 及具备权限、余额的账户；当前不缺接口文档。

## 本地启动

需要 Node.js 22+、npm。

```sh
npm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填写 DEEPSEEK_API_KEY
npm run dev
```

打开 http://127.0.0.1:8787 。没有密钥也可启动首页；搜索会明确返回 503 配置缺失，不会展示虚构结果。

`.dev.vars` 已被忽略，不要将其放进 public 或提交到版本库。`DEEPSEEK_SEARCH_URL` 默认为官方接口，若覆盖必须遵循上述协议并使用可信 HTTPS 地址，因为服务端会向该地址发送凭证。仅测试允许 `ALLOW_LOCAL_MOCK=true` 使用回环 HTTP 地址；线上不要设置此变量。

## 路由和错误

- `/`：首页；`/search?q=关键词`：可刷新、分享的结果页，支持浏览器前进后退。
- `GET /api/search?q=关键词&count=10`：返回 `{query,results,source}`，无需用户登录。
- 400：空白/过长查询、重复参数或非法 count；405：不支持的方法。
- 503：未配置密钥或地址无效；502：上游账户/网络/协议故障；429：限流；504：超时（上游请求 10 秒）。
- 错误为 `{error:{code,message}}`。不透传上游错误内容、密钥或请求头；不缓存搜索 API 响应。仅允许 HTTP(S) 结果链接，文本通过 textContent 渲染。

## 验证

```sh
npm run check
npm test
npm run test:integration
# 首次运行浏览器测试时安装 Chromium（本次环境已有可用 Chromium）
npx playwright install chromium
npm run test:browser
```

本次实际验证结果：`npm install` 成功（审计 0 漏洞）；`npm run check` 通过；`npm test` 为 7/7 通过；`npm run test:integration` 全部通过；`npm run test:browser` 为 5/5 通过。曾实际启动 `npm run dev`，首页 HTTP 200，检查了桌面页面截图。侧边浏览器无法连通本地服务，随后使用本机 Chromium 完成浏览器测试。未执行线上部署，未调用真实 DeepSeek 搜索。

浏览器测试会自动启动独立本地 Worker，强制使用空密钥；测试成功、加载、空结果、异常、重试、回车提交、查询参数、刷新和前进后退、取消旧请求、HTML 文本安全和 390px 窄屏布局。搜索成功数据由 Playwright 明确 mock，不是外部联网结果。

单元测试使用注入的 mock fetch。集成测试启动真实本地 Wrangler Worker、独立 HTTP mock 上游，检查首页、结果页、搜索请求、输入校验和异常路径；测试结束自动关闭进程。Mock 只在测试中创建，响应 source=mock，页面会显示“本地 Mock 测试数据”。这些测试不证明 DeepSeek 真实联网搜索成功。

## 部署（未执行）

```sh
npx wrangler login
npx wrangler secret put DEEPSEEK_API_KEY
npm run deploy
```

`wrangler.jsonc` 一起发布静态文件和 Worker。项目不加用户鉴权；上线后公开接口会消耗你的 DeepSeek 账户配额。按需在 Cloudflare 配置限流。开发与测试无需部署到线上。
