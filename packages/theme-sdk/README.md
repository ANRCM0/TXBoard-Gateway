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
