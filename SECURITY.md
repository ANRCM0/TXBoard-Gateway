# Security policy

Gateway v1 is an opt-in adapter, **not** a WAF, anonymity system or end-to-end encryption system. Use TLS on all public edges. Do not expose an unreviewed dev service to the public Internet.

Report suspected vulnerabilities privately through the repository's security advisory feature (when configured) rather than opening a public issue with credentials or exploit details.

No administrator passwords, TXBoard admin tokens, database passwords, session secrets or long-lived crypto keys are required or accepted by Gateway.

Known deliberately deferred protections: rate limiting, CAPTCHA challenge orchestration beyond pass-through, application-layer encryption and replay control, order write idempotency. These are hard prerequisites for higher-risk Phase 2/3 features, not implicitly provided by Phase 1.

**Before production:** validate Caddy/nginx origins, explicit CORS allowlist, limits at reverse proxy, trusted upstream URL, log collection, existing Laravel authentication / bot-defense policy, and smoke-test login/profile/theme/plan/order flows on the deployed version.
