# Architecture and trust boundaries

```text
Browser / standalone TXBoard theme
          |
       HTTPS (Caddy / Nginx)
          |
     /gateway/v1/*        legacy /api/*, /s/*, WS, callbacks
          |                              |
    TXBoard Gateway                 TXBoard existing ingress
    (Node + Hono)                         |
          |                               |
    static upstream path map              |
          +-------------------------------+
                          |
                   Laravel / Octane
                     (auth, orders,
                    themes, payments)
                          |
                    MySQL / Redis
```

The Gateway is a **transport/presentation compatibility adapter**, not a separate business backend. It does not connect to MySQL, Redis or TX-Node directly and has no administrative token. Laravel applies all business authorization and canonical mutation rules. This is consistent with TXBoard's contract-first and adapter-first architecture.

## Threat model (Phase 1)

| Threat | Initial control | Follow-up |
| --- | --- | --- |
| Route traversal and admin API exposure | Static allowlist; no arbitrary upstream URL derived from caller | Negative contract tests |
| Cross-site browser abuse | Exact allowed origins, denied unknown Origin, no credentials/CORS wildcard | Origin policy and CSRF design if cookies added |
| Oversized payloads | Request/response stream byte caps, timeout | Reverse-proxy limits |
| Token leakage | No logs of bodies, headers or tokens; forward user bearer only to user paths | Automated logging/redaction audit |
| HTTPS downgrade | Explicit upstream URL validation; HTTPS default | Full-strict origin TLS |
| Login brute force | Existing Laravel policy | Gateway + Redis distributed rate limits in Phase 2 |
| Abuse of payment/order writes | No order write route in Phase 1 | Idempotency, quotas, replay controls |
| Replay of encrypted requests | No application-layer encryption enabled | Standardized vetted protocol in Phase 3 |
| Malicious third-party themes | Gateway cannot protect against tokens already accessible to theme JS | Theme isolation, integrity, permissions and CSP |

## Operational rules

- Gateway is an **optional** service, with separate deployment and rollback.
- Same-origin preferred: Caddy forwards only `/gateway/v1/*` to Gateway.
- Bind Gateway to loopback or private container network; do not expose Node port publicly.
- Do not enable permissive CORS. Public theme resources are read without cookies.
- Set service account with minimal privileges; no Docker socket, DB credentials, admin credentials.
- Terminate TLS at the trusted proxy. When internal HTTP is unavoidable, allow it only to explicitly trusted private/loopback upstreams.
- Health checks must be local and not leak config or upstream responses.

## Later phases

Phase 2: Redis-backed rate limits; idempotency for order creation; bot defense, structured redacted audit; optional secure session architecture. Phase 3: reviewed optional application-layer encryption with public-key bootstrap, replay defense and key rotation. Phase 4: automated Theme Runtime compatibility negotiation, end-to-end against TXBoard fixtures, production rollout gating.
