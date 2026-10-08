# Roadmap

## Phase 1 — Initial gateway contract, runnable service and theme SDK

- [x] Initialize independent repository and workspaces
- [x] Define a versioned API and future theme integration contract
- [x] Implement Hono server with fixed upstream adapters
- [x] Implement site/theme bootstrapping, plans, login, user profile and order list
- [x] Publish buildable TypeScript theme SDK source and minimal example
- [x] CI typecheck, tests and package build
- [ ] Integrate opt-in reverse-proxy route into TXBoard deployment after end-to-end acceptance
- [ ] Validate end-to-end with a running TXBoard instance

## Phase 2 — Gateway security policy and write operations

Redis distributed throttling and risk signals; verified upstream identity and logging; order creation only with idempotency semantics and meaningful E2E tests; more typed user/business endpoints.

## Phase 3 — Optional application-layer request protection

Design-review cryptographic protocol, public-key negotiation, AEAD and anti-replay, key rotation, browser interoperability, protocol downgrade policy and external security review. HTTPS remains required.

## Phase 4 — Theme Runtime adoption

A versioned standalone SPA theme package contract, SDK integration recipes for Vue/React/Next.js, compatibility metadata, release gates and staged rollout without breaking existing themes.
