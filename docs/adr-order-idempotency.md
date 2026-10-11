# ADR：订单创建持久化幂等（GW-302 / GW-303）

- 日期：2026-10-11
- 状态：**契约修订，TXBoard 实现审查中**（[TXBoard #216](https://github.com/ANRCM0/TXBoard/issues/216)，[TXBoard PR #217](https://github.com/ANRCM0/TXBoard/pull/217)）
- 范围：`order.create`；checkout/cancel 为 GW-305，支付与回调另需 GW-306 验收
- 生产门禁：Gateway `GATEWAY_ORDER_WRITE_ENABLED` **仍须默认关闭**，直至真实 MySQL 并发及端到端支付联调完成

## 1. 为什么从纯参数派生键改为客户端操作键

旧草案以 `SHA-256(userId:operation:canonicalBody)` 唯一标识订单。此方案存在两点契约冲突：

1. 同一 Key 不同参数会变成**不同 Key**，不可能返回 #216 要求的 `409 IDEMPOTENCY_CONFLICT`；
2. 用户在 24 小时内两次主动购买同一计划，会被错误识别成同一次操作。

因此 GW-302 的**正式订单创建契约**采用“客户端独立操作 Key + 服务端请求指纹”：

- 客户端针对**单次购买意图**创建随机、不可预测的 `Idempotency-Key`；请求网络重试沿用同一 Key，另一次真正的购买必须使用新 Key。
- 格式：`^[A-Za-z0-9._~-]{1,128}$`。Gateway 在入站验证、缺失或非法时返回 400、**零上游调用**。
- Laravel 通过 `SHA-256( userId + ":" + operation + ":" + clientKey )` 存储 `key_hash`，**不持久化原始客户端键**。
- Laravel 对**已验证和规范化**的业务字段产生独立 `request_hash = SHA-256(canonical_json({plan_id,period,coupon_code}))`。与 Gateway 的提示头相比，它才是确定冲突的权威依据。
- 请求中的 `plan_id` 转为整数、周期映射到 TXBoard 原生期间、无优惠券时归一成 null；哈希不依赖 JSON 属性输入顺序。
- 同一用户、操作和 Key 对应同一个唯一槽位；槽位保存的请求指纹不等于新请求指纹时，立即 409 `IDEMPOTENCY_CONFLICT`，不运行任何订单或资金副作用。
- Laravel 的 `Idempotency-Key` 目前**可选**，以保持已经发布的 TXAPI/现有原生主题兼容；缺失时保留既有交易行为，**不承诺请求级重放保护**。Gateway 的订单写端点始终要求这个头，不允许走无保护的兼容路径。
- `X-Idempotency-Key-Hint` 是 Gateway 计算的无身份关联值（`SHA-256(operation + "\\n" + canonical_json(body))`）；Laravel 不接受它作为身份、请求指纹或幂等键权威。

## 2. MySQL 模型与约束

TXBoard 迁移：`2026_10_11_000001_create_idempotency_keys.php`

```text
idempotency_keys
  id             BIGINT PRIMARY KEY
  user_id        BIGINT NOT NULL
  operation      VARCHAR(32) NOT NULL
  key_hash       CHAR(64) NOT NULL
  request_hash   CHAR(64) NOT NULL
  status         VARCHAR(24) NOT NULL
  trade_no       VARCHAR(64) NULL
  result_snapshot JSON NULL
  created_at     BIGINT NOT NULL  (Unix seconds)
  updated_at     BIGINT NOT NULL  (Unix seconds)
  expires_at     BIGINT NOT NULL  (Unix seconds)

  UNIQUE(user_id, operation, key_hash)
  INDEX(expires_at, id)
```

`result_snapshot` 仅保存公开订单标识 `{"trade_no":"..."}`；**不存**用户名、Bearer、支付明文、余额、优惠码或个人信息。Laravel 重放时还会按用户 ID 查原订单；若原订单已不可用，返回冲突而非重新执行创建。

## 3. 串行化与崩溃一致性

`OrderService::createFromRequest` 的事务执行顺序：

1. 对认证用户 `tx_user` 行执行 `SELECT ... FOR UPDATE`；同一用户经不同服务实例/不同 API 创建订单必须先串行化。
2. 查询并锁定幂等槽位；**先处理成功重放或参数冲突，再做新订单的业务预校验**，避免已成功订单因“已有待支付订单”错误被拒绝。
3. 无槽位时插入 `in_progress`；已过期槽位在事务内删除并重占位；`failed_retryable` 可重试。
4. 在**同一个数据库事务**中校验套餐、处理余额与优惠券、创建订单，并把幂等记录置为 `succeeded` 及保存原 `trade_no`。
5. 一起提交。崩溃、超时或业务异常会导致**幂等记录和订单副作用全部回滚**；不存在先成功落单再丢掉幂等记录的中间窗口。

注意：`in_progress` 是事务中的过渡状态，正常成功路径下不单独提交。因异常而回滚的新槽位直接消失、可以安全重试，不依赖提交 `failed_retryable` 标志；实现同时支持处理以前已留下的 `failed_retryable` 和 `in_progress` 状态。

对于已经持久化的 `in_progress`：
- 新鲜的 `updated_at`：`409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 2`。
- 超过默认 15 分钟：由于持有用户行锁且幂等行锁，可独占接管并重试；必须仍遵守业务状态/余额检查。
- 24 小时 TTL（`IDEMPOTENCY_TTL_HOURS`）独立于占位超时；过期即视为新操作意图。过期不会复活已取消/已支付订单，也不会绕过原有业务不变量。
- `php artisan idempotency:prune` 每日按索引小批量删除过期行；不删除订单和资金历史。

## 4. API 行为表

| 输入 | Laravel 订单创建行为 | Gateway（写端点打开时） |
| --- | --- | --- |
| 无 Key | TXAPI 兼容旧调用，不承诺请求重放 | 400，不转发 |
| 非法 Key | 400 `VALIDATION_ERROR` | 400，不转发 |
| 同 Key、同规范化请求、首次 | 201，新的 `trade_no` | 201，同一结果 |
| 同 Key、同规范化请求、成功重放 | 201，**原** `trade_no`，不重扣余额/优惠券 | 201，同一结果 |
| 同 Key、不同请求指纹 | 409 `IDEMPOTENCY_CONFLICT` | 保留 409 |
| 同 Key、已提交的进行中记录 | 409 `IDEMPOTENCY_IN_PROGRESS`，Retry-After 2 | 保留 409 / Retry-After |
| 首次业务校验失败 | 回滚声明与业务；允许使用同 Key 再试 | 返回业务错误 |
| 同 Key 在 TTL 到期后再次使用 | 按新购买意图处理，仍受待支付订单等规则约束 | 同上 |
| 新 Key 表示另一次真实购买 | 作为新操作处理，仍受业务规则限制 | 同上 |

## 5. 范围、验证与回滚

- `order.create` 的交易保护归属 **TXBoard Laravel**。Gateway 只验证 Key 格式、透传 Bearer/头和映射错误；无 Redis 业务去重、无管理 Token、无价格计算。
- 原仓库已移除独立 V1 订单控制器。本次挂载点是各调用方共用的 `OrderService`，不恢复旧 API 路由；如果未来开放另一 HTTP 入口，必须调用同一服务。
- SQLite 功能测试覆盖 100 次相同 Key 重放、不同参数冲突、无 Key 兼容、失败回滚、模拟崩溃、过期、存量状态恢复。**这不等于 100 真正同时到达的 MySQL 请求**；生产开启前还需 MySQL 真并发和断连故障注入。
- Gateway `GATEWAY_ORDER_WRITE_ENABLED` 在 GW-303、GW-305、GW-306、GW-309 联合验收前维持关闭。回滚时先关闭 flag；数据库幂等表保留，不要因应用回滚删除已记录的幂等凭证。
- 任何 SDK 对订单写请求默认不自动重试；重试必须继续携带原 Key，且在明确故障/状态查询后控制退避。
