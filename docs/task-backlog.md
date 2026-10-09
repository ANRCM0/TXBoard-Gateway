# TXBoard Gateway 任务清单与验收矩阵

> 与 [完整开发方案](./implementation-plan.md) 配套，本表保留**目标验收条件**，并非全部待开发；当前实现/未验收进度统一以 [开发状态台账](./development-status.md) 为准。  
> 日期基线：2026-10-08；采用任务编号 `GW-1xx` ～ `GW-5xx`，可以直接转成 GitHub Issues。  
> 优先级：P0 = 不能跳过的生产/安全前置；P1 = 阶段核心；P2 = 可随后优化。  
> 责任仓库：`GW` = `ANRCM0/TXBoard-Gateway`；`TX` = `ANRCM0/TXBoard`；`DEP` = `ANRCM0/TXBoard-Deploy`。

## TXAPI BFF 联合任务（G0–G5，新增）

| Task | Owner | Gate |
|---|---|---|
| GW-601 G0 | GW+TX | 两仓目标契约、每个 operation mapping、方法/权限/DTO |
| GW-602 G1 | GW+TX+DEP | 旧 /gateway/v1 真实 Laravel/MySQL/Redis/CAPTCHA 及代理/回退 |
| GW-603 G2 | TX | Native public/auth/me/plans/orders，分页+所有权回归 |
| GW-604 G3 | GW | BFF prefix、Native decoder、旧 v1 Envelope、SDK/contract fixtures |
| GW-605 G4 | GW+DEP+TX | Edge 优先分流、私网、可信 CIDR、主题 flag、性能/回退 |
| GW-606 G5 | GW+TX | 受支持调用方迁移、旧调用观测为零、退役公告 |

见 [双仓 ADR](./txapi-integration.md)。订单/支付写入仍不可启用。

## 截至 2026-10-08 的实施进度（历史快照）

| 任务 | 实施结果 | 尚未完成的正式验收 |
| --- | --- | --- |
| GW-101/102 | Laravel 源码契约盘点、最小响应 Zod 校验与通用错误处理已合并（[#4](https://github.com/ANRCM0/TXBoard-Gateway/pull/4)） | 真实脱敏样本、完整 OpenAPI 3.1 |
| GW-103 | 锁文件、Node 22、npm ci、SDK 打包和 CI 已有（[#5](https://github.com/ANRCM0/TXBoard-Gateway/pull/5)） | 依赖审计、安全发布门禁 |
| GW-104/105 | Docker Staging 模板、Chromium + 模拟 Laravel HTTP E2E 已有（#5） | **真实 Laravel/MySQL/Redis/CAPTCHA E2E 未实施** |
| GW-107 | Gateway 独立 Docker Compose、私有网络、HPKE/Redis overlay 已有（[#6](https://github.com/ANRCM0/TXBoard-Gateway/pull/6)、[#7](https://github.com/ANRCM0/TXBoard-Gateway/pull/7)） | TXBoard-Deploy 实际选配路由、真实回滚演练 |
| GW-202/203/206 | Redis 原子 nonce 和账号维度限流、断连 fail-closed 测试已合并（#7） | 可信 IP/代理限流、生产失效演练、持续指标与多机故障转移 |
| GW-301 | 订阅、订单明细、支付展示、通知等只读适配已合并（#6） | 真实后端契约验证 |
| GW-307 | HPKE-only 注册和邮箱验证码（默认关闭）、Laravel 透传已合并（#7） | 真实注册、验证码、邮件/邀请策略全流程验证 |
| GW-401～407 | HPKE 密文登录与 Redis 防重放**技术预览**已合并（#6/#7） | 威胁模型、独立审计、密钥双版本轮换、Redis 故障转移、发布门槛 |
| GW-302～306/309～311 | **未开发**：订单创建、支付流程、交易持久化幂等、快速购买 | 全部支付与交易安全前置 |

> “代码已实现”不等于原任务的全部验收条件已经满足。尤其真实环境验收是用户当前选择延期，不是通过或取消生产门禁。证据与下一阶段安排见 [开发状态台账](./development-status.md)。

## 共同 DoD（适用于每个任务）

完成不能只写“代码已提交”：必须具备清楚的输入/输出契约、代码或文档 PR、自动化测试及其 CI URL、拒绝/错误路径的验证、对既有 API 的兼容分析、必要时的回滚步骤。安全/支付/资金/主题安装任务需附独立审查结论。

原则：先解决 **真实联调与可回退**，再 **风控与审计**，再 **可写订单与支付**，之后 **可选加密**，最后 **独立主题标准化推广**。任务编号只表示归属阶段，不代表任意执行顺序。

## M1：Phase 1.5 — 契约与真实环境闭环

| ID | P | 责任 | 任务 | 依赖 | 验收 / 必须产物 |
| --- | --- | --- | --- | --- | --- |
| GW-101 | P0 | GW + TX | 梳理真实 TXBoard V1 上游接口与允许的响应 envelope | Phase 1 | 脱敏 fixtures，正常/异常样本覆盖 login、plan、user、order、guest config，字段差异表及兼容说明 |
| GW-102 | P0 | GW | 契约 OpenAPI 3.1、统一错误字典、请求/响应运行时 schema | GW-101 | 固定错误语义，非规范 200/422/429/HTML/空响应拒绝；兼容样本测试全绿 |
| GW-103 | P0 | GW | 固定可重现依赖与 CI（lockfile + npm ci + SDK 包检查） | 无 | 新机器 npm ci/check/pack/build 一次成功；dependency scan；无未锁依赖 |
| GW-104 | P0 | GW | Gateway 与 Laravel 本地可复现联调环境 | GW-101 | 沙箱账号/数据、MySQL/Redis、健康/readiness、启动/清理文档，复现 E2E |
| GW-105 | P0 | GW + TX | 登录、验证码、令牌过期、订单只读浏览器 E2E | GW-101/104 | Vue 浏览器流程覆盖 bootstrap/plans/login/profile/orders，成功/失败均绿；不能用生产账号 |
| GW-106 | P1 | GW | SDK 错误、AbortSignal、SSR 隔离及打包兼容 | GW-102/103 | Node+浏览器 import/exports 通过，SSR 两用户令牌隔离测试无泄漏，pack dry run 成功 |
| GW-107 | P0 | DEP + GW | 可选 Docker 服务及入口配置，保持遗留路由原样 | GW-104 | 内网部署、HTTPS、Origin/Host 和路由隔离检查，通过开关可以立即禁用 Gateway |
| GW-108 | P1 | TX | 内置 Vue 只读 API adapter/feature flag | GW-105/106/107 | 同一站点新旧客户端取数一致；关闭开关后原生页面无差异 |
| GW-109 | P0 | GW + DEP | staging 压测、故障演练、版本对应和回滚预演 | GW-107/108 | 网络超时、进程退出、DNS 错误、错误码和切回路径经过演练，发布记录可追踪 |

**M1 Go / No-Go：** GW-101/102/103/104/105/107/109 完成并且所有 P0 测试通过；GW-108 至少在 staging 可控，正式开关仍默认为 off。未完成不能进入生产默认流量。

## M2：Phase 2A — 可信边界与多实例安全基础

| ID | P | 责任 | 任务 | 依赖 | 验收 / 必须产物 |
| --- | --- | --- | --- | --- | --- |
| GW-201 | P0 | GW + TX | 威胁建模、流量分类和可信代理 ADR | M1 | 明确访客/用户/管理/节点/支付路径、攻击面、代理信任链与替代方案 |
| GW-202 | P0 | GW + DEP | Redis 原子限流引擎和路由策略 | GW-201 | 多副本一致、固定时间/滑动窗口实现有并发测试；含 HTTP 429、Retry-After |
| GW-203 | P0 | GW + TX | 登录反撞库、账号维度限流、验证码衔接 | GW-202 | 同 IP/账号限额起效，不泄露账号存在；Laravel 最终验证码验证未被跳过 |
| GW-204 | P0 | GW | 可信 IP 标头、CORS、Host 与上游访问安全 | GW-201 | 伪造 Origin/X-Forwarded-For、重定向、异常 DNS、未授权 Header 拒绝；不把无 Origin 视为已授权 |
| GW-205 | P0 | GW + DEP | 结构化脱敏日志、requestId、指标与告警 | GW-201 | 密码/Token/captcha/body/个人数据不落日志； p95、429、5xx、超时可监控 |
| GW-206 | P0 | GW | Redis 断连、网关过载、上游慢/断的故障策略 | GW-202/205 | 敏感写与登录 fail-closed；只读降级策略在测试中可证实；不会过载重试风暴 |
| GW-207 | P1 | GW + DEP | 依赖审计、镜像签名、SBOM、CSP/TLS 生产检查 | GW-205 | CI gate 可复现；无未经批准的高危依赖，证书验证与网络隔离通过 |
| GW-208 | P1 | GW | 固化限流默认策略/调参文档与误伤恢复流程 | GW-202/205 | 能复现正常/撞库/突发/误伤；运维可以调策略且留审计 |
| GW-209 | P1 | GW + TX | 可插拔 CAPTCHA 挑战，一次性原子校验和登录/注册/下单分级 | GW-202/203/206 | 复用 Laravel 现有验证；挑战过期/重放/并发/断连拒绝；跨副本仅一次成功，不能降低邮箱/账号策略 |

**M2 Go / No-Go：** GW-201~206 P0 全绿；未能证明多实例/断联策略时，不开启订单、注册、付款等新敏感写入口。新增 GW-209 仅在计划启用自托管 CAPTCHA 时成为该功能的强制前置，不能将其未完成说成已具备防重放。

## 架构演进专项：GW-210～GW-218（历史计划，部分已随 PR #10–#13 合并；正式验收单列）

> 本组属于 M1/M2 交叉工程任务，采用 [模块化中间件规范](./middleware-architecture.md) 的同进程方案；**编号为待办，不表示代码已实现或生产已批准**。真实联调延期不影响先行开展保契约重构，但生产门禁维持不变。

| ID | 优先级 | 责任 | 工作包 / 任务 | 可验证验收 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| GW-210 | P0 | GW | ADR/目标模块边界冻结，列出现状与目标态差异 | docs 架构/策略/威胁模型一致，禁止多服务串联/任意插件，现有契约不变 | 当前 main |
| GW-211 | P1 | GW | PR-A：拆分 app、routes、adapters、services，抽取无副作用 DTO | 全部原接口/错误码/默认 flag 对照测试，TypeScript/Vitest/Playwright mock CI 绿 | GW-210 |
| GW-212 | P0 | GW | PR-B：静态路由策略与不可绕过的 global baseline | 各路由策略映射快照、非法组合、未知路径、越权/敏感写入负例 | GW-211 |
| GW-213 | P0 | GW + DEP | PR-C：可信入口 IP/Host 与边缘+账户双层限流 | 假 XFF/Host/Origin 绕过拒绝，多副本、429/Retry-After 与误伤测试 | GW-201/204、GW-212 |
| GW-214 | P0 | GW + DEP | PR-D：无敏感字段的 requestId、metrics、内部 readiness | 断连/超时/429/503 可观测；零密码/Bearer/email/body 日志；探针不泄配置 | GW-205、GW-212 |
| GW-215 | P0 | GW | HPKE/Redis 共享安全状态和密钥轮换、故障切换 | nonce 跨副本原子；Redis 切主/丢状态测试；双 kid 轮换/吊销与 fail-closed | GW-212、GW-401～406 |
| GW-216 | P0 | GW + TX + DEP | PR-E：真实 TXBoard Staging 回归 + Gateway/旧 API 回滚 | Laravel/MySQL/Redis/真实 CAPTCHA、代理安全、故障注入证据；当前延期 | GW-104/105/107/109、GW-212 |
| GW-217 | P1 | GW + TX | Luma 首批公开/用户只读 SDK feature flag 适配 | plans/bootstrap/profile/orders 对照且关闭开关可回退；账户写默认关闭 | GW-216、GW-503 兼容约束 |
| GW-218 | P2 | GW | 可选公开数据 TTL 缓存（默认 off） | 只对已审计字段缓存，计划 15–60 秒 TTL、失效/变更一致性/无隐私泄漏 | GW-211/212/214 |

**合并门槛：** PR-A/B 的文档/代码改造以兼容性和模拟 CI 验证为准；PR-C/D 的新增安全能力要通过负向/故障测试；PR-E 的真实集成通过才能申请生产流量。不得将 PR-A/B 的合并算作 Staging 验收。

## M3：Phase 2B — 业务能力、后端交易幂等与支付隔离

| ID | P | 责任 | 任务 | 依赖 | 验收 / 必须产物 |
| --- | --- | --- | --- | --- | --- |
| GW-301 | P1 | GW + TX | 订阅、订单明细、支付方式等只读接口白名单 | M2 + API 样本 | 所有权由 Laravel 验证；私密订阅令牌不流向 guest；样本与 E2E |
| GW-302 | P0 | TX | Laravel 订单幂等 ADR、持久化数据结构和唯一约束 | M2 | userId+operation+请求哈希、冲突/并发/存储 TTL 决策评审通过 |
| GW-303 | P0 | TX | 旧/新 API 共用的订单创建事务幂等实现 | GW-302 | 并发 100 次同键同 body 只一单；重启/失败/不同 body 冲突正确 |
| GW-304 | P0 | GW + TX | `POST /gateway/v1/orders` 的入参、权限、幂等键适配 | GW-303 | Gateway 不持有管理 token、不复制业务规则；无幂等键拒绝；E2E 与 SDK 覆盖 |
| GW-305 | P0 | TX | checkout/cancel 的交易状态机、金额/优惠/余额边界 | GW-302/303 | 不可重复扣款/交付；无权限 tradeNo 拒绝；错误状态稳定 |
| GW-306 | P0 | TX + GW | 支付沙箱重复回调、异步先后、超时恢复测试 | GW-305 | 支付回调不走 Gateway；交易对账一致，无法验证时不得放量 |
| GW-307 | P1 | GW | 用户注册、邮件验证码、身份恢复接口接入 | GW-203 | Laravel 注册/邮件策略不变；限流与验证 E2E；未启用的接口默认拒绝 |
| GW-308 | P1 | GW + SDK | 新业务类型、重试与错误状态 SDK API | GW-304/306 | GET 可重试策略，写请求默认不自动重试；未知状态可确认 |
| GW-309 | P0 | GW + TX + DEP | 订单写灰度 / 旧 API 绕过边界验收 | GW-303/304/306 | 新旧调用同一幂等规则；真实沙箱走完、成功禁入条件解除、回滚演练 |
| GW-310 | P1 | TX + GW + SDK | 快速购买：注册/验证/受控认证/幂等下单一体化 | GW-203/303/304/306/307/309 | 不关闭邮箱验证/邀请码、不用管理 token；老用户不可被冒领；重放/关闭页面/重复支付回调与失败恢复 E2E 全绿；默认关闭 |
| GW-311 | P1 | TX + GW | 访客支付方式展示目录：安全公开 DTO、能力开关和失效策略 | GW-301、Laravel 公共字段评审 | 只展示后端许可的 id/name/icon 等非敏感字段；不公开支付商密钥、账户信息；实际结算仍由 Laravel 校验 |
| GW-312 | P2 | TX | 复用 TXBoard 通知服务支持交易邮件模板与可靠投递 | GW-307/310 + TX 通知架构评审 | 无独立 SMTP/管理员邮件凭据；不发送明文密码；模板转义/队列重试/事件去重/故障注入 E2E |

**M3 Go / No-Go：** GW-302~306/309 完成并测试通过。Redis 去重**不能**替代 Laravel 持久化幂等。没有支付沙箱证据禁止默认开放下单/支付能力。GW-310 快速购买属于附加能力，只有交易与邮件/验证码策略独立验收后才能 opt-in；GW-311/312 可分别独立交付。

## M4：Phase 3 — 可选应用层请求加密

| ID | P | 责任 | 任务 | 依赖 | 验收 / 必须产物 |
| --- | --- | --- | --- | --- | --- |
| GW-401 | P0 | GW + 安全审查 | 证明需要应用层加密的威胁模型、协议 ADR | M2 | 明确威胁、密文可见边界、对比 TLS-only、算法库、安全评审完成 |
| GW-402 | P0 | GW + DEP | 公钥发现/密钥发布/安全私钥保存、轮换与吊销 | GW-401 | 当前/旧密钥双窗口、过期/错误 kid/丢失密钥可恢复，不在浏览器存长期私钥 |
| GW-403 | P0 | GW + SDK | 标准封装/解封及 method/path/session AAD | GW-402 | 跨浏览器/Node 测试向量通过；篡改、算法降级、错误 AAD 必拒绝 |
| GW-404 | P0 | GW + Redis | 抗重放窗口、nonce 唯一性和 fail-closed | GW-403 | 并发相同请求 100 次只处理符合协议的首次；Redis 故障敏感写拒绝 |
| GW-405 | P0 | GW + SDK | 灰度协商、TLS-only 兼容与禁止静默降级 | GW-403/404 | 服务端强制策略生效；旧主题不被强制断线；敏感 operation 不会降级明文 |
| GW-406 | P0 | GW + 审查 | 加密性能、故障注入、安全复核 | GW-402~405 | key rotation、时钟偏差、断连/退回、额外 p95、第三方/独立安全审查 |
| GW-407 | P2 | GW | 可选响应体加密 | GW-406 | 先决策需求，再独立测试响应密钥派生、nonce、兼容和性能 |

**M4 Go / No-Go：** GW-401～406 全绿才能向愿意 opt-in 的前端主题开放；安全审查不通过则继续 TLS-only，并非阻塞其他非加密功能。

## M5：Phase 4 — 多框架独立主题与稳定发布

| ID | P | 责任 | 任务 | 依赖 | 验收 / 必须产物 |
| --- | --- | --- | --- | --- | --- |
| GW-501 | P0 | TX + GW | Theme Package v2 独立 manifest ADR | M1 + GW-106 | 不改变旧 `config.json`/`dashboard.blade.php`；声明版本/资源/能力/配置与安全策略 |
| GW-502 | P0 | TX | SPA 主题上传、校验、发布、切换、回滚 Runtime | GW-501 | ZIP 安全、兼容识别、资源完整性、CSP、回滚 E2E |
| GW-503 | P1 | GW + SDK | 稳定公开 SDK 契约、发版与 SemVer 策略 | M3 或当前只读稳定集 | npm pack/安装/浏览器/SSR、生成声明、tag/release 追溯 |
| GW-504 | P1 | GW | Vue 独立主题模板（首选） | GW-503 | 主题初始化、主题配置、套餐、用户、订单和错误 UI 全链路 |
| GW-505 | P1 | GW | React 独立主题模板 | GW-503 | 同接口和安全语义验证，页面无需直连 Laravel |
| GW-506 | P1 | GW | Next.js SSR 安全模板 | GW-503 | 无跨请求 session 污染；服务器 token 隔离测试 |
| GW-507 | P0 | TX + GW | 运行时版本协商、主题能力和安全隔离 | GW-501~506 | Gateway/SDK/theme 三维版本兼容拒绝；capability 不越权 |
| GW-508 | P0 | GW + DEP + TX | 发布/监控/回滚/兼容性总验收 | GW-507、M2/3 生产门禁 | canary 报告、旧主题回归、镜像 digest、操作手册、SLO 与 rollback |
| GW-509 | P2 | GW + 社区 | 第三方开发者文档与迁移指南 | GW-503~507 | 一套从零创建主题的可复现演示，不用管理员凭据 |

**M5 Go / No-Go：** 必须同时验证至少 Vue/React 两套 SPA + SSR 示例与旧 Blade 主题共存；发布记录可追溯、安全与性能门禁无阻断项。

---

## 第三方设计借鉴专项（2026-10）

[AirBuddy Security Service 源码借鉴和差异化技术决策](./airbuddy-design-reference.md) 将六项经验映射至上述已有任务和四项新任务 GW-209 / GW-310 / GW-311 / GW-312。**只参考体验，不复制共享密钥、通用代理、管理员代注册、可重用 CAPTCHA、SMTP 明文密码邮件等实现。** 所有项均为计划，未自动创建 GitHub Issues。

## 建议 GitHub Issue 建立顺序

**第一批（立即）：** GW-101、GW-102、GW-103、GW-104，分别建立独立任务并挂到 Milestone `M1: Gateway TXBoard E2E & Integration`；在已有 Gateway 代码上只做兼容/联调/测试与部署预演。

**第二批（M1 接近完成）：** GW-105～109，加上 M2 安全设计 GW-201/204。不要提前让 Gateway 承接订单写操作。

**第三批（M2 完成后）：** GW-301、GW-302、GW-303、GW-304、GW-305、GW-306，特别标记 GW-302/303/305/306 为 TXBoard 主仓库跨仓 PR。

**后续：** M2 内根据实际需求审查 GW-209；M3 交易闭环通过后再考虑 GW-310 快速购买，而公开支付方式 GW-311 与通知模板 GW-312 可以单独评审实现。M3 的支付 E2E 通过后，才优先决定是否进行 GW-401～406 的应用层加密；独立主题 Runtime 的文档设计可以提前进行，但安装器和授权边界必须和已发布 API 保持兼容。

### 单个 Issue 推荐模板

```markdown
## 目标
明确本任务解决的用户问题和接口影响。

## 现状 / 证据
相关源文件、现存 Gateway Contract、真实上游样本。

## 实现范围
- [ ] 正向实现
- [ ] 错误与安全边界
- [ ] 文档/契约更新
- [ ] 跨仓 PR（如需要）

## 依赖
列出前序 GW 编号和 TXBoard / Deploy 的依赖 PR。

## 可验证的验收标准
列出 HTTP 响应、权限拒绝、并发/故障、CI 和 E2E 的证据。

## 上线及回滚
feature flag 默认、部署指引、回滚触发条件和实际操作。
```

### 维护规则

- PR 文本写明对应 GW 编号，合并后在此表中勾选（或者从 Issue/Project 同步）；不可仅凭“代码编译成功”勾选联调或发布任务。
- 所有 **P0 必须经过单独验收**，不能把未完成状态藏在下一阶段。
- 若真实 TXBoard 行为与计划冲突，先记录差异并修改计划，然后再改契约和实现。
- 每完成一个里程碑更新 [Roadmap](./roadmap.md)、[实施方案](./implementation-plan.md) 和相应 Release Notes。
