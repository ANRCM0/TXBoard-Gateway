# Docker application layer and HPKE preview

Status: **implemented for mock CI / controlled Docker environments**, live TXBoard integration deferred by explicit product choice.

## App layer

Only exact named Laravel allowlist reads added:
- `GET /gateway/v1/user/subscription/summary` maps user/getSubscribe to a DTO without `token`, `uuid` or `subscribe_url`.
- `GET /gateway/v1/orders/:tradeNo` maps user/order/detail, sending one validated `trade_no`.
- `GET /gateway/v1/payments` maps user/order/getPaymentMethod **with user Bearer required**, and strips payment configuration fields.
- `GET /gateway/v1/notices?current=1&pageSize=5` maps user/notice/fetch, keeping `{data,total}`.
- Login, plan listing, profile and order listing keep legacy v1 behavior.
- **No** write orders, checkout, payment callbacks, admin operations, subscription full secrets or public payment list.

## Request encryption (preview, intentionally off by default)

Uses standardized [RFC 9180 HPKE](https://www.rfc-editor.org/rfc/rfc9180): DHKEM(P-256,HKDF-SHA256), HKDF-SHA256, AES-256-GCM via `@hpke/core` MIT library, not homemade symmetric cryptography.
`GET /gateway/v1/crypto/key` publishes one `kid` and public key only when configured.
`POST /gateway/v1/secure/auth/login` accepts encrypted login JSON, decrypts in Gateway, validates the same login schema and sends credentials to the unchanged Laravel login route. Only the **request body** is encrypted; normal response remains under TLS. AAD binds fixed method, Gateway path, protocol version, timestamp, kid and nonce. SDK `encryptedLogin: true` performs discovery and sealing; it **never silently falls back to plaintext login** if crypto is unavailable.

Single-replica preview anti-replay: cryptographically random 128-bit nonce, 60-second timestamp window, bounded in-memory nonce cache; duplicates return 409 and capacity exhaustion returns 503. The nonce cache **does not survive restarts and is not shared among replicas**. This preview has not received independent cryptographic review and is **not** a production replay guarantee. Do not scale beyond one replica; do not expose to public production traffic before Redis atomic anti-replay, rate limits, key rotation and security review. Always require HTTPS at ingress, even when HPKE is enabled.

Private P-256 JWK is a Docker Compose file secret, not put in JS, theme manifest or published config. Generate once:

```sh
node scripts/generate-hpke-key.mjs
docker network create txboard-gateway-private   # if needed
cp .env.example .env
# edit TXBOARD_UPSTREAM_URL and GATEWAY_ALLOWED_ORIGINS
docker compose -f compose.yaml -f compose.crypto.yaml up -d --build
```

Prefer making the key with a dedicated offline Node 22 workstation and copying it to the Docker host with restricted permissions. Securely back up the JWK before updates. The `kid` is SHA-256(public-key bytes) truncated to 24 lowercase hex chars. A restart with the same key keeps the kid; rotation currently requires intentionally replacing the key, and *all existing discovery clients must refetch*; no dual-key window. For now the SDK fetches the public key for each encrypted login.

Without crypto:
```sh
docker network create txboard-gateway-private   # if needed
cp .env.example .env
docker compose up -d --build
```
No public ports are published. Join the private proxy network from Caddy/Nginx/1Panel and proxy **only** `/gateway/v1/*` to `gateway:8787`, preserving URI. Do not expose `:8787` to Internet. Keep `/api/*`, `/s/*`, WebSockets, admin routes and payment callbacks unchanged.

`docker compose down` disables the optional component without removing TXBoard data.
`docker compose logs --tail=50 gateway` shows only startup metadata; never log request bodies or access tokens.

### Deferred production gates

- Redis atomic multi-node anti-replay and distributed rate limiting.
- Dual-key rotation, revocation, backpressure and external security audit.
- Isolated real TXBoard/Laravel/MySQL/Redis testing, error-case fixtures and browser CAPTCHA tests.
- Payment writes require separate Laravel persistent idempotency; not part of this preview.

**Build-context isolation:** `.dockerignore` excludes `secrets/`, environment
files, test fixtures and Git metadata from image build contexts. Compose mounts
the private JWK file at runtime only; it must not be copied into a Docker layer,
CI artifact or shared volume accessible by frontend containers.

### File permissions for Docker secrets

The Gateway image runs as unprivileged UID **1000**. On Linux Docker Compose,
file-backed secrets may preserve host ownership rather than applying the
Compose `uid/gid/mode` settings (bind mount limitation). When the key was
generated as root, ensure the file is readable **only** to the Gateway UID:

```sh
sudo chown 1000:1000 secrets/gateway-hpke.json
sudo chmod 600 secrets/gateway-hpke.json
```

On 1Panel/root deployments this is important; otherwise Gateway will
correctly fail startup rather than silently disabling encryption. Do not make
the key world-readable as a workaround. The Docker CI checks startup and public
key discovery with this exact non-root secret mount.

## Redis-backed replay & business-workflow increment

HPKE operation-specific AAD supports login, registration and email verification.
Redis `SET NX PX` atomically reserves each (kid, nonce) across replicas for 121s
before any Laravel operation is invoked. A replay returns **409**. Unreachable
Redis causes **503** and **never** falls back to memory. No credentials or email
address appear in Redis replay keys. The Redis-backed fixed-window account
throttle uses SHA-256 of normalized email, with atomic `INCR + PEXPIRE` Lua.

Rate policy: login 8/minute, registration 3/10 minutes,
email code 2/10 minutes **per normalized email**. No IP-based trust is inferred
from arbitrary Forwarded headers. These limits are supplemental: users can
target another account with requests, and legacy TXBoard routes bypass Gateway;
deploy Laravel-origin rate controls as well.

Public read-only business APIs added: `GET /dashboard/stats` (three counts) and
`GET /orders/:tradeNo/status` (current user's order status).

Sensitive account writes remain **off by default** and are only exposed when
`GATEWAY_ACCOUNT_WORKFLOWS_ENABLED=true` with HPKE and Redis enabled:
`POST /secure/auth/register` and `POST /secure/auth/email-code`.
The SDK automatically encrypts both operations; Laravel enforces its original
email code, invitation, whitelist and CAPTCHA policies. This Gateway does not
hold admin tokens or provide an unverified quick-buy / payment write path.

Example Docker setup with bundled private Redis (for local/staging only):
```sh
docker compose -f compose.yaml -f compose.crypto.yaml -f compose.redis.yaml up -d --build
```
For **existing 1Panel Redis**, omit `compose.redis.yaml`, supply a protected
`GATEWAY_REDIS_URL` reachable on private Docker networking, and keep its
credentials out of Git and logs. The bundled Redis uses an append-only volume,
`appendfsync always`, and noeviction policy. Proper Redis credentials, HA and
backups must still be managed by the operator. Redis replicas/failover with
asynchronous replication may lose reservations on failover; don't claim perfect
persistent anti-replay without infrastructure review.

Do not enable account writes in production without hardened ingress rate
limiting, real TXBoard CAPTCHA/email validation, trust boundary review, and
security acceptance. Billing orders still require Laravel durable idempotency.
