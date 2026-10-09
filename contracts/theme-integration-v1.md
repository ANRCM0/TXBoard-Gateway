# TXBoard Independent Theme Integration Contract v1 (draft)

This contract **extends**, but does not replace, TXBoard Theme Package v1 (`config.json` + `dashboard.blade.php`). Existing themes continue working. Standalone SPA manifests and the SDK are opt-in capabilities for future versions.

## Native TXAPI integration (target only)

Current theme SDK uses `/gateway/v1` and legacy Laravel upstream `/api/v1`. The future optional BFF uses `/txapi/bff/v1` against fixed private Laravel `/txapi` operations, retaining the Gateway v1 JSON envelope while Native API uses a separate schema. Theme manifest v2 and SDK baseURL migration require explicit versioned release; existing packages are unaffected. See [Integration](../docs/txapi-integration.md).

## Separation of ownership

1. TXBoard Theme Runtime owns selecting, installing and saving per-theme settings.
2. `/api/v1/guest/comm/config` exposes the active theme's **public** `theme_config`.
3. Gateway reads that public config, and returns it as `bootstrap.theme.config` / `theme/config`.
4. The theme client owns rendering the configuration, never authorization decisions.
5. TXBoard backend owns sessions, users, order state, payments and risk policies.

No secrets belong in theme manifest/config values exposed publicly. Themes must treat all metadata and user input as untrusted. A theme capability declaration is **not** an access token.

## SDK in Vue / React / plain TypeScript

```ts
import { createTXBoardClient } from '@txboard/theme-sdk'
const client = createTXBoardClient({
  baseURL: '/gateway/v1',
  getToken: () => authStore.currentBearer, // user session only
})
const { theme, site, capabilities } = await client.bootstrap()
const plans = await client.plans.list()
```

`auth.login({email, password, turnstile_token?})` returns auth data; the host theme determines where to keep it. Do not put long-term secrets in a published `config.json`. If an installation uses separate frontend origin, opt that origin into Gateway's exact CORS allowlist.

## Versioning

- Gateway `/gateway/v1` is a major-version contract. Removing/renaming existing fields requires `v2`.
- Server emits `meta.version: "1"`. SDK v1 targets that major version.
- Future theme manifest may declare `gateway: { contract: "1.x", features: ["plans.list"] }`, but this is **not** yet recognized by TXBoard Theme Runtime. Do not publish it as an installed capability today.
- Legacy TXBoard API and existing Theme Package v1 remain the rollback path throughout rollout.

## Isolation

Gateway forwards only fixed user/passport/guest paths. Admin `/api/v2/{secure_path}`, `/api/v1/server/*`, subscriptions, payment callbacks, plugin routes and WebSocket never transit the theme gateway in Phase 1.
