# TXBoard Gateway 模块化中间件架构规范

> **Status: Accepted as development target / NOT implemented（2026-10-09）**。本文定义未来重构的约束和验收准则；示例是设计草案，不代表当前 Gateway 已具备动态策略引擎或 IP 风控。现状见 [development-status](./development-status.md)。这是开发规范，不是生产审计报告。

## 1. 为什么选择模块化单体

**选型：Node.js 22 + Hono + TypeScript + 路由级声明式策略 + Redis 安全状态。** Hono middleware 在同一 HTTP 请求中串联执行、`await next()` 返回后逆序处理响应；不会把每层变成单独网络进程。

| 选项 | 结论 | 原因 |
| --- | --- | --- |
| 一个 Hono 实例内静态组合中间件 | **采用** | 一个入口、一套生命周期、可类型检查、无多余内部 HTTP 跳转 |
| 多个 Gateway 服务串联 | 暂不采用 | 新增 RTT、失败链路、配置漂移和跨服务跟踪成本 |
| 运行时从主题/面板上传任意 JS 插件 | **禁止** | 任意代码执行、供应链与权限问题；插件不应获得 secrets |
| 预定义策略配置 | **采用** | 各路由有清晰安全前置；核心防护由框架强制并有测试 |
| 多副本水平扩容 | 有条件采用 | 需要共享 Redis、同一 HPKE 秘钥配置及负载/故障验证 |

## 2. 生命周期与安全边界

```text
Edge: TLS -> 基础 IP 频控 -> Body/Host 限制 -> Gateway 私网
Gateway:
  [全局 before]  requestId -> security headers/no-store -> origin policy
  [路由 before]  便宜的入口限流 -> 路由政策 -> bearer 形态或密文 envelope
                 -> 仅 secure 路由 HPKE 解密与 nonce 预留
                 -> 参数 Zod -> 账户限流 -> 固定 upstream operation
  [业务]         Laravel 最终鉴权、对象归属、CAPTCHA、数据/交易规则
  [路由 after]   严格 DTO 转换与响应 Zod；明确 error code
  [全局 after]   脱敏计时与 metrics -> response
```

不是所有动作都作为单独 Hono middleware：**参数校验、令牌转换、业务 DTO 允许保留在 handler/adapter 中**，以避免过度抽象。将强制安全基线写在路由文件之外，禁止路由自行关闭。

### 2.1 全局基线（每次 API 调用）

- 接收边缘限制后的请求，生成 `requestId`；输出统一 envelope、`Cache-Control: no-store` 和与部署匹配的安全响应头。
- 校验 Origin 的精确 allowlist；无 Origin 不代表授权（非浏览器请求必须由 Token/Laravel 权限保护）。
- 设定/继承请求体与响应大小、上游超时边界；拒绝未知路径、方法、重定向与任意 host。
- 注入**仅结构化、脱敏的**观察点；仅记录 requestId、路由模板、HTTP 状态、耗时、错误码、有限枚举标签，不记录请求体、原始 URL 查询、完整 IP/email 或 auth header。
- 如果启用可信 IP，必须由网络拓扑与 proxy CIDR/固定源验证后的地址提供，绝不直接从不可信 header 获取。

### 2.2 每种路由的调用链

| 策略 | 请求管线（按执行次序） | 必须保持 |
| --- | --- | --- |
| `publicRead` | baseline -> request schema -> allowlisted fetch -> public DTO/response schema | 无 Bearer 自动透传、无 HPKE、无 Redis 硬依赖 |
| `userRead` | baseline -> Bearer 格式 -> request schema -> Laravel Bearer 授权 -> DTO | Laravel 判定用户/订单归属；无共享缓存 |
| `login` | baseline -> edge/IP guard -> request schema -> 可用时 Redis 账号限流 -> Laravel login/CAPTCHA | 仍保留既有明文登录路径的兼容性，不用 HPKE 升级作悄然破坏 |
| `secureLogin` | baseline -> edge/IP guard -> sealed schema -> HPKE open + nonce -> 解密数据 schema -> 账号限流 -> Laravel login | Redis 故障 503；不自动降级到明文 |
| `secureRegister` / `secureEmailCode` | baseline -> edge/IP guard -> sealed schema -> HPKE/nonce -> 注册或发码 schema -> 账号限流 -> Laravel | 默认关闭；未完成真实 CAPTCHA/邮件验收不得生产放量 |
| `disabledWrite` | baseline -> 405 | 绝不透传订单、扣款、checkout、callback |

对需要账号标识才能限流的操作，**先做不依赖解密的边缘/IP 控制，再执行解密和 nonce，最后执行账号限流**；保留每次请求的成本上界。IP 策略与可信代理未实施前不得声称具备 IP+账号联合保护。

### 2.3 洋葱模型与错误处理

- `await next()` 前执行「请求进入」验证，之后做「响应返回」脱敏计时和有限头部处理；后置逻辑必须在拒绝/错误情况下也可靠执行。
- 429 应明确归属于哪个限流策略，并在正式引入后包含可用的 `Retry-After`；不得在异常时静默放行敏感操作。
- 400/401/403/404/405/409/413/422/429/500/502/503/504 与 [现有契约](../contracts/gateway-v1.md) 保持语义兼容；禁止回显 Laravel 错误栈或任意对象。
- 对上游仅允许固定命名 `operation`，重定向禁止跟随；HTTP 200 中的 Laravel `status:fail` 仍应映射为失败。

## 3. 声明式路由策略（建议 TypeScript 结构）

策略表属于**编译期只读定义**，而不是运行时任意 JSON。下例仅描述未来 API，不能直接当作已实现模块调用：

```ts
type PolicyName =
  | 'publicRead'
  | 'userRead'
  | 'login'
  | 'secureLogin'
  | 'secureRegister'
  | 'secureEmailCode'
  | 'disabledWrite'

type RoutePolicy = Readonly<{
  name: PolicyName
  auth: 'none' | 'bearer'
  body: 'none' | 'json' | 'hpke'
  limiter: 'none' | 'public' | 'login' | 'register' | 'email-code'
  cache: 'off' | 'public-short'
}>

const routeDefinitions = [
  { method: 'GET', path: '/gateway/v1/plans', policy: 'publicRead' },
  { method: 'GET', path: '/gateway/v1/user/profile', policy: 'userRead' },
  { method: 'POST', path: '/gateway/v1/auth/login', policy: 'login' },
  { method: 'POST', path: '/gateway/v1/secure/auth/register', policy: 'secureRegister' },
  { method: 'POST', path: '/gateway/v1/orders', policy: 'disabledWrite' },
] as const
```

约束：`auth: none` 不代表匿名访问可调用 Laravel 管理功能；`secureRegister` 必须依赖 HPKE/Redis/feature flag，不能被单个布尔字段解锁。策略校验应拒绝非法组合，例如 `body: hpke` 搭配缺失 replay store、`userRead` 搭配共享缓存、`disabledWrite` 搭配 upstream 写入。

**强制不可覆盖项：** 全局 baseline、静态上游白名单、Laravel 权威权限、响应/日志敏感信息过滤、支付写入禁用；策略不得通过 HTTP 请求头、theme manifest、客户端 capability 或数据库主题配置动态决定。

## 4. 建议代码目录（目标态，不是现状）

```text
apps/gateway/src/
  index.ts                  # 启动/关闭及依赖装配
  app.ts                    # 唯一 Hono 实例、全局 error handler
  config/
    env.ts                  # 已存在 env.ts 的迁移目标
    policies.ts             # 编译期策略与非法组合校验
  middleware/
    request-context.ts      # requestId、安全默认头
    security.ts             # origin、可信入口、请求大小
    rate-limit.ts           # 入口与账户策略
    auth.ts                 # Bearer 形态检查；非业务授权
    encryption.ts           # 仅 secure* HPKE envelope + nonce
    validation.ts           # 可复用的参数/返回 Schema
    observability.ts        # metrics、脱敏结构化事件
  routes/
    public.ts
    account.ts
    user.ts
    orders.ts
  adapters/
    txboard-v1.ts           # 上游 response -> 公共 DTO
  services/
    upstream.ts             # 当前 upstream.ts 迁移目标
    crypto.ts               # 当前 crypto.ts 迁移目标
    redis-security.ts       # 当前 redis-security.ts 迁移目标
  contracts/
    schemas.ts
```

职责规则：`routes` 不直接连 Redis/上游任意 URL；`services` 不持有用户界面语义；`adapters` 无副作用且不向客户端返回原始内部字段；`middleware` 不创建 Laravel 业务权限。不因迁目录而立即改变现有 SDK 的 exports、HTTP URL 或 JSON 字段。

## 5. 安全能力与故障策略

| 场景 | 规划响应 | 验证要求 |
| --- | --- | --- |
| 未知 Origin | 403；CORS 不反射 | 带/不带 Origin，跨域预检 |
| 无 Bearer 的用户接口 | 401 | Token 缺失与畸形 |
| X-Forwarded-For 伪造 | 不可操纵真实客户端 IP 判定 | 可信/非可信代理链模拟 |
| 加密 nonce 重放 | 409，Laravel 不触发第二次 | 同 nonce 并发及跨副本 |
| 安全 Redis 故障 | 加密操作 503，不用进程本地兜底 | 断线、切主、容量耗尽 |
| Laravel 超时/非 JSON/重定向 | 受控 502/504 | 负向契约测试 |
| 原始订阅令牌/支付私密字段 | 绝不返回 | 响应快照+泄漏扫描 |
| 管理端/节点/支付回调 | Gateway 不接入 | 路径绕过/负例 |
| 订单 POST | 固定 405 | 不发生上游交易副作用 |

Redis 限流键不应出现明文账户标识。当前项目用 SHA-256(email)；改用服务器持有的键做 HMAC 是**设计建议**，须考虑旧键窗口、密钥轮换、迁移与误伤测试；不能把哈希声明为匿名化。对未公开且本应禁用的账户写操作不得使用缓存或自动重试。HPKE 密钥多 kid 轮换与 Redis 切主保护仍是独立 P0 工作。

## 6. 性能与缓存准则

- 同进程中间件是默认方案，避免每层单独开一个 HTTP 服务。
- 公共请求不执行用户 Token 检查/HPKE/Redis 安全写入；只有安全政策需要时才使用 Redis。
- 上游使用稳定连接复用、明确总超时和严格响应大小；不可因聚合请求制造 N+1 网络请求。
- **缓存不是第一阶段默认行为。** 仅在验证响应字段完全公开后考虑对 `plans` 和公开配置实行候选 15–60 秒 TTL，需支持配置变更失效；CAPTCHA 配置也必须验证一致性。
- 订单、账户、订阅概要、支付方式的用户特有数据默认 `no-store`，不得写入共享公共缓存。
- 观测请求总 p50/p95/p99、Gateway 自身耗时、Laravel 上游耗时、状态码、429、503、Redis/HPKE 耗时与进程资源；不加入用户数据标签。
- 候选目标：相同压测负载下额外网关 p95 ≤ 30ms（不含上游）；**只是拟议验收线，不是已测 SLO**。

## 7. 渐进迁移计划（按 PR 拆分）

| 顺序 | 开发包 | 完成标准 | 回滚 |
| --- | --- | --- | --- |
| PR-A | 目录重构与 adapter 纯函数抽取 | 现有 URL、DTO、状态码、功能开关逐项一致；类型/单测/浏览器 mock CI 绿 | 回退提交，不动 Laravel |
| PR-B | 声明式编译期路由策略 | 静态 policy 表、非法组合拒绝、每路由策略快照与拒绝测试 | feature flag/代码回退 |
| PR-C | 可信代理/入口保护 + Redis 策略强化 | 伪造 IP/Origin 无法绕过；多实例 Redis 行为可复现；敏感故障关闭 | 关新增能力，旧端点保持保护 |
| PR-D | 可观测性与 readiness | 无秘密日志、指标可用、依赖状态不暴露公网 | 关闭指标输出/回退部署 |
| PR-E | 真实 Staging + Luma 接入 | Laravel/MySQL/Redis/CAPTCHA + feature flag + 回滚全证据 | 先关 SDK flag，再撤代理，最后停 Gateway |

PR-A/B 可以在真实联调延期期间进行；PR-C/D 可继续工程开发，但 **PR-E 和正式生产批准不能靠 mock CI 替代**。

## 8. 测试与验收矩阵（必做）

- [ ] 旧版 v1 请求/响应 golden fixtures、错误码和 SDK 调用完全一致，无上游新增路径。
- [ ] 全局保护不可被新的路由策略绕过；未知路径/方法/Host/Origin 严格拒绝。
- [ ] 公共接口无 Authorization；用户接口只向对应 Laravel 用户路由发送 Bearer；订单归属由 Laravel 验证。
- [ ] 密文账户操作只在启用 HPKE + Redis + 配套开关时注册；重放、错误 AAD、时间漂移、Redis 掉线按现有错误语义拒绝。
- [ ] Hono 洋葱中间件的 before/after 与错误路径均有测试，响应头与脱敏日志无遗漏。
- [ ] 双层限流及假 IP 模拟测试（新增功能落地时）；邮箱维度误伤与恢复策略明确。
- [ ] Docker 无新增公网端口/管理员凭据/数据库直连；多实例共享状态和关闭启动可审计。
- [ ] 真实 Staging 通过再声明集成完成；Luma 关闭 feature flag 后仍能运行旧 API。
- [ ] 上线前完整独立安全审查、依赖故障注入、性能/回滚测量；支付写入另做 Laravel 交易幂等验收。

相关文档：[总体架构](./architecture.md) · [路线图](./roadmap.md) · [任务矩阵](./task-backlog.md) · [部署](./docker-deployment.md) · [HTTP 契约](../contracts/gateway-v1.md)。
