# TXBoard Gateway 开发状态台账

> 更新时间：**2026-10-09**；旧阶段记录为历史快照，以下新增最新 main 代码核查。此文档记录代码和 CI，**不是生产就绪证明**。默认分支 main。当前不接入真实 TXBoard 环境，真实联调的验收暂按产品决策**延期**。

## 2026-10-09：已确认的主分支 CI 回归（与本次文档变更无关）

- Gateway main 基线 commit `94b3b9efd775` 的 GitHub Actions `verify` 已失败；本次纯文档 PR 也复现同一源码行为。因此不能将红 CI 归因于路由文档。
- 失败测试：`apps/gateway/test/policies.test.ts` 的 “performs zero upstream calls for POST /gateway/v1/orders (disabledWrite)”；期望 **HTTP 405**，实际 **401**。
- 可能的具体冲突点：`apps/gateway/src/app.ts` 在静态 `policyEnforcementMiddleware` 运行前，先对无 Origin 的 `/gateway/v1/orders` 做 `requiresCredentialProof` Bearer 拒绝，导致 disabledWrite 的静态 405 规则没有先执行。
- **另立代码修复 PR**：让禁用写入的 405 在该路径上优先，同时确保用户 GET 无 Bearer 仍 401、任何 POST orders 上游调用数为 0，并增加双场景回归测试；不要通过放开权限、修改测试预期或绕过 CI 掩盖问题。
- 本次文档 PR 不修改上述运行时代码；在 Verify 通过前不声称 Gateway CI 全绿。

## 一、合并记录与证据

| PR | 合并范围 | 最终代码证据 |
| --- | --- | --- |
| [#4](https://github.com/ANRCM0/TXBoard-Gateway/pull/4) | Laravel 契约初步对齐、验证码公开配置、登录过滤、响应校验 | [CI 37792938219](https://github.com/ANRCM0/TXBoard-Gateway/actions/runs/37792938219) |
| [#5](https://github.com/ANRCM0/TXBoard-Gateway/pull/5) | Node 22/lockfile/npm ci、Chromium 模拟 E2E、Staging 模板 | [CI 37795581303](https://github.com/ANRCM0/TXBoard-Gateway/actions/runs/37795581303) |
| [#6](https://github.com/ANRCM0/TXBoard-Gateway/pull/6) | Docker-first、应用只读 DTO、HPKE 密文登录、私钥隔离 | [CI 37799429771](https://github.com/ANRCM0/TXBoard-Gateway/actions/runs/37799429771) |
| [#7](https://github.com/ANRCM0/TXBoard-Gateway/pull/7) | Redis 原子 nonce、邮箱维度限流、加密注册/邮箱验证码、账户与订单状态 | [CI 37801251835](https://github.com/ANRCM0/TXBoard-Gateway/actions/runs/37801251835) |

合并：#6 → main `de45e3b`；#7 → main `9e5b3c1`。之后文档变更见 Git 历史。主分支最终 CI 状态以 [Actions](https://github.com/ANRCM0/TXBoard-Gateway/actions) 当前记录为准。

## 2026-10-09 合并进度更正（优先于 10/8 历史叙述）

- [PR #10](https://github.com/ANRCM0/TXBoard-Gateway/pull/10)：Routes/Adapters/Services 拆分；
- [PR #11](https://github.com/ANRCM0/TXBoard-Gateway/pull/11)：静态编译期路由策略及 boot-time 验证；
- [PR #12](https://github.com/ANRCM0/TXBoard-Gateway/pull/12)：可信入口、IP/账号双层限流；
- [PR #13](https://github.com/ANRCM0/TXBoard-Gateway/pull/13)：Readiness、Metrics、脱敏观测及熔断/重试等韧性能力。

**真实 Laravel/MySQL/Redis/CAPTCHA 及 1Panel 部署/安全/回退仍未验收。** `/readyz` 当前的 upstream 探针是占位状态，不代表真实 Laravel 探测成功。TXBoard Native 未来路径为 `/txapi/bff/v1/*`，当前 `/gateway/v1/*` 未变。参阅 [双仓集成开发方案](./txapi-integration.md)。

## 二、交付层级：不要混淆三个状态

| 层级 | 当前状态 | 含义 |
| --- | --- | --- |
| **实现 / mock CI** | 已完成首版 | TypeScript/Vitest、Chromium 浏览器、模拟 Laravel HTTP、Redis 7.4 双客户端并发、Docker/HPKE 私钥挂载启动 |
| **真实 TXBoard Staging** | **尚未验证** | Laravel + MySQL + Redis、真正的 Turnstile/reCAPTCHA、账号/邮件/订单状态、代理回滚、错误兼容、负载与数据一致性 |
| **生产安全 / 上线** | **不允许宣称完成** | 独立威胁模型和密码学审查、可信代理与边缘限流、密钥轮换、Redis 失效/切主、安全告警、压测、交易幂等、实际回滚 |

模拟 CI 验证的是 **SDK → 浏览器 → Gateway → 受控模拟 TXBoard**。它不等于真实后端联调或经济交易安全验收。

## 三、工程交付矩阵

| 子系统 | 已实现 | 关闭/局限 |
| --- | --- | --- |
| Gateway v1 | 固定路由、Origin 精确列表、no-store、大小和超时限制、错误映射 | 非 WAF；无正式 OpenAPI 3.1 |
| 主题 SDK | 跨框架 TS 接口、明确 Token 注入、可选密文登录与注册/邮件 API | 尚未发布 npm；未覆盖所有 SSR 真实平台 |
| 用户域 | 套餐、资料、订单列表/详情/状态、订阅用量、支付方式展示、通知、统计 | 当前不创建/取消订单；不操作余额/支付 |
| 账户域 | Laravel 原有登录，HPKE-only 注册、邮件验证码 | 后两项默认关闭，Laravel CAPTCHA 是最终权威 |
| HPKE | RFC 9180 P-256/HKDF-SHA256/AES-256-GCM、AAD 绑定操作、kid、公钥发现、密文请求 | 只加密请求体；无响应加密；无密钥双版本/吊销；TLS 必需 |
| Redis | SET NX PX 原子 nonce（121s）、Lua 计数限流、断连 503；账号键 SHA-256 | 无独立 IP 可信来源策略；Redis 异步故障转移可丢数据；哈希不等于匿名 |
| Docker | 私网 Compose + 可选 HPKE/Redis overlay；非 root、只读、健康检查、私钥排除镜像上下文 | 尚未接 1Panel 真实网关/生产证书；禁用自动上线 |

当前 Gateway 账户限流：**登录 8/分钟、注册 3/10分钟、邮箱验证码 2/10分钟**，分别按规范化邮箱计算；没有可证明的 IP+账号组合限流。规则目前写在代码中，不等同可在线热更新策略。

## 2026-10-09 架构决策增补（文档设计，非代码交付）

已选定 **Hono 模块化单体 + 静态声明式策略 + 路由级安全中间件 + Redis 共享安全存储**。参考 [架构总览](./architecture.md) 和 [中间件实施规范](./middleware-architecture.md)。

- **已确定：** 逻辑分层、策略矩阵、目标目录、PR-A～PR-E 顺序、任务 GW-210～GW-218。
- **未实现：** `middleware/` 目录重构、编译期策略表、可信 IP/双层限流、`/readyz`、正式指标、Luma SDK 迁移和可选公开缓存。
- **继续保留：** 现有 HPKE/Redis 技术预览、基本路由、SDK、Docker CI 的真实实现状态；不把文档新增目标计入“已完成”。
- **验收未改变：** 真实 Laravel/MySQL/Redis/CAPTCHA、密钥轮换/Redis 切主、代理回滚、交易幂等和安全审查仍待完成。真实联调虽然允许延期，但生产前不可跳过。

## 四、下一批开发优先级

1. **P0：安全与部署边界。** 可信反代来源/Host/IP、安全头、统一脱敏日志、Redis 429/503 指标、readiness 与故障告警；Laravel 侧沿用原有 CAPTCHA 及限流。Gateway 直连公网不是目标部署形式。
2. **P0：Redis/密钥生命周期。** 验证 Redis AOF、掉电/切主、不一致和多实例共享；实现可验证的双 key 轮换、kid 淘汰和审计，考虑运维误删数据。
3. **P0：恢复真实联调验收。** 用 [Staging 手册](../staging/README.md) 的隔离 Laravel/MySQL/Redis、浏览器 Turnstile/reCAPTCHA 和回滚流程；产品当前允许延期，但**生产之前必须补齐**。
4. **P0：Laravel 交易幂等。** 在 TXBoard 主仓库设计事务表/唯一键与订单状态机，100 并发、失败恢复和支付回调沙箱完成后，才能考虑 Gateway 的 POST orders/checkout/cancel。
5. **P1：正式 API 与主题生态。** OpenAPI 3.1、完整 fixtures、前端适配器 feature flag、SDK 发布和 Vue/React/Next 多主题兼容测试。

## 五、合并与发布规则

- **代码合并**：PR diff + CI 绿 + 变更清单；允许保留禁用的预览功能。
- **功能启用**：Docker 私网 + HTTPS + 配置/Secret 审核 + 实际业务环境验证，敏感账户写默认 off。
- **生产放量**：对外安全审查、真实 Laravel 端到端、Redis 故障注入/回退、关键指标与演练齐全；财务交易需独立幂等/对账验收。
- **回滚**：撤销 `/gateway/v1/*` 反代及前端 feature flag，再停 Gateway；不能触碰 TXBoard 的 MySQL/Redis 生产卷。

相关：[Docker 部署](./docker-deployment.md) · [Gateway v1 契约](../contracts/gateway-v1.md) · [原始任务验收矩阵](./task-backlog.md) · [HPKE/Redis 限制](./app-crypto-preview.md)。
