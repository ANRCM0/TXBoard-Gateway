# TXBoard Gateway 架构与信任边界

> 设计决策：2026-10-09。**目标架构已经确定，但模块化重构、路由策略引擎及新增防护尚未实现。** 当前真实能力与验证状态以 [开发状态台账](./development-status.md) 为准。实施细节、示例代码和验收矩阵见 [模块化中间件架构规范](./middleware-architecture.md)。

## 1. 核心决策（ADR：模块化单体）

采用 **一个 Node.js 22 / Hono / TypeScript 网关进程 + 同进程可组合中间件 + 静态注册的声明式路由策略 + Redis 共享安全状态**。

- 不将认证、限流、加密、数据适配拆为必须串联的多个 HTTP 微服务；多服务增加网络跳数、可用性和部署成本。
- 不支持主题或运维在运行时上传任意 JavaScript 中间件；扩展只能通过源码显式注册、代码审查和 CI。
- 不将所有中间件强制用于全部路径；强制的全局基线不可关闭，其余由**预定义、强类型策略**选择。
- Gateway 是 **协议/展示适配层**，不是 Laravel 的业务替代品、WAF、通用反向代理或独立交易后台。
- 重构采用**无行为变更优先**：保持 `/gateway/v1` 现有请求/响应契约、原先默认关闭的敏感功能和可回滚部署。

### 流量拓扑

```text
浏览器 / Luma / 独立主题
  -> HTTPS OpenResty / Nginx / 1Panel (TLS、基础 IP 限流、请求体上限)
      |-- /gateway/v1/* -> TXBoard Gateway (Hono, Docker 私网)
      |                      |-- 全局安全基线 + Request ID
      |                      |-- 路由策略分派
      |                      |-- 按需的限流 / Bearer / HPKE / Zod
      |                      |-- 固定上游 operation + 数据最小化
      |                      |-- Redis (nonce / 账户限流 / 有条件的 IP 风控)
      |                      +-- TXBoard Laravel API
      |
      +-- 原 /api/v1/*、/api/v2/*、/s/*、WebSocket、插件、
          节点、支付回调 -> 原 TXBoard 入口 -> Laravel
                                              -> MySQL / Laravel Redis
```

只有指定路径才转发至 Gateway；**不能**将默认反代、所有 `/api/*`、订阅链接或支付回调劫持到 Gateway。Gateway 无数据库连接、管理员 Token 和 Docker Socket，所有业务授权、用户订单归属、余额与交易幂等依旧由 Laravel 执行。

## 2. 五层逻辑职责（不是五个服务）

| 层次 | 责任 | 边界 |
| --- | --- | --- |
| L0 入口 | TLS、基础 IP 限流、Host/Body 上限、可信代理链 | 属于 OpenResty；源站仅接受可信入口 |
| L1 全局基线 | Request ID、脱敏观测、no-store、安全头、Origin/CORS、大小/超时 | 任意 Gateway API 都不能绕过；Origin 不是鉴权 |
| L2 路由安全 | 策略选择、IP/账户限流、Bearer 形态校验、可选 HPKE + Redis nonce | 用户真实权限、CAPTCHA 最终验证在 Laravel |
| L3 契约/业务适配 | Zod 参数与上游响应检查、静态路径 operation、DTO 字段白名单 | 不使用前端输入构建任意上游 host/path |
| L4 运维支撑 | Redis 安全状态、结构化脱敏日志、指标、liveness/readiness | 不存储密码、令牌、交易账本 |

处理顺序原则：**先执行低成本、无副作用的全局保护，再进行昂贵解密与访问上游**；身份归属和交易权限不可单靠 Gateway 判定。Hono `await next()` 形成洋葱式请求/响应顺序，响应观测在后置阶段执行。

## 3. 路由策略与数据边界

| 预设策略 | 路由示例 | 强制动作 | 缓存规则 |
| --- | --- | --- | --- |
| `publicRead` | `GET /bootstrap`、`/theme/config`、`/plans` | 全局基线、固定上游、公开字段过滤、Schema | 默认不缓存；审核后可对明确公开且无敏感数据的结果短缓存 |
| `userRead` | `/user/profile`、`/user/subscription/summary`、`/orders`、`/payments`、`/notices` | Bearer 形态检查 + Laravel 最终认证授权 + 响应最小化 | 不共享缓存 |
| `login` | `POST /auth/login` | 小请求体、Schema、入口/账户双层限流（规划）、Laravel CAPTCHA | 禁止缓存 |
| `secureAccount` | `POST /secure/auth/login`、`register`、`email-code` | 必须 HPKE+Redis nonce、对应账号限流、Schema、Laravel 最终验证 | 禁止缓存且无明文回退；注册/邮箱写仍默认关闭 |
| `disabledWrite` | `POST /orders` | 固定 405 | 不代理任何交易写入 |

策略应由服务端静态绑定路径和 HTTP 方法，不应信任客户端声明的策略名、capabilities、主题 manifest 或 header 来授予权限。新增策略必须附对应拒绝/绕过测试。当前各接口与既有 SDK 的行为以 [Gateway v1 契约](../contracts/gateway-v1.md) 为准。

## 4. 安全与运维约束

- **身份与代理：** 仅信任指定入口的转发来源；不直接使用未验证的 `X-Forwarded-For`，禁止把 Origin/Host 当作身份凭证，CSRF/Cookie 模式需另做 ADR。
- **限流：** 入口基础 IP 策略与 Gateway 账户/操作策略分层；当前 Redis 邮箱限流为登录 8 次/分钟、注册 3 次/10 分钟、邮箱验证码 2 次/10 分钟。IP 维度和调参体系尚未实现。
- **加密：** 已有 HPKE 请求加密技术预览；只保护请求体，非双向加密；必须 HTTPS。敏感路线 Redis 失效 fail-closed（503），重放拒绝（409）；密钥双版本轮换/吊销待实现。
- **响应与隐私：** 不写日志的字段包括 Authorization、密码、CAPTCHA、完整 email、原始 Token、请求/响应体和订阅私密链接；返回最少字段，不直接透传 Laravel 内部异常。
- **健康：** `/healthz` 仅 liveness；规划独立、内网可达的 `/readyz` 检查必需依赖和能力降级，不输出 Redis URL、密钥或内部配置。
- **故障：** 任何上游超时/限流不得放大为无限重试；订单和支付写入未获 Laravel 持久化幂等验收前不开放。
- **部署：** 推荐单容器起步，未来按需水平扩展相同的无状态 Gateway，所有副本共享 Redis/持久化私钥；不得开放 Gateway 8787 或 Redis 公网端口。

## 5. 迁移顺序与退出标准

1. **保契约重构：** 将现有 `app.ts` 中路由、适配、策略逻辑按目录拆分；保持路由、状态码、默认开关和 SDK 行为不变；现有 CI 回归全绿。
2. **固定策略：** 建立默认拒绝的路由策略注册表，定义全局不可跳过的强制防护、正/负例与故障注入测试。
3. **强化安全与可观测：** 可信代理、双层限流、日志脱敏、readiness、Redis/密钥生命周期和指标；无配置时安全失败。
4. **真实隔离联调：** TXBoard Laravel/MySQL/Redis、真实 CAPTCHA、浏览器、代理与回滚验收。按产品决策可延期开发验证，但生产前绝不可省略。
5. **主题接入：** Luma 先走公开与只读接口，SDK feature flag 可回到原 API；跨主题、SSR 与缓存一致性通过后再推广。

**退出条件：** 代码/模拟 CI 通过≠真实 Staging 验收≠生产安全许可。详细任务 GW-210～GW-218 见 [任务矩阵](./task-backlog.md)，证据必须记录在 [状态台账](./development-status.md)。
