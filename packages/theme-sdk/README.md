# @txboard/theme-sdk

Official, framework-agnostic TypeScript client for TXBoard Gateway `/gateway/v1`. Supports Vue/React/Next.js/standalone themes. Compiled into `dist` with `npm run build --workspace @txboard/theme-sdk`.

```ts
import { createTXBoardClient, GatewayApiError } from '@txboard/theme-sdk'
const txboard = createTXBoardClient({
  baseURL: '/gateway/v1',
  getToken: () => session.userBearer,
})
const { site, theme } = await txboard.bootstrap()
const plans = await txboard.plans.list()
const profile = await txboard.user.profile()
```

- No auth storage or privileged theme scopes; applications explicitly supply a session token.
- Public calls (bootstrap/theme/plans/login) do not attach stored credentials.
- `GatewayApiError` carries a stable error `code` and `status`, with optional `requestId`.
- Money values retain TXBoard **cents** semantics. Do not convert in the SDK.
- Order creation and payment are not exposed in Phase 1.
- No global API interceptors, cookies, or unsafe arbitrary URL method.

See [Gateway HTTP contract](../../contracts/gateway-v1.md).

## Docker Gateway app layer and optional encryption

`createTXBoardClient({ baseURL, getToken })` additionally exposes:
`user.subscription()`, `orders.detail(tradeNo)`, `payments.list()` and
`notices.list({current, pageSize})`. All require a user Bearer and do not
provide transaction writes.

To opt into experimental HPKE **login-request-only** sealing:
```ts
const sdk = createTXBoardClient({ encryptedLogin: true })
await sdk.auth.login({ email: 'user@example.test', password: 'your-password' })
```
The Docker Gateway must be running with `compose.crypto.yaml` and a persistent
private JWK file. There is no silent downgrade on key discovery failure; use an
HTTPS ingress in production. Browser frameworks should bundle the SDK via their
normal Vite/Next/React toolchain, which resolves the `@hpke/core` dependency.
This mode is not production-ready; see `docs/app-crypto-preview.md`.
