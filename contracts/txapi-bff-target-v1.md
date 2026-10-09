# TXAPI BFF Target v1 — PROPOSED / NOT LIVE

> ADR-006. TXBoard 同步文档：[TXAPI BFF target](https://github.com/ANRCM0/TXBoard/blob/main/contracts/http/txapi-bff-target-v1.md) · [Gateway integration](../docs/txapi-integration.md)。

## Routing

- Future HTTPS public prefix: `/txapi/bff/v1/*` → Hono Gateway, **only**.
- All other `/txapi/*` → TXBoard Laravel. Admin, Node, Agent, payment callbacks, extensions, subscriptions, WebSocket do not transit BFF.
- Current `/gateway/v1/*` → fixed legacy Laravel `/api/v1/*` remains valid during upgrade; private upstream, static named allowlist and no proxy loop.

## Proposed operations, NOT implemented

| BFF | Laravel Native | Policy |
|---|---|---|
| GET `/txapi/bff/v1/bootstrap` | GET `/txapi/public/config` | publicRead |
| GET `/txapi/bff/v1/theme/config` | GET `/txapi/public/config` | publicRead |
| GET `/txapi/bff/v1/plans` | GET `/txapi/plans` | publicRead |
| POST `/txapi/bff/v1/auth/login` | POST `/txapi/auth/login` | login |
| GET `/txapi/bff/v1/user/profile` | GET `/txapi/me` | userRead |
| GET `/txapi/bff/v1/orders` | GET `/txapi/orders` | userRead |
| GET `/txapi/bff/v1/orders/{tradeNo}` | GET `/txapi/orders/{tradeNo}` | userRead |
| POST `/txapi/bff/v1/orders` | no upstream | disabledWrite, 405 |

Other current Gateway operations require specific new native contracts before migration. No generic wildcard proxy.

## Response formats

- Laravel native target: `{data,meta?,request_id?}` or `{error,request_id?}`.
- Gateway BFF v1 preserves current SDK: `{ok:true,data,meta:{version:"1",requestId}}` or `{ok:false,error,meta:{version:"1",requestId}}`.
- Typed adapters translate per-operation pagination/errors/field types. No raw upstream exceptions, secrets or changed Gateway v1 response schema without new version.
- User Bearer only for protected user BFF; Laravel enforces identity/ownership. Redis nonce cannot replace Laravel transaction idempotency.

## Gate

G0 contract/operation fixtures → G1 current live staging → G2 Laravel Native APIs → G3 Hono dual-stack/SDK → G4 opt-in Edge/Deploy/Theme → G5 retire unused legacy after measured zero traffic. See [ADR](../docs/txapi-integration.md).
