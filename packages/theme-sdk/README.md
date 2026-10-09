# @txboard/theme-sdk

Framework-agnostic TypeScript client for the Gateway's fixed `/gateway/v1` routes (Vue, React, Next.js, SPA). Future optional `/txapi/bff/v1` integration is **TARGET only** and retains the Gateway v1 `{ok,data,meta}` wire schema; see [integration](../../../docs/txapi-integration.md). Currently a workspace package, **not yet published to npm**. Build with `npm run build --workspace @txboard/theme-sdk`.

```ts
import { createTXBoardClient } from '@txboard/theme-sdk'
const api = createTXBoardClient({
  baseURL: '/gateway/v1',
  getToken: () => session?.auth_data,  // caller owns storage/lifetime
  encryptedLogin: true,                // optional HPKE + Redis Gateway only
})

const { site, theme, security } = await api.bootstrap()
const plans = await api.plans.list()
const profile = await api.user.profile()
const subscription = await api.user.subscription()
const orders = await api.orders.list({status: 0})
const detail = await api.orders.detail('ORDER-EXAMPLE')
const status = await api.orders.status('ORDER-EXAMPLE')
const stats = await api.dashboard.stats()
const notices = await api.notices.list({current: 1, pageSize: 5})
const payments = await api.payments.list()
```

登录：
```ts
const login = await api.auth.login({
  email: 'user@example.test',
  password: 'some-test-password',
  turnstile_token: 'test-captcha-token',
})
```

加密账户功能（**后端额外启用** `GATEWAY_ACCOUNT_WORKFLOWS_ENABLED=true`、Redis、HPKE，默认不可调用）：

```ts
const sent = await api.auth.sendEmailCode({
  email: 'user@example.test',
  turnstile_token: 'test-captcha-token',
})
const registered = await api.auth.register({
  email: 'user@example.test', password: 'some-test-password', email_code: '123456',
})
```

- `encryptedLogin: true` 只影响 `auth.login`；**注册/发码始终只走加密路径**，不会自动退回明文。
- SDK 不保存密码、Bearer、cookie 或用户会话；敏感 token 必须由应用自行安全管理。公开接口不携带 bearer。
- `GatewayApiError` 包含 `code`、HTTP `status`、可选 `requestId`。遇到 409/429/503 不要无脑自动重试密文写请求。
- 套餐与订单金额沿用 TXBoard 的分单位；不在 SDK 中二次转换。
- SDK 仅类型描述，不代替 Gateway/后端的运行时校验；SSR 必须为不同请求隔离 `getToken` 与客户实例。
- 无订单创建、checkout、支付回调、管理员 API、订阅原始 Token 导出。

[HTTP v1 契约](../../contracts/gateway-v1.md) · [Docker 运行方式](../../docs/docker-deployment.md) · [当前状态](../../docs/development-status.md)。
