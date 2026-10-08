# Security policy — TXBoard Gateway

Gateway 是可选主题 API 适配器，不是 WAF、匿名化服务或端到端通信加密系统。任何公网入口都必须走有效证书的 HTTPS。漏洞请通过仓库的私有 Security Advisory 途径提交，切勿在公开 Issue、CI 或聊天中暴露凭据。

## 已实现的控制（PR #4～#7）

- 静态上游路径白名单、精确 Origin CORS、no-store、有限请求/响应大小、超时和错误类型映射。
- 仅按需向 Laravel 发送当前用户 Bearer；不转发管理员安全路径、账户订阅原始 Token、支付敏感配置。
- 可选 HPKE 密文请求（**只保护请求体**），绑定方法/操作/kid/时间戳/nonce；私钥仅从 Docker 文件 Secret 加载。
- HPKE 模式必须使用 Redis，`SET NX PX` 原子登记 nonce；故障 503、重放 409，不回退本地缓存。
- 邮箱维度固定窗口限流，登录 8/分钟、注册 3/10分钟、邮件 2/10分钟；超过限额返回 429。
- 加密注册与发验证码功能 **默认关闭**；订单支付写入、节点/管理员/支付回调不由 Gateway 代理。

## 未完成的安全保障

- 没有生产可信代理/Host/IP 风控证明；仅 Origin 不是服务器鉴权。邮箱维度限流可遭到“消耗他人限额”攻击，Laravel 旧 API 不受 Gateway 风控约束。
- Redis 的健康期间原子占位**不代表**异步复制/故障切主时永不丢 nonce；部署审查必须测 Redis 持久化、AOF、切主以及容量耗尽行为。
- 没有多 kid 解密轮换窗口、密钥吊销、独立密码学/安全审计，HPKE 不应被描述为完整双向业务数据保护；TLS 不可省。
- 没有完整的生产结构化审计日志、指标与告警、WAF/IP 防刷、真实 CAPTCHA/邮件验证联调和故障预案。
- 没有 Laravel 持久化交易幂等；不能开放订单创建、扣款、checkout、支付回调及快速购买。

真实 TXBoard 环境验收按产品决策**暂缓**，不是完成或豁免正式上线门禁。只有在独立 Staging、外部审查、性能/代理故障注入和回滚全通过后，才可考虑生产放量。

参阅：[开发状态](./docs/development-status.md) · [HPKE/Redis 限制](./docs/app-crypto-preview.md) · [Docker 操作与回滚](./docs/docker-deployment.md)。
