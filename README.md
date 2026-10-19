# DeepSearch

部署到 Cloudflare Workers 的个人网页搜索引擎。原生 HTML / CSS / JavaScript，Google 风格首页与结果页，无用户鉴权。凭证只存在 Worker 服务端。

## DeepSeek 接口核实

2026-10-19 已在线读取 DeepSeek 官方文档：

- https://api-docs.deepseek.com/api/search/
- https://api-docs.deepseek.com/guides/search/

官方公开 Search API 为 `POST https://api.deepseek.com/v1/tools/search`，使用 `Authorization: Bearer <DeepSeek API Key>`。本项目直接调用此搜索 API，不调用聊天模型，不生成假搜索结果，也不切换其他供应商。

请求 JSON：`{"query":"关键词","count":50,"need_content":false}`。query 为 1–128 个 Unicode 字符；count 为 1–50，默认 10。官方 API 与搜索指南均未提供 offset、page 或 cursor；未知字段会被忽略，不能用它们实现上游分页。响应为 `{"results":[{"title":"标题","url":"https://example.com","snippet":"摘要", ...}]}`。界面仅展示原始 title/url/snippet，不需要全文。保留 site:、引号等搜索语法。不自动重试付费请求。

**文档联网核实不等于真实搜索调用成功。当前未提供 API Key，未验证真实上游搜索。** 需要用户补充有效 DeepSeek API Key 及具备权限、余额的账户；当前不缺接口文档。

## 结果分页与展示

前端一次请求 `count=50`，每页显示 10 条，最多 5 页。页数只由实际返回的可用结果决定，例如 23 条为 3 页、最后一页 3 条；不足 11 条不显示分页。这里不是无限分页，也不是全网总结果数。官方指南说明 count 不影响单次请求价格。

结果页使用 `/search?q=关键词&page=2`；支持刷新和浏览器前进后退。无效页码归一到第 1 页，超出实际页数时归一到最后一页；空结果归一到第 1 页。新提交搜索回第 1 页。同一文档内按查询复用内存中的结果和进行中的请求，翻页、历史导航与重复提交不会重复查询；刷新或重新打开页面会重新请求，失败后可手动重试。旧查询完成后不会覆盖新查询。

展示参考实际访问的 Google 公开搜索页：顶部品牌与搜索框、桌面左对齐窄正文、域名和路径、蓝色标题与易读摘要、移动端自适应。只展示网页搜索，不提供无效分类；不展示虚构总量或速度，不请求第三方 favicon。

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

- `/`：首页；`/search?q=关键词&page=1`：可刷新、分享的结果页，支持浏览器前进后退。
- `GET /api/search?q=关键词&count=10`：返回 `{query,results,source}`，无需用户登录。
- 400：空白/过长查询、重复参数或非法 count；405：不支持的方法。
- 503：未配置密钥或地址无效；502：上游账户/网络/协议故障；429：限流；504：超时（上游请求 10 秒）。
- 错误为 `{error:{code,message}}`。不透传上游错误内容、密钥或请求头；HTTP 不缓存搜索 API 响应；前端会话内存复用查询结果。仅允许 HTTP(S) 结果链接，文本通过 textContent 渲染。

## 验证

```sh
npm run check
npm test
npm run test:integration
# 首次运行浏览器测试时安装 Chromium（本次环境已有可用 Chromium）
npx playwright install chromium
npm run test:browser
```

2026-10-19 验证：`npm run check` 通过；`npm test` 为 8/8 通过；`npm run test:integration` 全部通过；`npm run test:browser` 为 9/9 通过。浏览器覆盖 23 条结果的翻页与尾页、历史导航、新搜索重置、缓存请求次数、刷新重新请求、进行中的查询复用、50 条最多 5 页、非法页码、短结果和空结果。320、390、700、768、1280px 视口均验证无横向溢出。未执行线上部署，未调用真实 DeepSeek 搜索。

浏览器测试会自动启动独立本地 Worker，强制使用空密钥；测试成功、加载、空结果、异常、重试、回车提交、查询参数、刷新和前进后退、忽略旧查询的过期渲染、HTML 文本安全和 390px 窄屏布局。搜索成功数据由 Playwright 明确 mock，不是外部联网结果。

单元测试使用注入的 mock fetch。集成测试启动真实本地 Wrangler Worker、独立 HTTP mock 上游，检查首页、结果页、搜索请求、输入校验和异常路径；测试结束自动关闭进程。Mock 只在测试中创建，响应 source=mock，页面会显示“本地 Mock 测试数据”。这些测试不证明 DeepSeek 真实联网搜索成功。

## 部署（Cloudflare Git 集成）

`wrangler.jsonc` 一起发布静态文件和 Worker。在 Cloudflare Workers 的 Git 集成中连接本仓库，生产分支选择 `main`，项目根目录使用仓库根目录，部署命令使用 `npm run deploy`。安装依赖时使用 `npm ci`，以使用 `package-lock.json` 锁定的 Wrangler 版本。

首次部署后，在 Cloudflare 控制台进入 **Workers & Pages → deepsearch → Settings → Variables and Secrets → Add**，选择 **Secret** 类型，名称填写 `DEEPSEEK_API_KEY`，值填写你的 DeepSeek API Key，然后保存并部署该变更。无需通过 CLI 输入密钥。应设置 Worker 的运行时 Secret，而不是仅设置 Builds 的构建环境变量。密钥尚未配置时首页可以访问，搜索返回 503 配置缺失。

### 重新发布时如何保留值

- 配置已启用 `keep_vars: true`，保留只在控制台定义的普通变量；已有 Secret 由 Wrangler 部署默认保留。`DEEPSEEK_API_KEY` 不在配置的 `vars` 中声明，因此后续 Git 部署不会用仓库中的占位值覆盖它。
- `keep_vars` 不会让控制台值优先于配置中同名的 `vars`。配置显式声明的值仍会覆盖控制台值，空字符串也一样。因此不要添加 `"DEEPSEEK_API_KEY": ""`，也不要通过部署参数或 secrets 文件提供同名替代值。
- `DEEPSEEK_SEARCH_URL` 仍由仓库 `vars` 管理，每次部署使用配置中的官方地址；如果需要将它改为控制台管理，先从 `vars` 中移除该项。

### 预建 Secret 的限制与验证依据

当前方案不能在首次 Git 部署时自动创建一个无值、等待填写的 Secret 条目：需要在控制台手动添加一次上述名称和值。普通 `vars` 只能创建普通变量，不能预建 Secret。

已检查本项目安装的 Wrangler **4.151.1** 的 `config-schema.json` 和部署实现。该版本支持 `secrets.required`，但它声明的是必需密钥，不是空 Secret 模板：部署时未提供的必需密钥会请求继承已有绑定；新 Worker 无法继承时会在部署前报错，已有 Worker 缺少该绑定时也会部署失败。因此本项目不启用它，以支持先完成 Git 部署、再通过控制台设置密钥的流程。

源码中 `keep_vars` 对应上传元数据的 `keep_bindings: ["plain_text", "json"]`，Secret 的保留由独立的 `keepSecrets` 逻辑处理。官方参考：[Wrangler deploy 参数](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)、[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。上述结论基于配置、安装版本实现和文档核对，不代表已验证线上账户；本次未执行 CF 部署或修改远程设置。

项目不加用户鉴权；上线后公开接口会消耗你的 DeepSeek 账户配额。按需在 Cloudflare 配置限流。开发与测试无需部署到线上。
