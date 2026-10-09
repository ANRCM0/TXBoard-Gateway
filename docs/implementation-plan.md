# TXBoard Gateway 后续开发实施方案（Phase 1 之后）

> 文档版本：2026-10-08 / 规划草案 v1.1（在原规划上补充进度校准）  
> 适用仓库：`ANRCM0/TXBoard-Gateway`；协作仓库：`ANRCM0/TXBoard` 和部署仓库 `ANRCM0/TXBoard-Deploy`。  
> **状态声明：**本文保留原始设计路线、建议阶段和未完成验收条件；部分代码现已提前实现。请优先查阅 [开发状态台账](./development-status.md)、[路标](./roadmap.md) 与真实 PR/CI。完成代码、模拟测试和正式生产验收不可混为一谈。时间为单开发者的粗略工程日估算，不是交付承诺。  
> 工作项详见 [任务拆解与验收矩阵](./task-backlog.md)；现有 API 定义以 [gateway-v1](../contracts/gateway-v1.md) 为准；第三方方案的参考事实、安全边界与借鉴计划见 [AirBuddy 中间件借鉴与差异化设计](./airbuddy-design-reference.md)。

## 2026-10-09 架构基线增补（此节优先于旧版“独立安全服务进程”措辞）

已采用 **单一 Hono Gateway + 静态注册可组合中间件 + 强制全局基线 + 声明式路由策略 + Redis 共享安全状态**，而非多个 HTTP Gateway/安全服务串联。详细实施与目录图见 [模块化中间件规范](./middleware-architecture.md)，架构拓扑见 [architecture](./architecture.md)。

**优先顺序：** PR-A 保契约拆分 (`GW-210/211`) → PR-B 路由策略 (`GW-212`) → PR-C 可信代理/限流/Redis (`GW-213/215`) → PR-D 可观测 (`GW-214`) → PR-E Luma 接入和真实 Staging (`GW-216/217`)。`GW-218` 公开内容缓存是默认关闭的可选优化。

**不可变约束：** Laravel 最终认证、CAPTCHA、订单归属、资金和交易幂等；Gateway 不直连 DB、不使用管理员凭据、不转发原始订阅 Token、不劫持 `/api/*` 或支付回调；敏感账号写默认 off；原 `/gateway/v1` 和 SDK 兼容；无生产联调通过就不能放量。

本节是**开发设计已决策，代码仍待实现**。以下历史阶段规划里的“进程”或 M1/M2 顺序表述，均以本节同进程架构和 [实际状态台账](./development-status.md) 为准；安全门禁与真实联调的要求没有取消。

## 2026-10-09：TXAPI BFF 联合工作包（新优先级）

未来由 TXBoard Laravel 独占除 `/txapi/bff/v1/*` 外的 `/txapi/*`，Hono Gateway 负责可选主题 BFF；当前 Gateway `/gateway/v1/*`→固定 `/api/v1/*` 不变。G0 契约、G1 真实旧链路验收、G2 TXBoard Native、G3 Gateway Adapter/SDK、G4 Edge 灰度、G5 退役详见 [TXAPI Integration](./txapi-integration.md)。PR #10–#13 已实现前面部分模块化/安全基础设施；以下“待做”章节为历史规划，不得以其否定当前源码，也不得把源码合并等同真实验收。

## 0. 目标、现状与范围

**最终目标：**以后每个独立开发的 TXBoard 前端主题（Vue / React / Next.js / 纯 SPA）都能通过同一套 **Gateway Contract + Theme SDK** 访问 TXBoard；Gateway 作为可独立升级的 API 接入层，提供可审计的安全边界、流控与可选应用层负载加密，不复制 Laravel 的核心业务规则。

**Phase 1 基线事实（以下为历史基线，并非当前完整功能列表）：**

- Node.js 22 + Hono + TypeScript 独立服务，固定路径 `/gateway/v1`；`/healthz` 仅用于健康检查。
- 7 个路由：`bootstrap`、`theme/config`、`plans`、`auth/login`、`user/profile`、只读 `orders`、`healthz`；写入 `POST /orders` 当前返回 405。
- `@txboard/theme-sdk` 源码包（仓库工作区内可构建，**尚未发布 npm**）；固定上游路径白名单、精确 Origin 校验、请求大小/响应大小限制、超时、基础错误规范。
- Dockerfile、可选 Compose 示例、mock 单元/契约测试与容器启动烟测通过。
- **尚未** 与真实 TXBoard 后端开展完整 E2E；**尚未** 接入生产反向代理，也未让内置 Vue 前端默认使用 Gateway。

**当前能力增量（PR #4～#7，已合入 main）：** Docker Compose 为主要部署方式，用户只读应用接口扩展，HPKE 登录/加密注册和邮箱验证码（开关控制），Redis 原子 nonce 防重放和账号限流，Chromium 浏览器 + 模拟 Laravel 后端及 Redis 7.4 并发测试。详见 [状态与证据](./development-status.md)。

**仍不得宣称完成：**真实 TXBoard/Laravel/MySQL/Redis 联调、第三方 CAPTCHA 完整链路、可信代理/IP 防刷和生产告警、密钥轮换与独立密码学审计、Redis 故障转移持久防重放、交易写入幂等、主题安装 v2、SDK 正式 npm 发布、生产 SLO/WAF 或“全站加密”。

### 0.1 长期必须保持的架构约束

1. **Laravel 是最终权威。** 身份与业务授权、余额、订单、支付回调、订阅、审计规则保留在 TXBoard；网关不得使用管理员账号代办用户操作，也不得直连 MySQL 做订单变更。
2. **接口白名单默认拒绝。** 外部输入不能自定义上游 hostname、路径或转发头；只扩展经过评审的命名 operation；不做通用反向代理。
3. **旧接口保持兼容。** 管理端 `/api/v2/{secure_path}/*`、节点 `/api/v1/server/*`、订阅、支付通知、插件路由、WebSocket 不经过主题网关。
4. **主题只决定展示。** 由 TXBoard 保存选中主题与每个主题专属配置；Gateway 只转发被服务端声明为公开的 `theme_config`，不得将 theme manifest 的 feature 声明当作权限。
5. **默认 HTTPS。** TLS/源站证书验证是底线；浏览器不持有长期共享对称密钥。可选负载加密不是登录授权、防刷和 TLS 的替代品。
6. **可关、可滚回。** 新主题/新接口通过 feature flag 和逐步放量启用；任何阶段失败都能切回原 Laravel 路由而不破坏数据。
7. **数据最小化。** Gateway 默认不存储用户凭据、订单明细、支付卡信息或明文请求体；可观测日志中不出现 Authorization、密码、验证码、令牌和敏感参数。

### 0.2 里程碑与建议顺序

| 里程碑 | 工程阶段 | 建议工期* | 可交付成果 | 进入下阶段的硬门槛 |
| --- | --- | --- | --- | --- |
| M1 | Phase 1.5：真实联调与兼容闭环 | 8–12 工程日 | 真实 TXBoard 联调、可复现环境、内置前端灰度接入、SDK 包发布准备 | 用户与公开接口 E2E 全绿；一键回退 |
| M2 | Phase 2A：基础安全/可观测 | 12–18 工程日 | Redis 限流、可信来源、日志脱敏、基础风控、压测与告警 | 越权/限流/失联测试通过；无秘密日志 |
| M3 | Phase 2B：交易及用户业务能力 | 15–25 工程日 | 稳定读接口、创建订单与状态流、端到端幂等与支付边界 | 重放/并发/故障注入不会重复扣费或建单 |
| M4 | Phase 3：可选应用层加密 | 12–20 工程日 | 设计评审后实现标准化封装、密钥轮换/防重放、兼容 SDK | 密码学测试+互操作+回滚+安全复核 |
| M5 | Phase 4：独立主题生态与正式发布 | 15–25 工程日 | 主题包 v2、主题开发模板、兼容性检查、生产发布与文档 | 多框架主题 E2E、滚动升级、回滚演练 |

*单人顺序推进的粗估，合计约 62–100 工程日；不是要求连续施工。安全评审、线上资源和第三方支付沙箱可能造成额外等待。M2 与 M3 的部分设计可并行，但**不得跳过 M2 的交易前置安全门禁**。

### 0.3 AirBuddy 参考实现的取舍（新增设计输入）

参考 [AirBuddy Security Service 源码调研及迁移决策](./airbuddy-design-reference.md)：提取 **SDK 无感加密体验、免登录目录/支付方式展示、快速购买一体化、按业务场景验证码、邮件模板、独立低成本部署** 这六类产品需求；其中 SDK 可选 HPKE、加密注册/邮箱验证码及用户侧读接口已有预览实现；快速购买、支付写入、完整 CAPTCHA 业务编排仍未实现。

- **保留**：固定版本化网关协议、主题 SDK、独立容器、老接口并存。
- **重做**：若确需应用层加密，则由独立安全 ADR 审查标准公钥协议并由 SDK 自动封装；不是把浏览器与服务端共享的固定对称密码或 API 路径哈希直接复制过来。
- **业务归属**：快速注册购买、支付、通知、邮箱验证和持久化幂等由 TXBoard Laravel 实施；Gateway 不拿管理员令牌、也不自行连接数据库代替后端。
- **安全门槛**：验证票据的一次性消费与 Redis 多副本限流在 M2 完成；交易流程与支付沙箱通过 M3 验收后才开放快速购买；加密 M4 仍可因评审不通过而选择不上线。
- **来源合规**：只参考思路与用户体验，不复制许可证不明确的第三方代码或素材。

任务映射：**GW-209**（可插拔一次性挑战）、**GW-310**（安全快速购买）、**GW-311**（公开支付方式最小字段目录）、**GW-312**（复用 TXBoard 通知/邮件模板）。以上均为待开发项。

---

## 1. Phase 1.5 — TXBoard 真实联调与 API 契约稳固（M1）

**为什么先做：** 当前成功主要是 mock、类型、编译与容器健康检查，不能证明登录验证码、订单筛选、主题配置、反向代理和真实浏览器会一起正确工作。

### 1.1 上游契约盘点与版本冻结

- 依据 TXBoard 实际代码建立字段矩阵：`/api/v1/guest/comm/config`、`/api/v1/guest/plan/fetch`、`/api/v1/passport/auth/login`、`/api/v1/user/info`、`/api/v1/user/order/fetch`。
- 固定 Gateway 端响应 envelope：成功 `ok=true` / `data` / `meta.version=1` / `meta.requestId`；失败返回明确 code + 安全 message + HTTP 状态。
- 建立真实上游样本 fixtures：正常、无权限、验证码失败、token 过期、参数错误、429、空数据、非 JSON、网络超时。
- 严格定义订单接口仍返回 TXBoard 原始订单数组，而不是 SDK 假设的分页器；金额仍以 **分（cents）**计量。
- 校验 upstream “HTTP 200 + status=fail” 和真实 HTTP 401/403/422/429，以及 `status` 缺失、`data` 为空、无效结构的处理；不泄露上游异常堆栈/内部路径。
- 修订 OpenAPI 3.1 文档 + examples + 可生成的 TypeScript 响应模式；对所有“未知”字段作保守处理，不把 `as T` 断言当作运行时校验。
- 确定健康语义：`/healthz` 为存活探针；增加仅内部可访问的 readiness（上下游/Redis 依赖分级），绝不在公网上回显配置。

**验收：**真实样本与 Gateway 契约一致；SDK 的无权限、错误和正常结果一致；旧 TXBoard API 的响应无变化。

### 1.2 可复现环境与 CI

- 构建最小联调环境：TXBoard API + MySQL + Redis + Gateway + 测试主题；所有测试账号均为隔离/一次性，不能使用生产管理员账号。
- 使用固定版本依赖和提交校验：提交 npm lockfile，CI 从 `npm install` 改为 `npm ci`，基础镜像用明确版本/digest；依赖升级走 CI。
- 增加 GitHub Actions 的联调/冒烟、SDK 包打包验证（`npm pack --dry-run`）、Docker 健康/就绪验证、镜像签名及依赖报告的准备工作。
- 在 Playwright 或等效浏览器环境走通：访客 bootstrap → 套餐 → 登录（含启用验证码时的测试方案）→ 用户信息 → 订单列表 → 退出/重新认证。
- 按字段冻结兼容金样本；CI 至少覆盖响应体结构、HTTP 状态、Cookies/Headers、OPTIONS、Origin、大小/超时/重定向、未定义路径拒绝。
- 禁止在测试或 CI 日志输出真实 auth_data、密码、邮箱及完整上游请求/响应。

### 1.3 TXBoard 端只读灰度接入

**必须跨仓库 PR，而不是直接修改生产路由：**

- `TXBoard-Gateway`：实现 SDK 版本兼容探测/运行时请求适配，以及必要的 readiness/诊断。
- `TXBoard`：在 `web/user/src/api/` 通过一个可控 API adapter/feature flag，优先尝试 Gateway 的公开只读接口；保存登录状态仍沿用既有语义；遇不支持功能使用明确兼容路径。
- `TXBoard-Deploy`：新增 opt-in Gateway 容器、内网网络、健康检查和 reverse-proxy `/gateway/v1/*` 规则示例；默认 **off**。不要接管 `/api/*`。
- 防止同域名上游回环：Gateway upstream 应当指向 Laravel 内网服务/确定的上游后端地址，并确保 ingress 只将 `/gateway/v1/*` 转到 Gateway。
- 前端公开/受保护调用分离，避免旧 Axios 拦截器在 `bootstrap`、`plans` 等公开接口附带 bearer；既有 session/localStorage 迁移需要单独安全评估。
- 以明确开关启用：开关关时旧前端路径 100% 不变；回退不能导致账号退出或订单丢失。

**M1 出口验收：**

- [ ] 新旧客户端在同一隔离 TXBoard 实例上通过相同功能测试，数据一致。
- [ ] 任意 Gateway 宕机后能快速禁用可选入口；旧后台、节点、订阅、回调仍可访问。
- [ ] 实际 TLS/Full(strict) / trusted proxy 配置明确；Gateway 不对公网暴露容器端口。
- [ ] SDK build + package smoke；至少 Vue 一条真实调用链通过。
- [ ] 生产入口仍默认为旧路由，未发布“已全站防护”的误导说明。

---

## 2. Phase 2A — 安全、风控与可观测基础（M2）

### 2.1 威胁模型与身份边界

- 建立请求主体分类：访客、已登录用户、管理员、节点、支付提供商、第三方主题。Gateway 只接入前两类；管理员/节点/支付回调走独立入口。
- 网关校验 Bearer *格式*、请求上下文和路线策略；**最终身份有效性、用户所属资源与权限由 Laravel 验证**。不能凭主题声称的能力、前端 userId 或自传 header 授权。
- 设计可信代理链：只信任列在 allowlist 的 ingress IP/网段，代理先删除来自互联网的伪造 `X-Forwarded-For`、`X-Real-IP` 等标头，再写入可信上下文。不要直接以任意客户端自报 IP 做限流。
- CORS 继续精确 Origin 白名单；跨站 SPA 的认证和 CSRF/浏览器 cookie 取舍先形成 ADR 再改协议。CORS **不**是安全授权；没有 Origin 的机器请求仍须受鉴权、限流与风控。
- 回顾上游主机信任边界、DNS 解析变化、内部网络访问和 redirect；继续禁止用户传入目标主机。
- 形成可审查的攻击面表：认证撞库、验证码绕过、订单重复请求、流量滥用、错误泄漏、主题 XSS、插件引入接口、缓存穿透、资源耗尽。

### 2.2 Redis 分布式限流与抗滥用

- 选择单一原子算法（Redis Lua / atomic operation），按 **路由 + 经过验证的客户端 IP / 会话主体** 计数；跨 Gateway 副本一致，而非单实例内存 Map。
- 建议初始政策（只是候选值，压测后调整）：公共只读 60 req/min/IP；登录 5 attempts/5min/IP + 5 attempts/15min/账号哈希；敏感写 10 req/min/账号。Cloudflare/WAF/ Laravel 自身策略不能被关闭。
- 提供返回 `429` + `Retry-After`；具体维度、窗口、限额可配置，禁止通过未授权请求探测其他账号是否存在。
- Redis 故障策略分类：登录/注册/付款/敏感写 **fail-closed 或拒绝变更**；健康/公开读可在本地兜底但应有严格保守配额并产生日志告警。故障模式必须测试、运维可见。
- CAPTCHA 由 Laravel/已验证服务端决定是否有效，网关只传标准字段和审计安全结果；不得以“客户端展示了验证码”作为通过证据。
- 借鉴 AirBuddy 按登录/注册/快速下单区分验证码的体验，但不采用可重复提交的哈希校验方式；若提供自托管挑战，须用服务端一次性消费、原子 Redis 状态、尝试次数限制和风险分级（GW-209）。
- 对 body/header/query 设置严格上限；压测流控不应将 Gateway 变成放大攻击器；错误信息不可泄漏账号存在性。

### 2.3 安全日志、指标及诊断

- 建立结构化事件：`requestId`、接口 operation、方法、响应类别、耗时、限流决定、上游状态、版本、可选匿名化主体；不得记录 body、authorization、password、token、email_code、验证码原值、私人订单数据。
- Trace ID 从入口到 Laravel 显式贯穿，但不得允许外部任意 `X-Request-Id` 冒用内部审计主体；可同时保留 trusted inbound trace 与 server-generated ID。
- 指标：请求量、4xx/5xx、429、上游超时、流控拒绝率、p50/p95/p99 延迟、Redis 连接、SDK 版本、主题契约版本。
- 安全配置默认值、秘密扫描/依赖扫描、日志脱敏测试、滥用负向测试纳入 CI；按环境设置日志留存策略。
- 增加网关依赖异常、错误率、延迟、限流异常的监控与告警预案；SLO 见第 6 节。

**M2 出口验收：**在多副本中同时触发限流得到一致结果；伪造代理头/Origin、无权限调用、密钥或密码出现在错误/日志中的负向测试全通过；Redis 断连表现符合策略。

---

## 3. Phase 2B — 完整用户能力与安全交易流（M3）

**顺序：先只读覆盖，再敏感写操作；先证明 TXBoard 交易状态安全，再对外发布 Gateway 写 API。**

### 3.1 用户端 API 扩展顺序

| 计划接口（均为建议，尚未实现） | TXBoard 现有来源或待新增适配 | 分级 | 前置条件 |
| --- | --- | --- | --- |
| `GET /gateway/v1/user/subscribe` | `GET /api/v1/user/getSubscribe` | 受保护/敏感 | 字段最小化；订阅凭证绝不能进入公开响应 |
| `GET /gateway/v1/orders/:tradeNo` | `GET /api/v1/user/order/detail` | 受保护 | tradeNo 所有权 Laravel 校验 |
| `GET /gateway/v1/payments/methods` | `GET /api/v1/user/order/getPaymentMethod` | 受保护/按站点策略 | 支付字段白名单 |
| `GET /gateway/v1/notices` | `GET /api/v1/user/notice/fetch` | 受保护 | 正规化结构 |
| `GET /gateway/v1/usage` | 用户流量/订阅相关只读接口 | 受保护 | 真实字段契约/隐私评审 |
| `POST /gateway/v1/auth/register` | `/api/v1/passport/auth/register` | 高风险写 | 邮件/验证码/防刷/幂等及环境 E2E |
| `POST /gateway/v1/orders` | `/api/v1/user/order/save` | 高风险写 | **后端原子幂等，最优先** |
| `POST /gateway/v1/orders/:tradeNo/checkout` | `/api/v1/user/order/checkout` | 高风险写 | 沙箱支付、超时与重复支付处理 |
| `POST /gateway/v1/orders/:tradeNo/cancel` | `/api/v1/user/order/cancel` | 高风险写 | 竞态锁、订单所有权、幂等 |

以上新路径应按 domain module 明确 schema、错误、缓存策略、feature flag；不把后台管理 API 包进来。仍然保留原用户 API，渐进迁移而非强制停机切换。

**从 AirBuddy 借鉴的 M3 增量（均未实现）：**访客套餐目录已经由 Phase 1 支持；公开支付方式（示意：`GET /gateway/v1/catalog/payment-methods`）需由 Laravel 提供不泄漏私密凭据的展示 DTO（GW-311）；“免登录下单”改为 Laravel 正常注册/验证/受控认证/创建幂等订单的一体化**快速购买 UX**，严格遵循现有邮箱校验与邀请码策略，禁止管理员代理注册（GW-310）；邮件模板和消息发送归 TXBoard 原生通知系统管理，禁止发送明文密码（GW-312）。完整流程和验收见 [参考设计](./airbuddy-design-reference.md)。

### 3.2 订单写入的幂等必须由 TXBoard 后端最终保证

**不要只在 Gateway 做 Redis 防重复。** Gateway 重启、请求重试、旧路径直达后端、支付通知异步到达都会绕过单层去重。

建议协议：

1. 客户端创建订单时附带不可预测的 `Idempotency-Key`；作用域由 Laravel 绑定到 **实际认证 userId + operation + 请求内容哈希**，不能相信客户端 userId。
2. Laravel 数据库建立唯一约束/事务记录与订单之间的稳定关联；同键同参数返回同一业务结果，同键不同参数应稳定拒绝冲突，不能悄然复用。
3. 状态 `in_progress` / `succeeded` / `failed_retryable` 等分清；客户端超时后可查结果，不默认再创建新单。持久化数据至少覆盖业务允许的重试窗口（候选：24h；实际需由支付流程决定）。
4. 并发采用数据库事务、唯一键和明确的订单状态机。折扣券、余额冻结/扣减、支付和订阅交付不能因重放重复执行；两次并发 POST 应只有一单有效。
5. 支付回调仍通过独立支付通道进入 Laravel，验签、幂等、状态转移和金额校验由 Laravel 最终完成。**绝不**将支付回调经 Gateway 当作主题 API 转发。
6. 对 checkout、取消、退款等分别定义可重试/不可重试错误；SDK 不对非幂等写操作自动重试。
7. 旧 `/api/v1/user/order/save` 路由也必须受同一 Laravel 幂等规则保护，避免新旧端或绕过 Gateway 获得不同交易语义。

**建议补充后端合同：**`POST /gateway/v1/orders` 必需显式的 Idempotency-Key；Gateway 检查格式/长度并原样传递到 Laravel 经验证的写接口，但业务幂等不可仅依赖 Gateway。

### 3.3 场景验收

- 同一键、同请求重复 100 次（并发 + 延迟）只得到同一个可确认的订单结果；不同用户绝不共享幂等结果。
- 同键不同 body 明确冲突；服务崩溃/Redis 失联/数据库重连后，重试不会产生额外订单或扣费。
- 无权限查看别人订单/订阅必失败；用户退出/令牌过期响应一致。
- 支付沙箱：正常支付、重复回调、异步通知先到、用户关闭浏览器、支付超时、支付失败、撤销、重复点击提交逐一验收。
- 如 TXBoard 原业务逻辑存在不安全边界，先在其仓库修正并合并，随后再扩展 Gateway。

**M3 出口验收：**必须保留测试记录、失败用例及相应修复链接；没有沙箱或生产等价 E2E 证据时不得启用交易写入。

---

## 4. Phase 3 — 可选应用层负载加密协议（M4）

### 4.1 先写 Threat Model / ADR，再选择算法

明确加密要保护的是什么：TLS 已保护传输链路；应用层加密可以控制特定代理/日志环节可见的 **HTTP body**，但不隐藏访问域名、流量时间/长度，也不能防住用户本机恶意脚本、XSS、被控制的主题或合法用户自行发起 API 请求。它也不天然提供账号授权、限流和防爬。

方案需要独立 ADR 和安全评审；评审不通过则保持 **HTTPS-only 模式**，不实施自制加密。

借鉴 AirBuddy “前端看不到封装细节”的体验要求：主题通过 `@txboard/theme-sdk` 调用业务接口，由 SDK 处理可选协议；不要要求不同主题重复实现密文与路径映射，也不要承诺“加密就不被封锁”。详见 [AirBuddy 参考设计：加密取舍](./airbuddy-design-reference.md)。

### 4.2 候选协议边界

- 候选：标准化 HPKE（公钥封装）+ 经验证的 AEAD 套件；使用维护中的合规实现，拒绝手写密码学组件；必要时可以选择“完全不启用”。
- Gateway 发布包含算法套件、`kid`、有效期、用途的只读公钥集合；私钥留在服务端安全存储/KMS 或受控密钥卷，**永不**进入 Theme SDK 或前端打包文件。
- SDK 为每个受保护请求生成独立封装上下文，提交 `version + kid + encapsulated_key + nonce + ciphertext + metadata`；采用标准 API 建立双方密钥派生，避免固定全站对称密码。
- 认证上下文需与 method、固定路由、版本、请求 ID、时间窗及有效会话绑定作为 AAD，防止密文在另一 operation 上被重放。不要让客户端选择任意目标 URI。
- 抗重放：服务端用 Redis 原子 `SET NX` / 过期机制记录唯一会话作用域请求标识；超时窗口、Redis 故障时拒绝敏感操作，且 **幂等仍由 Laravel 持久化独立保证**。
- 支持 `current` + `previous` 的短期密钥轮换、吊销、过期、时钟偏差和灰度协商；拒绝算法降级和意外明文回退。
- 响应加密是否必要必须单独判定：如果使用，明确对称响应密钥派生与服务端身份确认，避免重复使用 nonce。
- 在 SDK、浏览器和 Node 双端做测试向量、互操作、性能/大包/错误注入以及第三方安全复核。

### 4.3 上线策略

- 保留传统 TLS 请求作为默认通道；通过 **服务器端策略** 定义哪些 operation 要求加密，客户端声明的“支持加密”不等于安全授权。
- 不在未接入加密协议的旧客户端上强制切换；先内测 → 新独立主题 opt-in → 必要时逐 operation 提高策略。
- 网关记录的仅是算法版本/结果/延迟，绝不记录解密后的凭证或 body。
- 灰度若出现协商失败、密钥误轮换或性能异常，可以按配置禁用新协议并回退到以前 **经安全策略允许的**通道；对已声明必须加密的敏感接口不得偷偷降级明文。

**M4 出口验收：**标准算法互操作通过，nonce/replay/key rotation/错误密钥/重定向/时钟漂移用例通过，额外延迟在预设预算内，安全评审完成。

---

## 5. Phase 4 — 独立主题协议、SDK 生态及统一用户前端（M5）

### 5.1 主题包协议 v2（与旧 Theme Package v1 并存）

现有 TXBoard Theme Package v1 仍以 `config.json` + `dashboard.blade.php` 作为安装入口。**不可直接假设 SPA manifest 已被其加载器支持。**

先形成独立主题 v2 ADR，建议最小 manifest 表达：

- 主题标识、语义版本、兼容的 TXBoard/Gateway SDK 版本区间；
- 入口类型（例如 spa / SSR）、编译产物、静态资源路径与完整性信息；
- `gateway.contract: 1.x` 以及**仅用作 UI 可见性提示**的能力清单；
- 主题公开配置 schema、默认值、公开/非公开字段的服务器侧划分；
- 作者信息、依赖和内容安全策略要求；不将服务端私密字段打包前端。

TXBoard Theme Runtime（独立 TXBoard PR）负责上传、ZIP 路径穿越/软链/压缩炸弹检查、manifest 验证、兼容性判断、启用/回退、静态资源部署及主题配置存储。Gateway 不负责解包、不访问主题文件系统，也不默认信任主题代码。

### 5.2 SDK 接口演进与开发者体验

- 把 `packages/theme-sdk` 改造成稳定发布包：版本号、`exports` / declaration、ESM 消费兼容、打包测试、release notes、SemVer 与变更日志。
- 生成类型优先来自经评审的 OpenAPI schemas；暴露稳定 `GatewayApiError`、`AbortSignal`、超时/重试策略、授权注入回调。
- 公共接口调用不附带 bearer；敏感数据不得进入永久缓存。支持 Nuxt/Next.js 的 SSR 请求级 client 实例，避免跨请求复用全局 token。
- 各创建一个 Vue、React、Next.js (SSR 安全示例) 模板，校验登录、套餐、账户、主题设置、订单页面在真实环境可用。
- 提供标准页面“主题初始化 → capability 探测 → 请求 → 用户认证 → 错误展示”；对不支持的新功能显式禁用而非随便 fallback 到不安全写入。
- 兼容协商：Gateway major version + SDK major version + theme contract version 三者独立声明。运行时拒绝不兼容而非静默降级。

### 5.3 旧主题与插件兼容

- 新的独立 SPA 主题是 opt-in；旧 Theme Package v1 和默认用户端继续可用。
- 不经网关接管管理员后台、节点、第三方支付回调、订阅客户端和插件自定义管理接口。
- 对原来某些第三方主题依赖旧 API 的场景，按 adapter 层兼容，分别记录迁移状态；不得一刀切关闭旧 API。
- 不将“受 Gateway 保护”当作恶意主题安全保证。需配套 CSP、资源完整性审计、浏览器存储隔离/会话风险说明及第三方主题审查。

**M5 出口验收：**至少 Vue + React 两类独立主题、一个 SSR/Next.js 示例、旧 Blade 主题同仓并存；切换、配置、登录、套餐、订单、网络异常、缓存更新、回滚全套通过。

---

## 6. 生产部署、性能预算与发布门禁

### 6.1 生产形态

- 首选私有 Docker 网络：公网 HTTPS ingress → 仅 `/gateway/v1/*` 指向 Gateway → 后端 Laravel 内网服务。容器不得映射公网端口。
- `/api/v1/*`、管理员 `/api/v2/*`、订阅 `/s/*`、节点、支付回调、插件、WebSocket 保持原有目的地。
- 禁用明文公网入口；Cloudflare 使用 Full (strict) 到源站，生产密钥/令牌配置由专门 secret 管理，不注入主题。
- Gateway 不获得 DB root、管理员密码、Docker socket，也不单独实现 Laravel session 权限判定。
- 部署清单：环境变量与机密来源、容器镜像 digest、readiness、熔断/超时、DNS、日志路由、入口限流与回滚命令；内网 HTTP 只在明确可信、隔离的 Docker 网络内启用。

### 6.2 建议的首次 SLO/SLA 门槛（规划指标，不是当前测量结果）

| 维度 | 候选验收标准 | 测量方式 |
| --- | --- | --- |
| Gateway 自身健康 | 连续部署后 /healthz 和 readiness 正常 | CI + staging smoke |
| 正常读请求额外开销 | p95 网关附加延迟 ≤ 30 ms（不含 upstream） | 同负载下直连/经网关 A/B 对照 |
| 网关引起的 5xx | 非上游故障下新增 5xx < 0.1% | 监控与错误追踪 |
| 安全事件 | 敏感字段日志泄漏为 0；无未知路由代理成功 | 脱敏扫描 + 负向自动化 |
| 数据正确性 | 相同请求的账单/订单状态一致且不可重复扣款 | 幂等/并发/故障注入 |
| 兼容性 | 现有旧 API 与后台/支付回调无回归 | 全链路 E2E 套件 |
| 回滚 | 故障切回旧路径，无需还原数据库或撤销已收款 | 预演与实际计时 |

指标在基准数据出来后再批准，不能把候选值当作既定产品保证。后续建议把网关的 p95、真实 upstream 耗时和失败率分开统计。

### 6.3 分批发布流程

1. **PR / CI：** 代码审查、类型、单测/契约、安全/依赖扫描、容器镜像构建、测试报告。
2. **Staging：** 真实 TXBoard sandbox + 主题 SDK 浏览器 E2E；验证码、登录、过期 token、订单读取、超时、跨域、支付沙箱（仅有写操作时）。
3. **Shadow（仅安全只读流量）：** 可选镜像读请求做结构对照，不同步用户令牌/个人敏感信息到影子日志；严禁镜像写操作。
4. **Canary：** 内部管理员测试账号/测试主题 → 1% → 5% → 25% → 100%，每一步观察 SLO、业务错误、限流误伤后再放量；比例是建议而非自动实现。
5. **回滚：** 禁用 Gateway feature flag 或删除对应路由映射，旧 API 继续可用；保留已成立订单/支付记录，禁止通过回滚重建订单。
6. **发布记录：** 标记版本、镜像 digest、所依赖的 TXBoard commit、迁移脚本、验证结果、变更范围、回滚步骤与未解决问题。

**重大生产禁入条件：**生产 SMTP/注册不可用、旧备份未做恢复演练、Origin/源站 TLS 不合格、支付回调/订单幂等未验收、权限边界不清楚时，必须暂缓相关功能上线。Gateway 本身 CI 通过不能覆盖这些系统级风险。

---

## 7. 依赖与团队边界

| 仓库/组件 | 主要责任 | 由谁先改 |
| --- | --- | --- |
| `TXBoard-Gateway` | Hono 协议层、安全中间件、SDK、运行指标、镜像发布 | Gateway 本仓库 |
| `TXBoard` (Laravel) | 真实用户鉴权、订单/资金状态、持久化幂等、主题配置、主题 Runtime v2 | 需独立 PR，先评审安全/迁移 |
| `TXBoard` (Vue 用户前端) | Gateway SDK 接入、只读灰度、主题演示、认证 UI | Gateway E2E 稳定后 |
| `TXBoard-Deploy` | 可选容器、代理路由、健康/回退、监控与 secrets 配置 | M1 staging PR，生产默认 off |
| Redis | 分布式限流、防重放短时状态、告警 | M2 引入；**不可作为唯一交易账本** |
| MySQL（由 Laravel 管理） | 用户与订单交易持久状态、唯一幂等记录 | M3，网关不直连 |
| CDN / Cloudflare | TLS、缓存策略、入站 WAF/防护 | 与 M1/M2 联动 |

### 7.1 必须先定下来的 ADR

- **ADR-001** 网关接入与回退边界：同域反代还是子域，trusted proxy、Gateway 与 Laravel 的认证关系。
- **ADR-002** 浏览器会话模型：现有 bearer 和 localStorage 的风险与后续可选 BFF/HttpOnly Cookie 迁移；SSR 安全边界。
- **ADR-003** 订单/支付幂等：Laravel 数据库约束、业务锁、存储窗口、冲突语义和旧 API 保护。
- **ADR-004** 可选密文协议：威胁模型、是否需要 HPKE、密钥生命周期、成本/性能与降级策略。
- **ADR-005** 独立主题 v2 manifest：兼容、资源执行信任模型、主题安装/回滚与权限。

决策须记录替代方案、风险、反对意见、恢复措施，不在 SDK 中私自引入永久安全协议。

### 7.2 提交、审查和验收规范

- 每个跨仓库功能必须列明依赖 PR，并使用契约测试 fixture 减少三个仓库版本不一致。
- 业务/加密/权限相关 PR 至少有正例、负例、并发/重试、故障恢复测试；敏感更改在未通过评审和 CI 前不得直接合并。
- 大版本变更先发行 pre-release 标签；旧 SDK/Gateway 主要版本在过渡窗口内受支持，制定明确的停止支持公告。
- 禁止跳过质量门禁、用 `any` 隐藏领域类型错误或仅凭生产截图认定成功。
- 每个 milestone 输出：技术说明、接口示例、测试报告、可回退部署文档、剩余风险列表、下个版本待办。

---

## 8. 下一迭代从哪里开始

**建议下一个 PR 只做 M1 的 GW-101 ～ GW-104，避免同时开启写订单和加密：**

1. 从 TXBoard Laravel + Vue 的真实响应建立脱敏 fixture 与契约 E2E，补全「200 业务失败/401/403/422/429/超时/超大响应」边界。
2. 增加生产可用的健康/readiness 检查、真实浏览器登录/账户/订单只读 smoke；测试环境只用临时账号。
3. 固定 npm lockfile 并使用 `npm ci`、镜像可复现构建、SDK 打包测试。
4. 设计 opt-in 反向代理部署和前端 adapter flag，记录一键回滚演练。

M1 真实联调可以按产品决策延期；M2 同进程中间件的开发可提前进行，但未通过正式 M1/M2 安全验收前不可生产启用新增敏感能力；只有 **M2 安全门禁 + Laravel 幂等设计**通过后，才允许实现并开放 M3 订单写入。加密始终作为可选增强，并须通过独立安全评审。

**完成定义：**文档或接口代码提交并不等于上线。Phase 1.5 联调完成时，必须提供有版本号的可运行环境、至少一个端到端演示、可复现测试报告和明确回滚路径。
