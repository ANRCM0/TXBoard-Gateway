# ADR：checkout/cancel 交易状态机（GW-305）

- 状态：**已提出，待评审**
- 日期：2026-10-11
- 责任：TX（Laravel 主仓库实现）+ GW（Gateway 适配，仅设计不实现路由）
- 关联任务：[task-backlog.md](./task-backlog.md) GW-305（本文档）；依赖 GW-302（[订单幂等 ADR](./adr-order-idempotency.md)）、GW-303（事务幂等实现）；下游 GW-306（支付回调沙箱）、GW-309（灰度验收）
- 前置依赖：GW-302 契约已修订；GW-303 TXBoard 订单创建实现见 PR #217（需 CI / 真并发验收）。checkout/cancel 尚未实现，未来复用同一 `idempotency_keys` 表。

## 1. 背景与问题

- GW-302 解决了"订单创建不重复落单"，但**交易侧还有两个资金相关的写操作**：`checkout`（对既有订单发起支付结算）与 `cancel`（取消未支付订单）。两者都会改变订单状态并触及余额/优惠券核算，必须与 `order.create` 同等的幂等与状态机保护。
- TXBoard 现有订单状态（`ORDER_STATUSES = {'0','1','2','3'}`，来自 `middleware/request-context.ts`，用于只读 `status` 查询）语义按 TXBoard 既有约定为：`0` 待支付 / `1` 开通中（已支付待生效）/ `2` 已取消 / `3` 已完成。**注意**：`checkout` 在本 ADR 中的终态 `paid` 即映射为上游状态 `1`，不是新状态。
- Gateway 现状：`POST /gateway/v1/orders` 在 `orderWrite` 策略下仅映射唯一上游 operation `userOrderCreate`（`config/policies.ts` 的 `routeOperations` 校验：orderWrite 必须恰好映射 `['userOrderCreate']`）。checkout/cancel **当前没有任何路由**，`allowlistedPaths` 也没有对应端点——设计先行，**不新增、不启用任何路由**（与 GW-309 灰度放量保持一致）。
- 核心风险（任务验收原话）：
  1. **不可重复扣款/交付**：checkout 重放不得二次扣余额、二次发券/开通；
  2. **无权限 tradeNo 拒绝**：只能对自己名下的订单操作，且必须是订单实际持有人（Bearer 与订单 user_id 在 Laravel 侧绑定）；
  3. **错误状态稳定**：非法状态迁移（如对已支付订单 cancel、对已取消订单 checkout）必须拒绝，且拒绝语义长期稳定，不因重试、并发、重启而漂移。

## 2. 决策（Decision）

1. **checkout / cancel 复用 GW-302 的客户端操作键 + 请求指纹与 `idempotency_keys` 表**，不引入第二套幂等机制。operation 枚举从 `order.create` 扩展为三个（ADR GW-302 §3.1 已预留该枚举）：
   - `order.create`、`order.checkout`、`order.cancel`。
2. **订单状态机是独立的"业务态"，幂等状态机（in_progress/succeeded/failed_retryable）是"操作态"**。两者分层：幂等表保证"同一操作不重复执行"，订单状态机保证"订单只能沿合法边迁移"。任何资金副作用前，两个检查都必须在同一事务内通过。
3. **金额/优惠/余额校验全部在 Laravel 事务内**，Gateway 只校验请求 shape（tradeNo 格式），永不重算价格、不看余额、不判优惠券。
4. **幂等语义**：同键同参数返回首次的同一结果（含同一 tradeNo 与同一响应快照）；checkout 在 `in_progress`（新鲜）时 409 + Retry-After，陈旧（>15 分钟）按 GW-302 §5.1 CAS 接管。
5. **状态迁移原子化**：状态条件 UPDATE（`UPDATE orders SET status=… WHERE trade_no=? AND user_id=? AND status=<期望原态>`，受影响行数必须为 1）与幂等行写入、扣款写操作在同一 MySQL 事务提交；任何一步失败整体回滚，包括幂等行；同 Key 可以安全重试（兼容历史 `failed_retryable` 行）。

## 3. 订单状态机（业务态）

```
                  checkout(结算成功，资金事务提交)
   [0 pending] ──────────────────────────────► [1 paid]
       │  │                                     │  │
       │  └── cancel ──────────► [2 cancelled] ◄─┘  └──（生效完成）► [3 completed]
       │         （仅 status=0 可取消）              （由 Laravel 开通任务推进，不在本 ADR）
       └── checkout(资金失败) ──► 停留 [0]，幂等行 failed_retryable（可重试）
```

| 当前订单态 | checkout | cancel | 说明 |
| --- | --- | --- | --- |
| `0 pending` | 允许 → `1 paid`（或资金失败留 `0` + `failed_retryable`） | 允许 → `2 cancelled` | 唯一允许起点 |
| `1 paid` | 拒绝 `ORDER_STATE_INVALID`（409） | 拒绝 `ORDER_STATE_INVALID`（409） | 已扣款不得再扣、不得取消 |
| `2 cancelled` | 拒绝 `ORDER_STATE_INVALID`（409） | 幂等返回首次 cancel 结果（200 同一快照） | 终态 |
| `3 completed` | 拒绝 | 拒绝 | 终态 |

状态迁移白名单（与 GW-302 §5"不允许 succeeded → 其他"同构）：

```
0 → 1 （checkout 成功）
0 → 2 （cancel 成功）
0 → 0 （checkout 失败，状态不变，仅幂等行 failed_retryable）
其余全部拒绝
```

### 3.1 资金与边界校验（checkout）

校验顺序在事务内固定，先便宜后贵，任何一步失败即回滚：

1. **持有校验**：订单存在且 `user_id` = 认证用户（无权限 tradeNo → 403/404，统一按 `ORDER_NOT_FOUND` 语义避免泄露订单存在性）。
2. **状态校验**：订单 `status = 0`（见上表）。
3. **金额重算**：按订单快照的 plan/period 重算应付金额（分，整数）。**客户端传来的任何金额字段一律忽略**——Gateway schema 也不含金额字段。
4. **优惠券核验**：`coupon_code` 存在则校验：存在性、归属（该用户可用）、有效期、适用计划、最小消费额、使用次数上限。无效 → `COUPON_*` 拒绝码（见 §5）。优惠券扣减使用次数与订单落库同一事务。
5. **余额校验**：`balance >= amount_after_coupon`，不足 → `INSUFFICIENT_BALANCE`。扣减在同一事务内 `UPDATE … SET balance = balance - ? WHERE user_id=? AND balance >= ?`（受影响行数必须为 1，防并发扣成负数）。
6. **交付**：订阅开通/权益发放以事务后异步任务推进（与 GW-306 支付回调一致，不进幂等表）；事务提交前只写 `status=1` 与交易流水。

> **不可重复扣款的论证**：扣款 UPDATE 的 `balance >= ?` 守卫 + 状态条件 UPDATE 的行数守卫 + `idempotency_keys` 唯一约束，三者任一失败即整体回滚。重放同一 checkout（同键同参数）在幂等层就返回首次快照，根本到不了扣款；同客户端 Key 不同参数必须 409 `IDEMPOTENCY_CONFLICT`；并发双提交被唯一约束串行化。

### 3.2 cancel 的边界

- 仅 `status=0` 可取消。已支付（`1`）订单的退款属于另一流程（不在本 ADR 范围，GW-306 之后单独评审）。
- cancel **不触碰余额**（未支付无扣款可退）；若订单持有未使用优惠券，事务内归还使用次数（同一事务，失败整体回滚）。
- cancel 是**终态**：取消后同键永远返回首次结果；订单不能从 `2` 回到 `0`。

## 4. 幂等交互矩阵

| 场景 | 结果 |
| --- | --- |
| checkout 同键同参数，首次成功 | 200 + 首次快照（同一 tradeNo、同一 status=1 事实） |
| checkout 同键同参数，首次资金失败（failed_retryable） | 允许重试；重试成功 → 200 + 新快照 |
| checkout 同键重放，首次 in_progress（新鲜） | 409 `IDEMPOTENCY_IN_PROGRESS` + Retry-After: 2 |
| checkout 同键重放，首次 in_progress（陈旧 >15min） | CAS 接管后重试，仍只结算一次（§3.1 守卫） |
| cancel 同键同参数 | 200 + 首次取消结果；订单已在 `2` 时同理（状态条件 UPDATE 已保证首次唯一） |
| 先 cancel 后 checkout（同订单不同键） | checkout 被订单状态机拒绝 409 `ORDER_STATE_INVALID` |
| 无权限 tradeNo | 403/404（`ORDER_NOT_FOUND`），**零资金副作用**，不进幂等表（无键可派生于未验证身份——实际实现顺序：先鉴权与持有校验，再进入幂等路径） |
| TTL 过期后同键 | 按新请求；对 `status=1` 的订单 checkout 仍被状态机拒绝，幂等过期不构成绕过 |

**顺序约束**：鉴权 → 持有校验 → **限流/CAPTCHA**（GW-202/209，幂等不是免检通道）→ 幂等键判定 → 事务（状态机 + 资金）。持有校验在幂等之前，保证"无权限 tradeNo"拒绝路径不消耗幂等键空间、不泄露订单存在性。

## 5. Gateway 侧适配方案（设计，不实现路由）

Gateway 约束与 GW-304 完全一致：**不持有管理 token、不复制业务规则、不做本地去重、不重算金额**。checkout/cancel 是 GW-304 同构的透传适配：

### 5.1 路由与策略（默认关闭）

- 新增候选路由（**默认不注册**，与 `GATEWAY_ORDER_WRITE_ENABLED` 同一开关体系，具体 flag 命名评审确认，如 `GATEWAY_ORDER_CHECKOUT_ENABLED` / `GATEWAY_ORDER_CANCEL_ENABLED`）：
  - `POST /gateway/v1/orders/:tradeNo/checkout`
  - `POST /gateway/v1/orders/:tradeNo/cancel`
- 策略：定义 `orderCheckout` / `orderCancel`（`auth: 'bearer'`，`body: 'none'`——两操作均无请求体，参数只有路径 tradeNo；这与 GW-304 的 `body: 'json'` 不同，意味着幂等键完全由 `tradeNo + operation` 派生，无 body 规范化步骤）。
- `routeOperations` 校验（`config/policies.ts` 现有模式）：orderCheckout 必须恰好映射 `['userOrderCheckout']`，orderCancel 映射 `['userOrderCancel']`；`allowlistedPaths` 增补两个上游端点（Laravel 侧路径以真实契约为准，预留位）。
- 未启用时两路由走 `disabledWrite` 姿态：405、零上游调用。与现有 `POST /gateway/v1/orders` 的禁用姿态一致。

### 5.2 幂等键派生（无 body 场景）

- checkout/cancel 即使无请求体，仍采用 `key_hash = SHA-256(user_id : operation : client_key)`，`request_hash` 则从规范化的 `tradeNo`（以及支付方式等会影响操作结果的受控参数）计算；Gateway 提示头仍仅用于关联。
- Gateway 的客户端 `Idempotency-Key` 头仍**必填**（缺失/非法 → 400 零上游调用），并由 Laravel 与用户 ID 和操作名一起构成权威 `key_hash`；请求指纹单独存储，同 Key 不同业务参数返回 409。
- 同一 tradeNo 的 checkout 与 cancel 因 operation 不同而键不同，天然区分。

### 5.3 错误映射（GatewayFailureCode 增补）

| Laravel 响应 | Gateway 映射 | 说明 |
| --- | --- | --- |
| 409 `IDEMPOTENCY_IN_PROGRESS` | `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After` | 透传，不降级为 502 |
| 409 `ORDER_STATE_INVALID` | `409 ORDER_STATE_INVALID`（新码） | 订单状态不允许该操作（已支付/已取消/已完成） |
| 403/404 持有校验失败 | `ORDER_NOT_FOUND`（404，不泄露存在性） | 无权限 tradeNo；Gateway 不区分"不存在"与"不属于你" |
| 422 `INSUFFICIENT_BALANCE` | `422 ORDER_REJECTED` | 复用 GW-304 码位 |
| 422 `COUPON_NOT_FOUND/EXPIRED/…` | `422 ORDER_REJECTED` | 同上，不回显上游原文 |
| 上游 4xx/5xx（非上述） | 现有映射不变 | 不改动既有错误字典 |
| 超时/断连 | `UPSTREAM_UNAVAILABLE` 502/504 | SDK 默认不自动重试写请求（GW-308） |

错误语义**长期冻结**：上表中的码位一旦发布不得改名/改状态码，保证 SDK 与主题可依赖（"错误状态稳定"验收项）。

### 5.4 限流

| 操作 | IP 维度 | 账号维度 | 失效策略 |
| --- | --- | --- | --- |
| checkout | 5 / 5 分钟 | 5 / 15 分钟（bearer 派生） | fail-closed（资金写） |
| cancel | 10 / 5 分钟 | 10 / 15 分钟 | fail-closed |
| 只读订单（现状） | 60 / 分钟 | 120 / 分钟 | fail-open |

资金写限流与登录同级 fail-closed：Redis 断连时拒绝（宁可误拒不可放过并发结算洪泛）。配额为压测前保守初值，与 GW-208 调参流程一致。

## 6. 被否决的备选方案

| 备选 | 否决理由 |
| --- | --- |
| checkout/cancel 独立幂等表/机制 | 与 GW-302 地基重复；唯一约束+三态机已验证设计，扩展 operation 枚举即可，双机制必然漂移 |
| 状态机放在 Gateway（BFF 裁决迁移） | 违反 Gateway 不复制业务规则；多实例下必然退化为分布式状态机 |
| cancel 允许取消已支付订单（含退款） | 退款涉及原路退回/余额退回策略与对账，属 GW-306 之后独立评审范围；范围蔓延 |
| 客户端提供 checkout 金额 | 金额必须服务端按订单快照重算；客户端金额是经典篡改面 |
| Redis 扣款守卫替代 SQL `balance >= ?` | 同 GW-302：Redis 可丢状态，资金守卫必须落在 MySQL 事务内 |

## 7. 验收标准（输入 GW-306/309）

1. 并发 100 次同一 checkout：恰 1 次结算成功，余额扣减次数 = 1，其余 99 返回首次快照或 409 `IDEMPOTENCY_IN_PROGRESS`；余额不为负。
2. 对 `status=1` 订单 checkout：100% 拒绝 `ORDER_STATE_INVALID`，零扣款。
3. 对他人 tradeNo checkout/cancel：100% 拒绝 `ORDER_NOT_FOUND`，零幂等键写入、零资金副作用。
4. cancel 后同键重放：永远返回首次取消结果；cancel 后 checkout：拒绝 `ORDER_STATE_INVALID`。
5. 进程杀死/重启后重放：不产生第二次扣款（陈旧 in_progress CAS 接管 + SQL 守卫双保险）。
6. 优惠券边界：过期券、他人券、不适用计划券、超次数券在 checkout 时全部拒绝且**不归还/不重复扣减使用次数**；并发使用同一单次券仅 1 单成功。
7. Gateway 侧：未启用 flag 时 checkout/cancel 路由 405 零上游调用；错误码位冻结回归测试存在。

## 8. 风险与回滚

- **风险**：checkout 后续可能包含支付方式/支付 Token；请求指纹必须覆盖任何影响结算的受控参数，Token 不得落库。支付回调唯一性仍以 GW-306 的账务约束单独保证。
- **风险**：优惠券使用次数竞态 → 使用次数扣减在同一事务 + 条件 UPDATE（`used < limit` 守卫）。
- **回滚**：Laravel 侧删除 operation 枚举项与路由即回滚；Gateway 侧关闭 flag 恢复 405，不动任何只读接口；`idempotency_keys` 表可整体保留（GC 自然过期）。

## 9. 未决问题（评审输入）

1. checkout/cancel 是否需要独立 feature flag，还是统一并入 `GATEWAY_ORDER_WRITE_ENABLED`？倾向独立（checkout 是资金动作，风险高于 create）。
2. 已支付订单的取消/退款流程归属：建议 GW-306 支付回调方案中单独章节，本文档明确排除。
3. GW-308 SDK 必须生成独立客户端操作 Key 并在安全重试时原样复用；checkout/cancel 是否包含 method/token 入参须与现有 Laravel TXAPI 对齐。
