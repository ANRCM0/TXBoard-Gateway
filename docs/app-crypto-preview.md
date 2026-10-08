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
