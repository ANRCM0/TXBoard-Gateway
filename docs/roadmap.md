# TXBoard Gateway Roadmap

> **Current milestone:** Phase 1 implemented; Phase 1.5 (real TXBoard integration) **not completed**.  
> This page is an overview. Engineering work should follow the [full implementation plan](./implementation-plan.md) and [issue-ready backlog and acceptance matrix](./task-backlog.md).  
> Proposed schedule / gates are estimates, not production delivery promises.

## Milestones and release gates

| Gate | Stage | State | Primary deliverable | Required evidence |
| --- | --- | --- | --- | --- |
| Baseline (0.1.x) | Phase 1 – gateway skeleton and theme SDK | **Implemented** | Versioned Hono read-only adapter, login, SDK and container | Mock tests, typecheck, build and Docker smoke |
| M1 (preview) | Phase 1.5 – real TXBoard E2E and opt-in connection | **Planned** | Actual Laravel/Vue integration + deploy rollback | Real TXBoard fixtures, browser E2E, CI, optional routing |
| M2 | Phase 2A – security and observability | **Planned** | Redis limits, trusted proxy, redacted logs and alerting | Multi-instance/failure-injection/security tests |
| M3 | Phase 2B – transactions and user API | **Planned** | Read API expansion + Laravel-backed order idempotency | Payment sandbox, repeated/parallel writes, no double charge |
| M4 | Phase 3 – optional application-layer encryption | **Planned, conditional** | Vetted public-key-based request protection | ADR, security review, replay tests, key rotation |
| M5 | Phase 4 – independent theme runtime and SDK ecosystem | **Planned** | SPA theme manifest v2, framework templates, compatibility gates | Vue/React/SSR tests, old theme compatibility and rollback |

Phase 2A and 2B together implement the originally envisioned "security policy and write operations" phase; this split makes the security dependencies explicit. M4's encryption work may be rejected after threat-model review without blocking normal HTTPS use.

## Phase 1 — baseline (existing code)

- [x] Initialize independent GitHub repository and npm workspaces
- [x] Define Gateway v1 contract and draft independent-theme integration contract
- [x] Implement fixed-path Hono upstream adapters
- [x] Implement theme/site bootstrap, plans, login, user profile and read-only order list
- [x] Add framework-agnostic buildable TypeScript SDK source and example
- [x] Add CI typecheck, unit/security tests, package builds and Docker startup smoke
- [ ] Full TXBoard Laravel + Vue + MySQL/Redis browser end-to-end validation (M1)
- [ ] Opt-in reverse-proxy and rollback integration in deployment repository (M1)
- [ ] Publish SDK to npm (M5 after API stability / release decision)

## Immediate next steps (the first engineering PRs)

1. **GW-101 / GW-102:** collect real, redacted TXBoard API responses and freeze the OpenAPI + error contracts.
2. **GW-103:** produce reproducible npm lockfile and CI `npm ci` + SDK package checks.
3. **GW-104 / GW-105:** construct isolated TXBoard E2E environment and run real browser login/profile/order smoke.
4. **GW-107 / GW-108 / GW-109:** add a disabled-by-default optional proxy/SDK adapter and rehearse rollback.

Only after M1 should Gateway assume additional production traffic. Security M2 gates precede any new sensitive write API; business writes require backend persistent idempotency. Encryption cannot replace TLS, rate limits, CAPTCHA or authorization.

## Reference docs

- [Detailed implementation and rollout plan](./implementation-plan.md)
- [Task IDs, dependencies and acceptance criteria](./task-backlog.md)
- [Architecture and trust boundaries](./architecture.md)
- [Current Gateway v1 HTTP contract](../contracts/gateway-v1.md)
- [Independent theme integration draft](../contracts/theme-integration-v1.md)
- [Security statement](../SECURITY.md)
