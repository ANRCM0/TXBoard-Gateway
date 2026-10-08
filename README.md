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

For Phase 1.5, `GET /gateway/v1/bootstrap` includes the allowlisted public CAPTCHA
type and site key. Themes must fail closed if CAPTCHA is enabled but lacks a
supported type/key. The login response is narrowed to user-session fields and
never exposes TXBoard admin `secure_path` or legacy tokens.

Run `npm run smoke:staging` with `GATEWAY_SMOKE_URL=https://<isolated-test-ingress>`
to check a deployed Gateway. Optional `GATEWAY_SMOKE_USER_BEARER` enables
read-only account/order checks. This is not a substitute for real browser login/CAPTCHA E2E.


## Development plan after Phase 1

The next work is **real TXBoard integration (M1 / Phase 1.5)**, not enabling experimental encryption or payment writes. For a concrete development sequence, dependencies, security gates and acceptance evidence:

- **[Source-aligned Laravel API matrix (Chinese)](./docs/txboard-v1-source-contract.md)** — verified upstream code paths and outstanding live fixture/E2E work.
- **[Detailed implementation plan (Chinese)](./docs/implementation-plan.md)** — phased architecture, cross-repository integration, security/threat model, safe transactions, optional encryption, theme SDK/runtime, performance targets and production rollout/rollback.
- **[Issue-ready task backlog (Chinese)](./docs/task-backlog.md)** — GW-101 through GW-509 with priorities, responsible repositories, dependencies and measurable completion criteria.
- **[Roadmap and milestones](./docs/roadmap.md)** — brief stage status and the immediate next tasks.
- **[AirBuddy design lessons (Chinese)](./docs/airbuddy-design-reference.md)** — source-grounded comparison and safe adaptation plan for optional encryption, fast checkout, CAPTCHA, notifications and deployment. External project functionality is **not** claimed as implemented here.

All later milestones are proposed work; Phase 1 CI passing does **not** establish production acceptance or that application-layer encryption is available.

## Development status

Phase 1 is an independently deployable compatibility slice. It is not automatically enabled by installing this repository; production integration with TXBoard and live end-to-end tests must happen separately.

## Reproducible builds and Phase 1.5 testing

- Runtime and CI target Node **22.23.2**, all npm workspaces use the committed
  `package-lock.json`, and CI/container builds run `npm ci`.
- `npm run test:browser` exercises a Chromium theme SDK flow through an actual
  Gateway process and **controlled fake TXBoard HTTP endpoints**. It validates
  browser CORS, public config, token routing, unauthorized behavior and order
  reads but is **not** a real TXBoard/Laravel E2E test.
- Real staging deployment instructions: [staging runbook](./staging/README.md).
  It uses a private Docker network and dedicated test accounts and is opt-in.
- No write/payment/subscription endpoints are added and production routes remain unchanged.

## Docker application layer & HPKE preview

**Docker Compose is the supported way to run this service.** See
[Docker application + encryption preview](./docs/app-crypto-preview.md).
`compose.yaml` keeps the Gateway private on a dedicated Docker network and
does not publish additional ports; `compose.crypto.yaml` optionally mounts
a persisted HPKE private key, with encrypted login usable through the Theme SDK.

Additional fixed user-owned read endpoints: subscription summary, order detail,
payment method display catalog (authenticated), and notices.
No checkout/order/payment writes are exposed.
**Real Laravel/MySQL/Redis acceptance and a third-party crypto review remain deferred.**

## Redis + account workflow preview

Current app preview adds `dashboard.stats()`, `orders.status(tradeNo)`,
`auth.register(payload)` and `auth.sendEmailCode(payload)`. Both auth writes
are **HPKE-only**, default disabled and require a private Redis safety store.
See [Docker + Redis workflow guide](./docs/app-crypto-preview.md).
Redis preserves nonce uniqueness across Gateway containers while healthy;
do not treat this as payment idempotency or a substitute for Laravel controls.
