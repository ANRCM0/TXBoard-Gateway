# TXBoard Gateway HTTP Contract v1.0 (Phase 1)

**Status:** additive, public draft implemented by the Gateway service. This is a new API, not a rename of TXBoard `/api/v1`.

## Contract rules

- Base: `/gateway/v1`, same-origin behind the site's reverse proxy by default.
- JSON UTF-8; `Accept: application/json`; no cookies or implicit authentication.
- Responses are discriminated by `ok`, with stable `meta.version = "1"` and a request identifier.
- Upstream XBoard/TXBoard `status: "success"` envelopes are unwrapped **only when the status field exists**.
- Upstream HTTP errors and `status !== "success"` are converted to normalized errors, never reported as success.
- Gateway does not persist authentication state; protected endpoints require the existing Sanctum bearer from TXBoard.
- No raw arbitrary-path proxy; every upstream path is explicitly registered in code.
- No admin, payment callback, node or subscription endpoints included in Phase 1.

## Response envelope

```json
{ "ok": true, "data": {}, "meta": { "version": "1", "requestId": "uuid" } }
```

```json
{ "ok": false, "error": { "code": "UPSTREAM_ERROR", "message": "Request failed" }, "meta": { "version": "1", "requestId": "uuid" } }
```

Error codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `ORIGIN_DENIED` (403), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405), `UPSTREAM_UNAVAILABLE` (502/504), `UPSTREAM_ERROR` (upstream status or 502), `PAYLOAD_TOO_LARGE` (413), `INTERNAL_ERROR` (500).

## Phase 1 endpoints

| Route | Upstream | Data contract |
| --- | --- | --- |
| `GET /bootstrap` | guest/comm/config | `{site:{name,description,url,logo},theme:{name,config},capabilities:string[]}` |
| `GET /theme/config` | guest/comm/config | `{name,config}` |
| `GET /plans` | guest/plan/fetch | TXBoard's current plan array, amounts remain in **cents** |
| `POST /auth/login` | passport/auth/login | `{auth_data,is_admin?}` plus any other declared upstream user-auth fields |
| `GET /user/profile` | user/info | TXBoard's current user profile data |
| `GET /orders` | user/order/fetch | TXBoard's current order array (NOT a paginator) |

All routes are prefixed with `/gateway/v1`. Only `/healthz` sits outside the versioned prefix.

### Login

Body: `email`, `password` and optional TXBoard CAPTCHA fields: `turnstile_token`, `recaptcha_v3_token`, `recaptcha_data`, `email_code`. Validation and CAPTCHA adjudication still happen within Laravel. No administrator credentials are sent to or stored by Gateway.

### Protected requests

`Authorization: Bearer <TXBoard user token>`. Gateway requires a syntactically valid bearer and passes it only to the fixed user endpoints; **Laravel remains the authorization authority**. Token never logged and never sent to guest routes.

### Limitations and compatibility

- Active theme public values derive from TXBoard `theme_config`, not old global appearance settings.
- Theme packages do not define arbitrary API routes or privileged scopes. SDK features are explicit.
- Current Phase 1 `orders.list` is read-only; no order creation, payment/checkout, registration or logout endpoint.
- `status`-envelope data may be arrays or objects. SDK treats them as opaque typed TXBoard data until versioned domain schemas are ratified.
- Phase 2 will add request limiting, replay protection and carefully idempotent write operations. Optional application-layer encryption needs a separately reviewed protocol; it is not a security property of Phase 1.
