# TXBoard-Gateway ↔ TXBoard Native 双仓 API 集成方案

> ADR-006 · 2026-10-09 · **TARGET / NOT LIVE**。对应 [TXBoard ADR](https://github.com/ANRCM0/TXBoard/blob/main/docs/architecture/gateway-integration.md)。本次只有文档变更，不代表任何新路由上线。

## 1. 定位与架构决定

TXBoard Laravel 是**唯一业务控制面和事实来源**；本仓是独立可选 Node.js/Hono/TypeScript API 中间件与独立主题 BFF。公网所有未来 TXBoard API 使用 `/txapi` 根路径，**仅 `/txapi/bff/v1/*` 由 Hono Gateway 提供**。其他 `/txapi/*`（User Native、Admin、Node、Agent、Plugin、支付/Webhook）由 Laravel 负责，且不是所有请求都必须过 Gateway。

| Component | Owns | Must not own |
| --- | --- | --- |
| HTTPS Edge (OpenResty/Caddy/1Panel) | TLS、Host/IP/body 边界、精确路径分流、可信代理 | 不向 Gateway 通配转发全部 TXAPI |
| Hono Gateway | Static operation allowlist、路由级策略、Zod、限流、可选 HPKE/Redis、DTO/聚合、监控熔断与 Theme SDK | 不直连 DB、Node、账本，不持 Admin/Agent 凭据，不处理 Payment Webhook |
| TXBoard Laravel | 真正认证/CAPTCHA、用户资源归属、RBAC、套餐、订单/余额/支付/佣金、流量账本、Node、Plugin/Theme 生命周期 | 不依赖 Gateway 才能运行 |
| TX-Node | 独立 Agent Data Plane | 不走主题 BFF |
| TXBoard `mcp/` | Agent Ops/MCP 适配器 | 不是本仓 Gateway，双方不合并权限 |

Gateway 只检查 User Bearer 的**形状**，Laravel 负责令牌真实性和订单/数据所有权。Redis nonce 不是交易幂等，Laravel 数据库才是权威。

## 2. CURRENT 与 TARGET 路由拓扑

```text
CURRENT (already in main)
HTTPS ingress
 ├─ /gateway/v1/* → Hono Gateway → fixed /api/v1/* Laravel
 ├─ /api/v1/* /api/v2/* → Laravel
 └─ /s/*, /ws, plugin, admin, payment callback, node → TXBoard

TARGET (requires implementation)
HTTPS ingress
 ├─ /txapi/bff/v1/* → Gateway (private Docker) → fixed private Laravel /txapi/* ops
 ├─ /txapi/*        → Laravel Native
 ├─ /s/*, /ws, assets → existing TXBoard
 └─ legacy prefixes maintained until consumer migration
```

Edge 必须先精确匹配 BFF 子树，再匹配通用 TXAPI。后端固定 TXBOARD_UPSTREAM_URL 必须是**私有** TXBoard origin，不能指向会把 `/txapi/bff/v1` 再转回 Gateway 的公网路由，以防递归代理循环。不得允许任意客户端 Host、URL、Header 或主题 manifest 控制上游目的地。

## 3. 首批候选 Operation 映射

| Gateway BFF route | Proposed TXBoard Native upstream | Policy |
| --- | --- | --- |
| GET `/txapi/bff/v1/bootstrap` | GET `/txapi/public/config` | publicRead |
| GET `/txapi/bff/v1/theme/config` | GET `/txapi/public/config` | publicRead |
| GET `/txapi/bff/v1/plans` | GET `/txapi/plans` | publicRead |
| POST `/txapi/bff/v1/auth/login` | POST `/txapi/auth/login` | login |
| GET `/txapi/bff/v1/user/profile` | GET `/txapi/me` | userRead |
| GET `/txapi/bff/v1/orders` | GET `/txapi/orders` | userRead、DB 分页 |
| GET `/txapi/bff/v1/orders/{tradeNo}` | GET `/txapi/orders/{tradeNo}` | userRead、Laravel 验证归属 |
| POST `/txapi/bff/v1/orders` | **no upstream** | disabledWrite → 405 |

这些 Laravel Native 路径**尚未部署**。当前 Gateway 的 notices、subscription、stats、payments display、order status、secure auth 仍需逐一冻结目标 operation / schema；不得凭猜测转发到不存在的 Laravel path。所有新增 upstream 保持 **编译期固定命名 operation**，不添加通用转发接口。

## 4. 两套 JSON 契约的关系

- **Laravel Native TXAPI** 目标：成功 `{data,meta?,request_id?}`；失败 `{error,request_id?}`，使用合适 HTTP status。
- **Gateway BFF v1** 目标：继续保留当前 Theme SDK `{ok:true,data,meta:{version:"1",requestId}}` / `{ok:false,error,meta:{version:"1",requestId}}`。
- Gateway 的 typed adapter 将 Native 响应转换成 BFF v1，禁止让主题直接以 Laravel Native schema 解析 BFF；错误码、分页、金额整数分、流量 bytes 均需有 fixture 验证。
- 从 `/gateway/v1` 迁移 URL **不等于**能悄悄修改既有 Gateway v1 DTO；breaking change 需要新的 v2 contract/SDK。
- 不回显 Laravel exception、Admin secure_path、Subscription URL/token、支付私密字段；观测标签不能出现用户 token/email/完整路径等隐私内容。
- Admin/Node/Agent/Payment/Extension/订阅链接/WebSocket 应始终直接由 Laravel/原处理器服务，而不进入 BFF。

详见 [本仓 BFF Target Contract](../contracts/txapi-bff-target-v1.md)。

## 5. 中间件与安全实现原则

**已在 main 找到的代码**：单 Hono app、`config/policies.ts` 编译期 policy matrix、`middleware/` 可信 Proxy/Host、Redis IP/账户限流与登录保护、HPKE/nonce、`middleware/resilience.ts` 的熔断/限流故障策略、有界只读 retry，及 `/metrics`、`/readyz` 观测。PR #10–#13 合并了模块化/策略/安全/监控相关工作；旧状态文档的“待实现”不可覆盖代码事实。

**尚未正式验证**：真实 Laravel + MySQL/Redis/CAPTCHA E2E、实际 1Panel/代理链、密钥轮换与 Redis 切换、多实例可靠性、生产/付款安全审计。当前 readiness upstream 只是占位 up，不表示实际联网探测完成。

静态策略运行链：
- global：Request ID、可信代理与 Host/Origin、入站限制、安全响应头、脱敏可观测。
- publicRead：Schema → upstream allowlist → 公开 DTO；默认不缓存，确认可公开且失效正确才可短缓存。
- userRead：Bearer 外形 → Laravel Token/所有权 → DTO；用户数据禁止共享缓存。
- login/secureAccount：先低成本 IP 控制、必要时 HPKE+Redis nonce，再账号频控与 Laravel CAPTCHA；安全 Redis 故障需 fail-closed，无明文静默回退。
- disabledWrite：入口固定 405，零上游订单创建/支付副作用。

对于 GET 的安全公开只读允许有界重试；认证、支付和交易写入不能靠 Gateway 自动重试或 Redis nonce 获得账本幂等。主题配置不能动态注入 JS 中间件、安全 policy 或任意 HTTP upstream。

## 6. Docker/网络安全与故障回退

- Gateway 继续独立 Docker 容器，使用与 Edge/TXBoard 受控互通的 Docker 私网，不公开 8787/Redis/metrics 公网端口。
- Edge 负责 `/txapi/bff/v1/*` 的显式路由；关闭 Gateway 后其余 TXAPI Admin/用户 native、Node、Agent、Webhooks 和订阅仍然可访问。
- 需审核 TXBoard 当前 Caddy 的 `trusted_proxies static 0.0.0.0/0 ::/0` 及真实可信代理 CIDR，测试 XFF/Host/Origin 欺骗和直接端口绕过。此项需要单独安全 PR。
- 对 Gateway readiness 分开检测自身依赖与真实 Laravel upstream，不能把未探测的 upstream 显示为健康。
- 实际回滚：先关闭主题/用户前端 BFF feature flag 与 Edge 路由，再停止 Gateway 服务；**不操作 TXBoard MySQL、Redis 账本数据、支付回调和 Node 链路**。
- 只有已验收的直接 Laravel API 才能成为回滚目标；不能在敏感失败时静默降级保护。

## 7. 双仓 G0–G5 实施包

| Phase | Owner | Gate |
| --- | --- | --- |
| G0 合同冻结 | TXBoard + Gateway | ADR、两边 BFF Target、每个 operation current→native、schema、auth、errors |
| G1 现有链路真实联调 | Gateway + Deploy | 现有 /gateway/v1 对真实 TXBoard、MySQL/Redis/CAPTCHA、浏览器、代理与回滚验证 |
| G2 Native API | TXBoard | /txapi/public、auth、me、plans、orders；Laravel 权限/分页/业务回归 |
| G3 新 BFF adapter | Gateway | /txapi/bff/v1、固定 upstream allowlist、v1 Envelope、SDK/兼容窗口 |
| G4 可选主题/部署 | Gateway + TXBoard Web + Deploy | Edge 精准路由、Docker 私网、1Panel 信任链、只读灰度、p95/错误监控与撤回 |
| G5 遗留退役 | 两仓 | 所有受支持 consumer 升级、旧流量观察为零、发布/兼容公告 |

G2 依赖 TXBoard Native P1/P2；G3 不能在 Native route 存在和测试之前盲目硬切；G4 必须完成 G1 真实安全验收；G5 最终纳入 Native P7 旧端点退役计划。**不因为引入 BFF 就默认开启 checkout/cancel/pay/order write。**

## 8. 第一批真正应该做的事

1. 编写完整 UpstreamOperation 当前 URL → Native TXAPI URL 的 schema/方法/权限/错误/响应基线表。
2. 在可销毁隔离环境联调旧 Gateway v1 与 Laravel、真实 CAPTCHA/Redis、账号/订单只读、超时、状态码。
3. 在 TXBoard 先实现 Native public/auth/me/plans/orders 和 DB 分页后，让 Gateway 用 typed adapter 有序迁移 upstream。
4. 明确 Edge/Caddy 可信 CIDR、安全边界、循环代理测试、健康探针与 Docker-only 网络方案。
5. Theme SDK 增加可配置 BFF baseURL 与独立 feature flag，旧主题原 API 可一键回退。
6. 采集 p95 Gateway overhead、Laravel upstream latency、超时/429/503、Redis/HPKE 故障、私密日志泄漏检验、升级回退记录。

**实施代码合并 ≠ 真实 Staging 验收 ≠ 生产批准。**
