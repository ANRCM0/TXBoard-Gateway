# Gateway 真实 TXBoard Staging 联调入口（GW-104 / GW-105）

> **不是生产部署手册，也不是已完成的真实端到端联调证明。**
> 本目录仅为已有隔离 TXBoard 环境提供 opt-in Gateway 接入，
> 与 CI 中基于伪造 Laravel HTTP 服务的 Chromium 测试不同。

## 运行前置

1. 在另一台/独立网络环境先运行固定版本 TXBoard（Laravel + MySQL + Redis）。
   可以使用官方 TXBoard / TXBoard-Deploy 的独立测试安装，不要复用生产数据库、账号、邮件密钥、订单或管理入口。
2. 确定 TXBoard staging Docker 网络名称，例如 `txboard-staging_default`。
   确认 Gateway 容器可以从该网络访问到运行中的 `http://txboard`（Caddy/Laravel）。
   如果服务名不同，以 `TXBOARD_STAGING_UPSTREAM_URL` 指向明确的内网 HTTP origin。
3. 只在真实 staging 的可信 HTTPS 入口配置 `/gateway/v1/*` 反代。
   其余 /api/*、/s/*、管理员、支付回调和节点路由仍完全指向 TXBoard。

在 Gateway 仓库根目录执行：

```sh
export TXBOARD_STAGING_NETWORK=txboard-staging_default
export TXBOARD_STAGING_UPSTREAM_URL=http://txboard
export GATEWAY_STAGING_ALLOWED_ORIGINS=https://staging.example.test
docker compose -f staging/compose.gateway.yaml config
docker compose -f staging/compose.gateway.yaml up -d --build
docker compose -f staging/compose.gateway.yaml ps
```

Compose 仅 `expose: 8787` 到 Docker 私网，无 `ports:` 公网映射。
如果独立的前置 Nginx 与 Gateway 在同一个私有网络，可以使用：

```nginx
location ^~ /gateway/v1/ {
    proxy_pass http://txboard-gateway:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Request-Id $request_id;
    proxy_connect_timeout 3s;
    proxy_read_timeout 15s;
}
```

`proxy_pass` **不要追加 URI 尾斜杠**，确保固定 `/gateway/v1/` 路径保留。
部署网络中 `txboard-gateway` 必须是可解析的服务别名；外部代理不在同网时需使用安全的独立网络方式对接。公网只公开既有 HTTPS 入口，不直通 :8787。

## 只读冒烟与真实验收

```sh
GATEWAY_SMOKE_URL=https://staging.example.test npm run smoke:staging
```

可选：使用**隔离测试用户** 的短期 Bearer，加入
`GATEWAY_SMOKE_USER_BEARER` 以检查 profile/orders。不要输入管理员 token，
更不要在 shell history、聊天、日志和 Issue 中公开真实令牌。

真实浏览器手工/自动化验收表（每项提供脱敏记录、实际环境版本和 CI 链接）：

- [ ] 真实 TXBoard guest 配置、套餐、主题（多语言/资源字段如适用）。
- [ ] 真实浏览器分别验证关闭 CAPTCHA、Turnstile、reCAPTCHA v2/v3（仅测试 Site Key，服务端仍要实际验证）。
- [ ] 正确登录→令牌过期→401→重新登录；兼容浏览器 Origin/OPTIONS 和异常网络状态。
- [ ] 账户信息、订单数组和金额分数单位与原生接口一致；旧主题仍可工作。
- [ ] staging 反代开启、停止 Gateway、恢复旧入口的回滚演练。
- [ ] 记录隔离后端的 Laravel commit、Gateway commit、Docker 镜像 digest、压测/时延和脱敏错误样本。

**回滚：** 在 staging HTTPS 前置反代移除 `/gateway/v1/*` 映射并停用
Gateway 主题适配开关。然后执行
`docker compose -f staging/compose.gateway.yaml down`，
不要对 TXBoard 的 MySQL/Redis 数据卷执行 `down -v`。
已有旧 `/api/*` 和管理端、节点、支付路由均不依赖 Gateway。

## 已知限制

- 本仓库没有从生产服务器获取数据库/Token，也不会使用真实管理员凭证执行测试。
- CI 的 Chromium mock E2E 证明 SDK→HTTP Gateway→受控模拟上游能工作，
  **不能证明**独立 TXBoard Laravel+MySQL/Redis 的真实联调或第三方验证码服务可用。
- 完整 GW-104/105 验收须运行本手册中的隔离真实环境流程后才能勾选。
