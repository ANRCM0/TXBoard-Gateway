# TXBoard Gateway

**TXBoard Gateway v1 (Phase 1)** — opt-in, contract-first API gateway for independently developed TXBoard user themes, plus a framework-agnostic TypeScript theme SDK.

- **Hono + TypeScript** gateway with fixed, auditable routes under `/gateway/v1`.
- **@txboard/theme-sdk** used by Vue, React, Next.js and standalone SPA themes.
- Stable response envelopes and explicit TXBoard V1 upstream adapters.
- Default-deny upstream path routing, guarded cross-origin requests, bounded payloads, timeouts and no credential/body logging.
- No new database access, admin token, payment privileges or node interfaces.

**Phase 1 is deliberately not a replacement for the legacy API.** Do not route `/api/v1/*`, `/api/v2/*`, `/s/*`, payment callbacks, plugins or node traffic through this service. Application-layer encryption, Redis rate limiting and write/idempotency flows belong to later phases; HTTPS is mandatory now.

## Routes

| Gateway route | Source | Authentication |
| --- | --- | --- |
| `GET /healthz` | gateway local health | none |
| `GET /gateway/v1/bootstrap` | TXBoard guest config, allowlisted fields | none |
| `GET /gateway/v1/theme/config` | TXBoard guest config (current public theme) | none |
| `GET /gateway/v1/plans` | `/api/v1/guest/plan/fetch` | none |
| `POST /gateway/v1/auth/login` | `/api/v1/passport/auth/login` | credentials + TXBoard's CAPTCHA policy |
| `GET /gateway/v1/user/profile` | `/api/v1/user/info` | Sanctum user bearer |
| `GET /gateway/v1/orders` | `/api/v1/user/order/fetch` | Sanctum user bearer |

`POST /gateway/v1/orders` is **not enabled in Phase 1**: order writes require a separately designed idempotency and anti-abuse contract. A direct POST gets 405.

## Requirements

- Node.js 22+; npm 10+.
- A running TXBoard backend, accessible from the gateway.
- HTTPS and proper TLS validation on public and production ingress.

## Local development

```sh
npm install
cp .env.example .env
# Edit TXBOARD_UPSTREAM_URL to the real TXBoard backend.
npm run dev:gateway
```

Health: `http://127.0.0.1:8787/healthz`.

```sh
npm run check      # typecheck both workspaces, unit/contract tests, builds
npm run build      # compile gateway and SDK
npm run test       # tests for both workspaces
```

## Environment

See [`.env.example`](./.env.example). Production examples must provide `TXBOARD_UPSTREAM_URL` and `GATEWAY_ALLOWED_ORIGINS` for cross-origin frontend hosting. In a same-origin reverse-proxy deployment, a browser Origin header must match an explicitly listed frontend origin; leave the allowlist empty only for server-to-server clients not sending Origin.

Configure the reverse proxy to expose `/gateway/v1/*` to the gateway. **Keep the legacy routes at TXBoard**. Run the gateway behind Caddy/Nginx, not directly public on port 8787. The gateway listens at `127.0.0.1` by default.

## Theme SDK

```ts
import { createTXBoardClient } from '@txboard/theme-sdk'

const api = createTXBoardClient({ baseURL: '/gateway/v1' })
const bootstrap = await api.bootstrap()
const plans = await api.plans.list()
```

For protected requests provide a `getToken` callback. `auth.login()` returns the backend's user bearer token, but the SDK does **not** persist it, store passwords, or silently attach it to public requests. It is the theme application's responsibility to manage its session securely.

See [theme integration](./contracts/theme-integration-v1.md), [API contract](./contracts/gateway-v1.md), [architecture](./docs/architecture.md) and [security expectations](./SECURITY.md).

## Development status

Phase 1 is an independently deployable compatibility slice. It is not automatically enabled by installing this repository; production integration with TXBoard and live end-to-end tests must happen separately.
