# Security policy

Gateway v1 is an opt-in adapter, **not** a WAF, anonymity system or end-to-end encryption system. Use TLS on all public edges. Do not expose an unreviewed dev service to the public Internet.

Report suspected vulnerabilities privately through the repository's security advisory feature (when configured) rather than opening a public issue with credentials or exploit details.

No administrator passwords, TXBoard admin tokens, database passwords, session secrets or long-lived crypto keys are required or accepted by Gateway.

Experimental HPKE **request-only encrypted login** exists behind Docker's disabled-by-default
`compose.crypto.yaml` overlay. It is an **unreviewed preview**, not a security guarantee:
nonce replay detection is process-local and resets on restart, no distributed Redis
atomic replay, key rotation, independent audit or sufficient brute-force limiting is
implemented. Use one replica only. Encryption does not replace HTTPS, Laravel
authentication/CAPTCHA, or reverse-proxy abuse protection. Never give a real user
access to this preview until separate production security review.

Deliberately deferred protections: distributed rate limiting, CAPTCHA orchestration
beyond pass-through, durable anti-replay, order write idempotency and payment sandbox.
These are prerequisites for higher-risk operations; this prototype does not waive them.

**Before production:** validate Caddy/nginx origins, explicit CORS allowlist, limits at reverse proxy, trusted upstream URL, log collection, existing Laravel authentication / bot-defense policy, and smoke-test login/profile/theme/plan/order flows on the deployed version.
