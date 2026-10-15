# SC-v2 第一批：Gateway 安全基础修复验收

状态：实施分支初稿；未通过真实运行验收，禁止将本文视为生产发布批准。

## 范围与阻断条件

第一批先修复 v1 生产运行入口，之后才允许实现 v2 加密信封：

1. **可信客户端 IP**：生产 Node HTTP socket 必须向 Hono 中间件传入真实 peer IP。只允许配置的可信 ingress CIDR 使用 Forwarded/X-Forwarded-For；非可信来源一律忽略客户端自报地址。不得使用 `0.0.0.0` 作为可计费限流身份。验证直连、单层代理、多层代理、伪造头、IPv4/IPv6 和容器网段。
2. **双层限流**：启动时显式创建并注入 RedisRateLimiter，而不是仅加载/热更新配置。解密前只依据可信 IP 和固定外层路径限流；解密后依据规范化邮箱/经 Laravel 确认的用户身份限流。对 HPKE 请求不能在解密前要求明文邮箱，否则会误拒绝全部合法登录。Redis 故障时登录、注册、验证码和交易等敏感操作 fail closed；公开只读接口的降级策略需单独声明。
3. **Redis 健康**：由 RedisSecurity 实例提供真实的连接状态或 PING 探针，不得通过不存在的 `isReady` 强制类型断言读取。探针应检查依赖的可用性，而非仅检查对象是否存在。
4. **Readiness**：`/livez` 表示进程存活；`/readyz` 的 HTTP 503 表示必需依赖不可用。明确区分 `disabled`、`unknown`、`down`。Laravel 探针如启用，应设置严格超时和私网固定目标，避免健康探针引发请求洪峰。
5. **兼容性**：`/gateway/v1/*` 的现有成功/失败契约不变；订单默认写禁令不变；不得新增任意 URL 转发；不得记录解密正文、令牌、密码或 Redis 凭证。

## 推荐实施顺序

- P1-A：先做真实 Node HTTP 入口的 IP 传递和反代集成测试。
- P1-B：修复限流构造、启动接线及 HPKE 前后双阶段校验。
- P1-C：修复 Redis 状态暴露、readiness HTTP 语义及依赖故障测试。
- P1-D：回归全部 Gateway/SDK 测试、Docker/1Panel 隔离部署与故障注入。

## 必须通过的测试

| 场景 | 预期 |
| --- | --- |
| 真实 HTTP 服务直连 | 使用 socket peer，不接受伪造 XFF |
| 可信反代 | 只接受受信跳数的转发 IP |
| 不可信反代 | 不信任转发头 |
| 同 IP 突发请求 | Redis IP 限流生效，跨副本一致 |
| HPKE 登录 | 解密前不要求邮箱，解密后邮箱维度限流 |
| Redis 故障 | 敏感操作不可绕过限流或重放保护 |
| Redis 恢复 | readiness 恢复并可正常处理 |
| Redis 必需依赖故障 | readiness HTTP 503 |
| 无 Redis 的基础模式 | 不把禁用依赖误报为 down |
| v1 回归 | 所有现有业务路由与响应契约不变 |

## 发布规则

本阶段需要真实 Node HTTP + 反向代理 + Redis 测试证据，以及 TypeScript、Vitest、Docker 构建结果。仅文档、模拟请求或 GitHub CI 绿灯不足以签署生产验收。
