# TXBoard Gateway

**Docker-first、可选启用的 TXBoard 用户主题 API Gateway**，独立于 Laravel 核心业务，基于 Node.js 22 / Hono / TypeScript，并提供 `@txboard/theme-sdk`。当前运行 API 以 `/gateway/v1` 为前缀；未来与 TXBoard Native 统一的 BFF 使用 `/txapi/bff/v1`，**仍为目标方案**。TXBoard Laravel 始终负责认证、验证码、账户归属、订单、余额和支付。

> **截至 2026-10-09：PR #4～#13 已合并，包含目录拆分、声明式策略、可信代理、双层限流、可观测和韧性。真实 Laravel/MySQL/Redis/CAPTCHA、生产反代与回滚仍未验收，不代表可生产放量。** 参阅 [开发状态与 CI 证据](./docs/development-status.md)。

## TXBoard Native 双仓协作（未来目标）

Gateway 是可选的主题/用户 API BFF，未来只处理 `/txapi/bff/v1/*`；TXBoard Laravel 处理其他 `/txapi/*`，尤其 Admin、Node、Agent、支付回调。BFF v1 仍保持 SDK 的 `{ok,data,meta}` envelope，Laravel Native 的 `{data,meta,request_id}` 单独解码。现行 `/gateway/v1` 和 `/api/v1` 不因文档迁移改变。Edge 精确分流、私网固定上游、不开放通用反向代理。见 [双仓集成方案](./docs/txapi-integration.md) 和 [目标 BFF 契约](./contracts/txapi-bff-target-v1.md)。

## 功能概览

| 功能 | 路由 / SDK | 状态 |
| --- | --- | --- |
| 站点/主题引导和 CAPTCHA 公开元数据 | `bootstrap`、`theme.config` | 已实现 |
| 套餐、登录与用户资料 | `plans.list`、`auth.login`、`user.profile` | 已实现 |
| 订单列表、详情、状态 | `orders.list`、`orders.detail`、`orders.status` | **只读** |
| 订阅用量概览、支付方式展示、通知、账户计数 | `user.subscription`、`payments.list`、`notices.list`、`dashboard.stats` | 已实现 |
| HPKE 密文登录 | `auth.login` 搭配 `encryptedLogin: true` | 可选，默认关闭 |
| HPKE 加密注册、发送邮件验证码 | `auth.register`、`auth.sendEmailCode` | **默认关闭**；必须启用 Redis/HPKE |
| Redis nonce 防重放 + 邮箱维度限流 | `SET NX PX` / Lua | 已实现并通过 CI；非生产安全批准 |
| 创建订单、checkout/cancel、支付回调、管理端、订阅原文令牌、节点 | 无 Gateway 接口 | **未开放** |

**兼容规则：**只反代 `/gateway/v1/*`；原 `/api/v1/*`、管理端 `/api/v2/*`、`/s/*`、插件、节点、支付回调与 WebSocket **一律仍由 TXBoard 处理**。Gateway 不是通用路径代理，也不使用管理员 Token。

## Docker 部署（官方运行方式）

### A. 基础模式：无 HPKE / Redis

```bash
cp .env.example .env
# 填写 TXBOARD_UPSTREAM_URL、GATEWAY_ALLOWED_ORIGINS
docker network inspect txboard-gateway-private >/dev/null 2>&1 || docker network create txboard-gateway-private
docker compose -f compose.yaml config
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml ps
```

### B. 本地隔离测试：HPKE + 内置 Redis

```bash
node scripts/generate-hpke-key.mjs
sudo chown 1000:1000 secrets/gateway-hpke.json
sudo chmod 600 secrets/gateway-hpke.json
docker compose -f compose.yaml -f compose.crypto.yaml -f compose.redis.yaml config
docker compose -f compose.yaml -f compose.crypto.yaml -f compose.redis.yaml up -d --build
```

默认 **不开启**加密注册/邮件验证码。测试账户流程时需在 `.env` 里设置 `GATEWAY_ACCOUNT_WORKFLOWS_ENABLED=true` 并重建服务。采用已有 1Panel Redis 时，不使用 `compose.redis.yaml`，需要受保护的 `GATEWAY_REDIS_URL` 及可达的私有网络。见 [Docker 运维手册](./docs/docker-deployment.md)。

网关及 Redis 均不映射额外公网端口，Gateway 容器只能被同 Docker 私网内的代理访问。公网只由原 HTTPS 反代入口对外服务。

## 开发与 CI

```bash
npm ci
npm run check          # TypeScript + Vitest + SDK/Gateway build
npm run test:browser   # 需安装 Playwright Chromium 和运行中的测试 Redis
npm run test:redis     # 需设置 GATEWAY_TEST_REDIS_URL
```

GitHub Actions 在 Redis 7.4、Chromium、Docker 中验证不同层级的模拟流程，**不使用真实 TXBoard 数据库或第三方验证码密钥**。主分支已使用锁文件与 Node 22.23.2 构建。

## 主题开发

```ts
import { createTXBoardClient } from '@txboard/theme-sdk'

const api = createTXBoardClient({
  baseURL: '/gateway/v1',
  getToken: () => userSession?.auth_data,
  encryptedLogin: true, // 可选；Docker 端必须配置 HPKE 和 Redis
})
const bootstrap = await api.bootstrap()
const plans = await api.plans.list()
const summary = await api.user.subscription()
const stats = await api.dashboard.stats()
```

SDK 不负责保存 Session、密码或订阅私密 Token，也不会将 Bearer 附加到公共接口。详情参阅 [SDK 文档](./packages/theme-sdk/README.md) 和 [HTTP API 契约](./contracts/gateway-v1.md)。

## 维护文档

- [模块化单体架构与信任边界](./docs/architecture.md) · [中间件/路由策略实施规范（目标态，尚未实现）](./docs/middleware-architecture.md)
- [当前开发状态、验收清单与证据](./docs/development-status.md)
- [Docker / 1Panel 部署、私钥、Redis 与回滚](./docs/docker-deployment.md)
- [Current Gateway API / SDK](./contracts/gateway-v1.md) · [Future TXAPI BFF Contract](./contracts/txapi-bff-target-v1.md)
- [TXBoard Native 双仓开发方案](./docs/txapi-integration.md)
- [HPKE、Redis、威胁边界](./docs/app-crypto-preview.md)
- [开发路线图](./docs/roadmap.md) · [详细方案](./docs/implementation-plan.md) · [任务拆解与验收条件](./docs/task-backlog.md)
- [真实 TXBoard 隔离 Staging 验收手册](./staging/README.md)
- [安全边界和披露](./SECURITY.md)

**产品决策：**允许先开发功能、推迟真实环境验收；这**不代表**生产发布门禁被取消。用户订单写入、扣款、自动支付与快速购买必须先在 Laravel 完成持久化幂等和沙箱/回调测试。
