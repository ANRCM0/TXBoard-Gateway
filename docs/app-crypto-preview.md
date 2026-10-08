# HPKE + Redis + 业务流程（技术预览）

> **2026-10-08 状态：** #6/#7 代码和 CI 已合并 main；非正式生产安全审核，真实 TXBoard 环境尚未联调。此处描述代码已经实现的行为及风险，而不是安全承诺。

## HPKE 协议与路径

- 实现：`@hpke/core` 的 RFC 9180 `DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM`。
- 网关公开 `GET /gateway/v1/crypto/key`，返回 `kid`、压缩表示的公开密钥编码、suite 与 scope；**绝不**返回私钥。
- `POST /gateway/v1/secure/auth/login`：需要 Docker HPKE + Redis；`encryptedLogin: true` 的 SDK 自动发现 key → 加密请求 → 调用该路径。
- `POST /gateway/v1/secure/auth/register`、`.../email-code`：额外要求 `GATEWAY_ACCOUNT_WORKFLOWS_ENABLED=true`（**默认 false**），SDK 始终密文提交，不明文回退。
- 只加密 **请求体**。HTTPS 仍然必须用于公钥发现、认证响应、Token 和通信安全。Laravel 仍最终裁决验证码、密码、邮箱、邀请与用户业务授权。
- AAD 绑定协议版本、POST、**固定操作路径**、kid、时间戳与随机 nonce，阻止密文直接跨操作路径复用。密文格式为 `{kid,ts,nonce,enc,ct}`。
- 时间窗 `±60s`，128-bit 随机 nonce。密钥 `kid` 基于公钥 SHA-256 截断。

## Redis 防重放与限流

加密模式 **要求 Redis 可用**：原子 `SET NX PX` 保存 `kid:nonce` 使用记录 **121 秒**（覆盖前后时间窗）。跨正常工作的 Redis 共享实例只能抢占一次，同一密文的再次尝试返回 HTTP **409**；Redis 不可用返回 **503**，不会退回进程 Map。当前拒绝重复密文，但**不是** TLS 替代，也不替代 Laravel 交易幂等。

账号限制以 **Lua INCR + 首次 PEXPIRE** 原子计数，邮箱先规范化再 SHA-256，Redis 键没有明文邮箱：

| 入口 | 每个邮箱默认次数 | 固定窗口 |
| --- | --- | --- |
| login | 8 | 60 秒 |
| register | 3 | 600 秒 |
| email-code | 2 | 600 秒 |

触发返回 **429**。当前**不是** IP + 账号双维度风控；任意来源可能故意消耗另一个邮箱的配额。用户仍可绕过 Gateway 调用旧 Laravel API，因此 Laravel 端自己的 CAPTCHA/限流不可删除。

**不能承诺 Redis 在故障切主后 nonce 永不丢失**：AOF、主从复制、网络分区和灾备配置尚未真实注入测试。不能把 Redis 当作订单幂等存储。在生产之前需要 Redis HA、AOF/快照策略、监控、隔离和攻击模拟的独立验收。

## 密钥生命周期

P-256 私钥在 Docker 文件 Secret 中持久保存，`node scripts/generate-hpke-key.mjs` 只新建不覆盖。Gateway 镜像内不含 Secret，`.dockerignore` 排除 `secrets/`。容器用 UID 1000 运行，Linux 宿主推荐 `chown 1000:1000` + `chmod 600`。

当前**没有**双 key 解密窗口、密钥轮换、吊销登记或独立互操作审计；更换 JWK 会改变 `kid`，SDK 每次加密操作前发现当前 key。多实例必须共享同一受控私钥与 Redis，并在部署审核中确认私钥权限和可回滚性。

## 业务边界

| 业务 | Laravel 上游 | Gateway |
| --- | --- | --- |
| 登录 | `passport/auth/login` | 明文兼容端点；HPKE 登录可选 |
| 注册 | `passport/auth/register` | 仅 HPKE，功能开关默认 off |
| 邮箱验证码 | `passport/comm/sendEmailVerify` | 仅 HPKE，功能开关默认 off |
| 订阅用量 | `user/getSubscribe` | 仅 DTO，删除订阅私密 token/uuid/url |
| 订单详情/状态 | `user/order/detail` / `user/order/check` | 用户鉴权、只读；后端验证归属 |
| 统计/通知/支付目录 | `user/getStat` / `user/notice/fetch` / `user/order/getPaymentMethod` | 只读，支付配置不透传 |
| 订单创建、结算、余额和支付回调 | Laravel 保留 | **未开放** |

注册、发邮件和已有登录请求可能在 Laravel 侧产生副作用；即便 Redis nonce 只消费一次，**客户端断线重试与后台重复触发**仍需单独设计，不应假设已经有跨账号幂等。

## 验证证据与阻断项

- [x] Redis 7.4 双独立客户端 64 个并发 nonce 请求只放行一次；账号限流与断连失败的 CI 用例。
- [x] Chromium 浏览器真实执行主题 SDK 加密登录/注册/邮件、统计与订单状态，对接**受控模拟 Laravel**。
- [x] Node 22/Vitest、Docker 容器私钥挂载与启动、Compose overlay 检查。
- [ ] 真实 Laravel/MySQL/Redis、实际 Turnstile/reCAPTCHA/email、Nginx/1Panel 可信代理联调。
- [ ] 密钥轮换、Redis failover、可信 IP/Host 与客户端反撞库、独立安全/密码学审查。
- [ ] 任何创建订单、checkout/cancel 或付款/回调的持久化幂等与沙箱验收。

CI 记录：[PR #6](https://github.com/ANRCM0/TXBoard-Gateway/pull/6) · [PR #7 与成功 CI](https://github.com/ANRCM0/TXBoard-Gateway/actions/runs/37801251835)。部署：[Docker / 1Panel Runbook](./docker-deployment.md)。
