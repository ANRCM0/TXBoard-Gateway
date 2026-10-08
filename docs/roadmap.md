# TXBoard Gateway Roadmap（代码与正式验收分离）

> 更新：2026-10-08。当前 main 已合并 PR #4～#7；真实 TXBoard/Laravel/MySQL/Redis 端到端验收**延期**。每阶段代码的存在不等于该阶段可以直接上线。详细状态见 [开发状态台账](./development-status.md)。

## 阶段概览

| Milestone | 已落地代码 | 尚未满足的生产/验收条件 |
| --- | --- | --- |
| Phase 1 基线 | Gateway v1、固定上游白名单、Theme SDK、公开站点/主题/套餐与用户只读适配 | SDK 发布与完整真实样本 |
| Phase 1.5 合约与部署 | 源码字段盘点、基础运行时 Zod 检查、npm lockfile/CI、Chromium 模拟浏览器、Docker Staging 模板 | OpenAPI 3.1、真实 Laravel E2E、TXBoard-Deploy 真实 opt-in 反代、回滚演练 |
| Phase 2A Redis/安全 | **Redis SET NX PX nonce 防重放 + Lua 邮箱限流**、断线 503、容器私网 | 可信代理/IP 安全策略、生产告警、Redis 故障转移/HA、一致性与边缘限流 |
| Phase 2B 用户业务 | 订阅/订单详情/状态、支付方法展示、通知、统计、**加密注册/验证码（默认 off）** | 真正的 TXBoard 邮件/验证码联调、订单创建和支付事务幂等（均未开放） |
| Phase 3 加密 | 标准 HPKE 请求密文预览、公钥发现、SDK 自动封装、Redis nonce | 威胁模型、独立审计、密钥双版本轮换、响应策略、切主恢复 |
| Phase 4 主题生态 | 跨框架 TS SDK 基础、示例 | 主题包 v2、正式 SDK 发布、Vue/React/Next 真实 E2E、启用开关和兼容回退 |

已合并的关键 PR：[合同安全 #4](https://github.com/ANRCM0/TXBoard-Gateway/pull/4) · [构建/E2E #5](https://github.com/ANRCM0/TXBoard-Gateway/pull/5) · [Docker/HPKE #6](https://github.com/ANRCM0/TXBoard-Gateway/pull/6) · [Redis/账户 #7](https://github.com/ANRCM0/TXBoard-Gateway/pull/7)。

## 当前执行顺序

1. 处理 P0 **可信代理、Redis 故障转移、密钥轮换/撤销、生产安全审查**。
2. 补足 P0 **真实 Laravel/MySQL/Redis、验证码/邮件、反代回滚与压测**。当前按要求暂缓，不得将“跳过”标记为“通过”。
3. 在 TXBoard Laravel 内独立设计 **持久化订单幂等与支付状态机**（不能仅靠 Redis nonce 取代）。
4. 完整 OpenAPI + SDK 正式发布、主题运行时适配与用户业务闭环。
5. 部署试点、故障演练与生产 Go/No-Go 审核。

## 明确不开放的操作

- `POST /gateway/v1/orders` 仍为 405，不可创建新单。
- Gateway 没有 checkout/cancel/pay webhook、余额变更、节点、管理端和订阅原始 Token 导出。
- 未验证真实邮件验证码、邀请、CAPTCHA 或支付沙箱，不为前端绕过 Laravel 规则。
- HPKE **不是** TLS 替代；Redis nonce 原子性不代表故障切主时永远不丢记录。

## 资料

[项目现状](./development-status.md) · [Docker Runbook](./docker-deployment.md) · [业务/API 契约](../contracts/gateway-v1.md) · [任务与验收](./task-backlog.md) · [设计方案（保留原始规划）](./implementation-plan.md) · [安全边界](../SECURITY.md) · [AirBuddy 设计参考](./airbuddy-design-reference.md)。
