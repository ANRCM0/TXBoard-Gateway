## 1. 设计原则

### 1.1 与 v1 的兼容性策略

| 维度 | v1（`/gateway/v1/*`） | v2（`/txapi/*`） | 策略 |
| --- | --- | --- | --- |
| 路径命名空间 | `/gateway/v1` | `/txapi` | **改变**：独立命名空间 `/txapi`，彻底避开 Xboard `/api/v1` 与 `/api/v2` |
| 响应 envelope | `{ok, data\|error, meta}` | 同构，`meta.version` 由 `'1'` 变为 `'txboard-v1'` | **保持不变**（结构逐字段一致） |
| 认证 | `Authorization: Bearer <token>` | 同格式；新增**可选 scope 前缀约束**（见 1.3） | **复用**，向后兼容 |
| 上游协议 | Laravel `/api/v1/*` | Laravel `/api/v2/*` | **改变**：白名单整体迁移到 TXBoard 自有 v2 路由 |
| 分页 | `{data,total}` | `{items,total,current,pageSize}` | **改变**（破坏性，仅 v2 客户端受影响） |
| 字段命名 | 混合 `snake_case` 直出 | 统一 `camelCase`，DTO 层显式转换 | **改变**（破坏性） |
| 校验 | zod fail-closed | 同机制、同 fail-closed 语义 | **保持不变** |
| Origin 白名单 / CORS | 精确匹配 | 同一 `allowedOrigins` 配置 | **保持不变** |
| HPKE 加密通道 | 有 | 有（AAD 绑定 `txapi/...` 路径） | **复用机制，AAD 变更** |
| 限流 | Redis 计数 + 键前缀 `txbgw:v1:*` | 同实例、键前缀 `txbgw:v2:*`，策略表扩展 | **复用基础设施，键与策略分版** |
| 可观测性 | `operation` 标签含路径 | 自动派生，无需改动指标体系 | **保持不变** |

原则：
- **v1 代码冻结**：v2 落地期间 v1 只修安全缺陷，不加功能。
- **共享一切非契约部分**：Bootstrap/Origin/CORS、HPKE、Redis、metrics、日志、fail-closed 校验、`upstreamRequest` 骨架全部复用，不为 v2 复制第二套传输层。
- **契约差异收敛在 DTO 层**：v2 的命名/分页规范化在 `upstream.ts` 之后、`success()` 之前的薄 DTO 层完成，handler 不直接吐上游原始字段。
- **Gateway 边界不扩大**：仍不代理任意路径、不直连 DB、不持有管理员 token（见 §4 边界）。

### 1.2 路径设计规则（`/txapi/*`）

完整对外路径 = `/txapi`（TXBoard API 命名空间） + 业务路径。
代码中常量 `const PREFIX_V2 = '/txapi'`，文档/契约中简写 `/txapi/*`。

- 资源复数、小写、`kebab-case`：`/plans`、`/orders`、`/knowledge/articles`。
- 层级不超过两级；子资源动作用动词短语末段：`/nodes/{id}/diagnose`、`/actions/{id}/verify`。
- 禁止动词开头资源段（`getXxx`、`fetchXxx` 一律废弃）；`GET`=读，`POST`=写/动作，**不引入 PUT/PATCH/DELETE**（与 v1 的 `GET, POST, OPTIONS` CORS 集合保持一致，降低网关/浏览器面）。
- 查询参数白名单制（同 v1：未知参数 400），分页参数统一 `current` / `pageSize`。
- 路径参数正则同 v1（`/^[a-zA-Z0-9_-]{1,128}$/`），超长一律 `:id` 化后再打点（保护指标基数）。

### 1.3 认证与授权

- **Token 格式复用**：Passport 签发的 `Bearer <token>` 在 v2 直接可用（同一 Laravel 应用、同一 `user` 中间件家族），迁移期客户端**零改造**即可切前缀。
- **校验位置不变**：Gateway 只做形态校验（`/^Bearer \S{8,4096}$/`）并计算 `subjectRef`（加盐哈希，审计用），**真实权限仍以 Laravel 为准**。
- **v2 扩展：scope 声明**。v2 引入三类 subject，Gateway 依据 token 声明的 scope（Laravel 登录/签发时写入，例如 `user` / `agent:<id>` / `machine:<id>`）做路由准入：
  - `user` scope → `/txapi/user/*`、`/txapi/orders`、`/txapi/plans`、`/txapi/notices` 等；
  - `agent:<id>` scope → `/txapi/agent/*`（运维 Agent 专属，上游中间件 `agent` + `agent.log`）；
  - `machine` scope → **不经过 Gateway**（上游 `server.v2` 心跳/上报直连，保持与 v1 一致的边界）。
- **fail-closed**：无法判定 scope 的 token 在 v2 直接 401（`INVALID_TOKEN_SCOPE`），不允许"先放行再让上游判"。
- **管理员 token 依旧禁止**进入 Gateway（v1 合同红线，v2 继承）。管理面 API（`admin/{admin_path}/*`）保持管理员直连 Laravel，不经 Gateway（理由见 §3.4）。

### 1.4 错误处理（envelope + 扩展错误码）

结构不变：

```jsonc
// 成功
{ "ok": true,  "data": {}, "meta": { "version": "txboard-v1", "requestId": "<uuid>" } }
// 失败
{ "ok": false, "error": { "code": "…", "message": "…" }, "meta": { "version": "txboard-v1", "requestId": "<uuid>" } }
```

- HTTP 状态集合**不扩大**（复用 v1 的 400/401/403/404/405/409/413/422/429/500/502/503/504），保证现有 SDK/监控的分类器无需改造。
- **错误码**在 v1 全量保留的基础上**追加** v2 专属码（`error.code` 为字符串，追加不破坏旧客户端）：

| 新增错误码 | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_TOKEN_SCOPE` | 401 | token scope 与路由要求不符（如 user token 访问 agent 路由） |
| `AGENT_PAIRING_REQUIRED` | 403 | agent 未完成配对/绑定即调用运维接口 |
| `FEATURE_DISABLED` | 404 | 上游对应 v2 能力未启用（如知识库模块关闭） |
| `ACTION_PENDING_APPROVAL` | 202→409 | 高危节点动作已进入审批队列（v2 用 409 + 该码表达"已受理待批"） |
| `PAGINATION_INVALID` | 400 | 分页参数越界（v2 显式化，替代 v1 的通用 `VALIDATION_ERROR` 兜底） |
| `UPSTREAM_CONTRACT_MISMATCH` | 502 | 上游 v2 响应未通过 DTO fail-closed 校验 |

- 上游错误正文仍**不透传**（`publicErrorMessage` 沿用），仅暴露规范 code/message。
- 一处有意的破坏性变更：v2 成功分页体从 `{data,total}` 改为 `{items,total,current,pageSize}`；`meta.version` 成为客户端判别依据，SDK 必须按 version 分派解析器。

### 1.5 限流策略（复用 Redis 滑动窗口）

- **复用同一 Redis 实例与 fail-closed 语义**：Redis 不可用即 503，绝不静默放行（继承 `RedisSecurity`）。
- **键分版**：`txbgw:v2:replay:*` / `txbgw:v2:rate:*`，与 v1 键空间隔离，可独立清理、独立评估，互不挤占配额。
- **策略表扩展**（`AccountAction` 之外新增 `subject` 维度，键主体从 email 哈希改为 `subjectRef` 哈希，避免把 email 语义扩散到全端点）：

| action | 主体 | 限额 | 窗口 | 说明 |
| --- | --- | --- | --- | --- |
| `login` | email 哈希 | 8 | 60s | 与 v1 相同 |
| `register` | email 哈希 | 3 | 600s | 与 v1 相同（默认关闭） |
| `email-code` | email 哈希 | 2 | 600s | 与 v1 相同（默认关闭） |
| `user-read` | subject 哈希 | 120 | 60s | 新增：用户态读端点统一配额 |
| `order-query` | subject 哈希 | 60 | 60s | 新增：订单类查询（含 tradeNo 查询） |
| `agent-ops` | subject 哈希 | 120 | 60s | 新增，对齐上游 `throttle:120,1` |
| `agent-pairing` | 未认证 + IP | 10 | 60s | 对齐上游 `throttle:10,1` |
| `traffic-settlement` | subject 哈希 | 30 | 60s | 新增：结算/流量日志为重查询 |
| `knowledge-read` | subject 哈希 | 120 | 60s | 新增：知识库公开读 |

- **滑动窗口实现**：v1 现为固定窗口（`INCR`+`PEXPIRE`，atomic Lua）。v2 建议同一 `RedisSecurity` 类内新增**双桶滑动窗口**（当前桶 + 前一桶按时间加权），对 `user-read`/`agent-ops` 这类高频读端点启用，写端点继续固定窗口。若保持最小改动，也可首版直接复用固定窗口、仅分键分策略——**二选一，PR 中显式记录**。
- 命中限流返回 429 + `RATE_LIMITED`，并计入 `METRICS.rateLimit` / `flowControlRejections`（指标定义零改动，`action` 标签自动带上新策略名）。

---

## 2. 路由矩阵

> 前缀：表中"路径"均指 `/txapi` 之后的部分。**认证列**：`public`=无需 token；`bearer(user)`=user scope；`bearer(agent)`=agent scope。
> "上游操作"列给出 TXBoard Laravel v2 路由（已存在于 `TXBoard/api/app/Http/Routes/V2/`）或 Gateway 本地派生；与 v1 的映射列为 `新增 / 对应 / 修改 / 移除`。

### 2.1 公共与引导（Guest）

| 方法 | 路径 | 认证 | 上游操作（Laravel v2） | 与 v1 映射 |
| --- | --- | --- | --- | --- |
| GET | `/bootstrap` | public | `GET /api/v2/guest/comm/config` | **修改**：同一份 config 经新 DTO（camelCase），`meta.version` 变更；`capabilities` 列表刷新为 v2 能力名 |
| GET | `/theme/config` | public | 同上（本地二次投影） | **对应**，DTO 规范化 |
| GET | `/plans` | public | `GET /api/v2/guest/plan/fetch` | **对应**；金额仍为 Laravel 分单位，字段 camelCase |
| GET | `/knowledge/articles` | public | `GET /api/v2/knowledge/...`（若上游未暴露则 404 `FEATURE_DISABLED`） | **新增**：TXBoard 独有知识库公开读（列表 + 详情 `/knowledge/articles/{id}`） |

> 注：TXBoard v2 `GuestRoute` 目前只映射 `comm/config`。`/plans`、`/knowledge/*` 需要上游新增薄路由（见 §5.2 "上游前置项"），否则 Gateway 侧 fail-closed 返回 `FEATURE_DISABLED`，避免静默降级为空数组。

### 2.2 认证（Passport）

| 方法 | 路径 | 认证 | 上游操作 | 与 v1 映射 |
| --- | --- | --- | --- | --- |
| POST | `/auth/login` | public | `POST /api/v2/passport/auth/login` | **对应**：请求 schema 与 v1 一致；响应新增 `scope` 字段（DTO 投影自上游） |
| POST | `/crypto/key` | public | Gateway 本地（HPKE 公钥发现） | **对应**，`scope` 固定为 `txboard-v1` |
| POST | `/secure/auth/login` | public | `POST /api/v2/passport/auth/login` | **对应**：AAD 绑定 `txapi/secure/auth/login`，v1 密文**不可**跨版本重放 |
| POST | `/secure/auth/register` | public（默认关闭） | `POST /api/v2/passport/auth/register` | **对应**，AAD/开关语义同 v1 |
| POST | `/secure/auth/email-code` | public（默认关闭） | `POST /api/v2/passport/comm/sendEmailVerify` | **对应** |
| POST | `/auth/refresh` | bearer(user) | v2 token 续期（若上游未提供则首版省略） | **新增（可选）**：减少 v1→v2 迁移窗口内的掉线 |

### 2.3 用户与订阅（User）

| 方法 | 路径 | 认证 | 上游操作 | 与 v1 映射 |
| --- | --- | --- | --- | --- |
| GET | `/user/profile` | bearer(user) | `GET /api/v2/user/info` | **修改**：`email` 必填 fail-closed，其余 camelCase（`createdAt`、`planId` 等） |
| GET | `/user/subscription/summary` | bearer(user) | `GET /api/v2/user/getSubscribe` | **对应**：仍刻意不返回 `token/uuid/subscribe_url` |
| GET | `/dashboard/stats` | bearer(user) | `GET /api/v2/user/getStat` | **对应**：`{unpaidOrders,openTickets,invitedUsers}` 三元组不变 |
| GET | `/user/reset-security` | bearer(user) | `GET /api/v2/user/resetSecurity` | **新增**：v1 未暴露的安全重置（TXBoard v2 `UserRoute` 已有） |

### 2.4 订单与支付（Commerce，用户态）

| 方法 | 路径 | 认证 | 上游操作 | 与 v1 映射 |
| --- | --- | --- | --- | --- |
| GET | `/orders` | bearer(user) | `GET /api/v2/user/order/fetch` | **修改**：body 改为 `{items,total,current,pageSize}`；`status` 白名单保留 |
| GET | `/orders/{tradeNo}` | bearer(user) | `GET /api/v2/user/order/detail` | **对应** |
| GET | `/orders/{tradeNo}/status` | bearer(user) | `GET /api/v2/user/order/check` | **对应** |
| GET | `/payments` | bearer(user) | `GET /api/v2/user/order/getPaymentMethod` | **对应**：仅展示字段 |
| POST | `/orders` | — | — | **移除**：v2 首版即不注册该 405 占位路由；未实现能力由 `notFound → NOT_FOUND` 表达（v1 的 405 占位是过渡产物，不带入 v2） |
| POST | `/coupons/redeem` | bearer(user) | v2 优惠券核销（上游存在则挂，否则 `FEATURE_DISABLED`） | **新增（TXBoard 独有）** |

### 2.5 通知与内容

| 方法 | 路径 | 认证 | 上游操作 | 与 v1 映射 |
| --- | --- | --- | --- | --- |
| GET | `/notices` | bearer(user) | `GET /api/v2/user/notice/fetch` | **修改**：分页体改为 `{items,total,current,pageSize}`，pageSize 上限 100 不变 |
| GET | `/knowledge/articles`、`/knowledge/articles/{id}` | public | 见 2.1 | **新增** |

### 2.6 Agent 运维（TXBoard 独有，v1 完全没有）

> 上游 `V2/AgentRoute.php` 已有完整实现，Gateway 只做形态校验 + scope 准入 + 限流，不复制业务逻辑。

| 方法 | 路径 | 认证 | 上游操作 | 与 v1 映射 |
| --- | --- | --- | --- | --- |
| POST | `/agent/pairings/redeem` | public | `POST /api/v2/agent/pairings/redeem` | **新增**（限流 `agent-pairing`，10/60s，IP+subject 双主体） |
| GET | `/agent/whoami` | bearer(agent) | `GET /api/v2/agent/whoami` | **新增** |
| GET | `/agent/system/status` | bearer(agent) | `GET /api/v2/agent/system/status` | **新增** |
| GET | `/agent/machines` | bearer(agent) | `GET /api/v2/agent/machines` | **新增** |
| GET | `/agent/nodes` | bearer(agent) | `GET /api/v2/agent/nodes` | **新增** |
| GET | `/agent/nodes/{nodeId}/metrics` | bearer(agent) | `GET /api/v2/agent/nodes/{nodeId}/metrics` | **新增** |
| GET | `/agent/nodes/{nodeId}/diagnose` | bearer(agent) | `GET /api/v2/agent/nodes/{nodeId}/diagnose` | **新增** |
| GET | `/agent/fleet/health` | bearer(agent) | `GET /api/v2/agent/fleet/health` | **新增** |
| GET | `/agent/inspections` | bearer(agent) | `GET /api/v2/agent/inspections` | **新增** |
| GET | `/agent/nodes/{nodeId}/remediation` | bearer(agent) | `GET /api/v2/agent/nodes/{nodeId}/remediation` | **新增** |
| GET | `/agent/nodes/{nodeId}/timeline` | bearer(agent) | `GET /api/v2/agent/nodes/{nodeId}/timeline` | **新增** |
| GET | `/agent/traffic/summary` | bearer(agent) | `GET /api/v2/agent/traffic/summary` | **新增** |
| GET | `/agent/queue/status` | bearer(agent) | `GET /api/v2/agent/queue/status` | **新增** |
| GET | `/agent/audit` | bearer(agent) | `GET /api/v2/agent/audit` | **新增** |
| POST | `/agent/nodes/{nodeId}/actions` | bearer(agent) | `POST /api/v2/agent/nodes/{nodeId}/actions` | **新增**：高危写，命中 `agent-ops` 限流 + 全量审计 |
| GET | `/agent/actions/{requestId}` | bearer(agent) | `GET /api/v2/agent/actions/{requestId}` | **新增** |
| GET | `/agent/actions/{requestId}/verify` | bearer(agent) | `GET /api/v2/agent/actions/{requestId}/verify` | **新增** |
| GET | `/agent/support/tickets`（及 `/{ticketId}`、`reply-requests` 等） | bearer(agent) | `GET /api/v2/agent/support/...` | **新增**：Agent 代客工单协查（只读 + 审批流） |

### 2.7 流量结算（TXBoard 独有）

> 上游 `V2/Admin/SystemRoute.php` 已有 `traffic-reset` 模块（admin 域）。Gateway v2 暴露其**用户自服务读**子集，管理写操作不进 Gateway。

| 方法 | 路径 | 认证 | 上游操作 | 与 v1 映射 |
| --- | --- | --- | --- | --- |
| GET | `/traffic/settlement/logs` | bearer(user) | `GET /api/v2/traffic-reset/logs`（需上游加 user 态视图或带 `user_id=self` 语义） | **新增**：当前用户流量重置/结算流水 |
| GET | `/traffic/settlement/stats` | bearer(user) | `GET /api/v2/traffic-reset/stats` | **新增**：当月重置统计 |
| GET | `/traffic/settlement/history` | bearer(user) | `GET /api/v2/traffic-reset/user/{userId}/history` | **新增**：仅允许 `userId = 自身 id`（Gateway 强制，否则 403 `ORIGIN_DENIED`→用 `ACCESS_DENIED`） |

> 上游前置项：`traffic-reset` 目前在 admin 前缀下。Gateway 要暴露用户态读，需上游在同一控制器补 user 中间件路由（`V2/TrafficResetController` 增加 `user` 组映射）。首版若上游未就绪，Gateway 返回 `FEATURE_DISABLED` 404 并在 `capabilities` 中不声明 `traffic.settlement.*`。

### 2.8 主题配置（TXBoard 独有）

| 方法 | 路径 | 认证 | 上游操作 | 与 v1 映射 |
| --- | --- | --- | --- | --- |
| GET | `/theme/config` | public | `guest/comm/config` 投影 | **对应**（见 2.1） |
| GET | `/theme/manifest` | public | `GET /api/v2/theme/getThemes`（或本地 manifest 聚合） | **新增**：主题清单 + 版本 + 兼容 Gateway 契约版本 |
| GET | `/theme/config/effective` | bearer(user) | `GET /api/v2/theme/getThemeConfig`（按当前用户组/套餐生效值） | **新增**：按用户维度解析后的生效配置（v1 只有全局投影） |
| POST | `/theme/config` | bearer(user) | `POST /api/v2/theme/saveThemeConfig` | **新增（受限）**：仅允许保存"用户级偏好"白名单键（如 `theme_config.preferences`），**绝不放行**全局主题写；非白名单键 400 `VALIDATION_ERROR` |

### 2.9 客户端 App 与健康

| 方法 | 路径 | 认证 | 上游操作 | 与 v1 映射 |
| --- | --- | --- | --- | --- |
| GET | `/client/app/config` | bearer(user) | `GET /api/v2/client/app/getConfig` | **新增** |
| GET | `/client/app/version` | bearer(user) | `GET /api/v2/client/app/getVersion` | **新增** |
| GET | `/healthz` | public | Gateway 本地 | **对应**（`contract` 字段返回 `txboard-v1`） |
| GET | `/metrics` | bearer(metrics token)/loopback | Gateway 本地 | **对应** |


---

## PR1 实施状态（实现说明）

本合同的 §1–§2 为设计草案原文（只读底稿）。当前 PR（PR1 基础设施）已落地：

- `PREFIX_V2 = "/txapi"`，`meta.version = "txboard-v1"`（`middleware/request-context.ts`）。
- 路由表：`GET /txapi/healthz`（Gateway 本地，`publicRead`，无上游操作），其余路由按后续 PR 逐个追加。
- `GATEWAY_ENABLE_V2`（默认 `true`）、`GATEWAY_V2_FEATURES`（能力灰度）。
- Redis 键分版 `txbgw:v1:*` / `txbgw:v2:*`；HPKE AAD 前缀按 surface 参数化（v1 密文不可用于 v2 路径）。
- v2 上游白名单（`allowlistedPathsV2`）首版为空：任何未注册的上游操作都必须 fail-closed，缺失上游路由表达为 `FEATURE_DISABLED`，绝不静默降级。

> 注：本文件作为 v2 合同文档，随各 PR 演进；v1 合同 `gateway-v1.md` 冻结不改。
