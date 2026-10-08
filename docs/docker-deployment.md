# TXBoard Gateway Docker / 1Panel 部署与恢复 Runbook

> 当前代码支持容器化配置，但**没有在真实 TXBoard 服务器执行部署或验收**。用于本地与隔离环境；生产之前必须完成安全/数据/回滚审核。以下仅操作 Gateway 自身，不影响旧 Laravel 容器、MySQL、Redis 或支付回调。

## 1. 网络结构

```text
Browser (HTTPS only)
  → 现有 Nginx/OpenResty/Caddy/1Panel HTTPS 入口
       ├─ /gateway/v1/* → gateway:8787 (private Docker network)
       └─ /api/*, /s/*, admin, node, plugins, payment webhook → TXBoard 原服务
  Gateway → 固定 TXBOARD_UPSTREAM_URL (private trusted origin)
  Gateway → Redis (私网；仅启用 HPKE 时必须)
```

**不提供任何新的对外端口映射。** 原有代理须与 Gateway 共享可信 Docker 网络；配置 `GATEWAY_DOCKER_NETWORK` 为已存在的独立私网。不要把 Gateway 放到公开 Docker network 并直接暴露 8787。

## 2. 公共配置

```sh
cp .env.example .env
chmod 600 .env
# 修改 .env: TXBOARD_UPSTREAM_URL, GATEWAY_ALLOWED_ORIGINS
docker network inspect txboard-gateway-private >/dev/null 2>&1 || docker network create txboard-gateway-private
docker compose -f compose.yaml config --quiet
```

若 TXBoard upstream 是私有 `http://txboard:80`，需 `TXBOARD_ALLOW_PRIVATE_HTTP=true` 且 Gateway 必须能在受控网络解析该服务；不要用任意第三方明文 origin。所有浏览器入口始终走 HTTPS。

## 3. 部署档位

| 档位 | Compose 组合 | HPKE | Redis | 账户写入口 |
| --- | --- | --- | --- | --- |
| 基础只读 + 旧版登录 | `-f compose.yaml` | off | 无要求 | off |
| 私网加密预览 | `-f compose.yaml -f compose.crypto.yaml -f compose.redis.yaml` | on | 内置私有容器 | 默认 off |
| 1Panel Redis 预览 | `-f compose.yaml -f compose.crypto.yaml` | on | 自有 `GATEWAY_REDIS_URL` | 默认 off |
| 加密注册/邮件验证码 | 加密预览组合 + `GATEWAY_ACCOUNT_WORKFLOWS_ENABLED=true` | on | 必需 | **显式 opt-in，仅隔离环境** |

### 启用带 Redis 的 HPKE

先生成且仅生成一次私钥，避免重建导致 kid 改变：

```sh
node scripts/generate-hpke-key.mjs
sudo chown 1000:1000 secrets/gateway-hpke.json
sudo chmod 600 secrets/gateway-hpke.json

docker compose -f compose.yaml -f compose.crypto.yaml -f compose.redis.yaml config --quiet
docker compose -f compose.yaml -f compose.crypto.yaml -f compose.redis.yaml up -d --build
docker compose -f compose.yaml -f compose.crypto.yaml -f compose.redis.yaml ps
```

`secrets/` 已进入 `.dockerignore` 与 `.gitignore`，私钥由 Docker 运行时挂载，不应进入镜像、仓库、CI 工件、聊天或日志。Docker Gateway 使用 UID 1000。若是 Linux 绑定挂载的文件 Secret，Compose 的 uid/gid/mode 设置不一定覆盖宿主权限；必须确保 UID 1000 能读且其他非授权用户不可读。

### 连接现有 1Panel Redis

- Redis 在 Gateway 可达的可信 Docker 网络内，优先使用已启用 ACL/密码的服务；非同机可信网段使用 `rediss://`。
- 设置 `GATEWAY_REDIS_URL`（例如私有服务地址，含密码时不要截图、记录在 Issue）。
- **不添加** `compose.redis.yaml`；用基础 + crypto 两份 Compose。
- Redis 断连/初始化失败时，HPKE 登录注册失败而非回退到本地 Map；不可将 503 改造成放行。
- 多个 Gateway 必须共用同一持久私钥与可信 Redis；Redis failover/AOF 的数据持久性尚未完成正式验收。

## 4. 代理接入（手动 opt-in）

在现有 HTTPS 入口，**只**配置：

```nginx
location ^~ /gateway/v1/ {
    proxy_pass http://gateway:8787;
    proxy_set_header Host $host;
    proxy_connect_timeout 3s;
    proxy_read_timeout 15s;
}
```

`gateway` 需为反代所在网络的可解析服务名。不要在 `proxy_pass` 后面添加 URI 尾斜杠，以免改变路径。配置前保留现有代理文件和回滚版本；现有 `/api/`、`/s/`、管理员、支付回调和节点路由一律不变。此配置为隔离环境示例，不是可直接套用的生产访问控制模板。

## 5. 校验与回滚

```sh
docker compose -f compose.yaml ps
# 从可访问该服务的受控私网检测 /healthz；
# 经 HTTPS 代理检查 /gateway/v1/bootstrap 和 /gateway/v1/plans
GATEWAY_SMOKE_URL=https://your-staging.example npm run smoke:staging
```

`/healthz` 只证明容器能响应，不表示 Redis、防刷、Laravel、邮件或支付可用。模拟 CI：
`npm run check`、`npm run test:redis`（需 `GATEWAY_TEST_REDIS_URL`）、`npm run test:browser`。

回滚：**先**关前端 Gateway feature flag / 撤销代理 `/gateway/v1/*`，**再**对对应 Compose 组合执行 `docker compose ... down`。不可执行 `down -v`，不可删 TXBoard 数据卷/生产 Redis。关闭 Gateway 不应改变旧 `/api/*` 业务。

## 6. 上线阻断项

真实 TXBoard Laravel/MySQL/Redis 联调，验证码/邮件真实流程，代理 Host/IP 可信边界，独立密码学安全审查，双 kid 密钥轮换，Redis 故障转移和持久记录，日志/指标，压测和运维回滚演练**均未验收**。订单创建/结算/支付写入不开放。详见 [开发状态](./development-status.md) 与 [安全政策](../SECURITY.md)。
