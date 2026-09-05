# Trayvi — Project Overview

**Document status:** Baseline proposal  
**Last updated:** 2026-09-04  
**Scope:** Discovery and planning only; no functional implementation exists.

## 1. Executive summary

Trayvi is a multi-market platform for mobility and, after the mobility core is proven, delivery, errands, shipments, and local commerce. The first validation market is Villa Altagracia, Dominican Republic, but market-specific behavior must be data and configuration rather than domain code.

The recommended starting point is a TypeScript monorepo containing a modular monolith API, independently deployable user applications, and shared contracts/tooling. PostgreSQL with PostGIS is the system of record. Domain boundaries, transactional invariants, explicit state machines, outbox events, fine-grained permissions, privacy controls, and append-oriented audit evidence are established before feature breadth.

The first delivery is deliberately limited to repository and engineering foundations. It does not implement accounts, identity, trips, matching, pricing, payments, or user-facing workflows.

## 2. Repository inspection

Inspection was performed from the repository root on 2026-09-04. This section records the
historical planning baseline; see the Phase 0 implementation report for the current state.

### Observed state

- The directory contains no files or subdirectories.
- It is not a Git repository; `git status`, `git rev-parse`, and `git log` all report that no repository exists.
- There is no application code, dependency manifest, lockfile, database schema, migration, infrastructure definition, CI workflow, test suite, configuration, or documentation.
- There are no local repository instructions such as `AGENTS.md`.
- There are no existing secrets or sample environment files to assess.

### Reusable assets

There is no prior code or architecture to reuse. The supplied product brief is the only reusable artifact and is treated as the initial source of requirements, not as an implementation specification.

### What is missing

Everything required to build and operate the system remains to be created, including:

- source control initialization and governance;
- project ownership, licensing, and contribution rules;
- runtime and package-manager pins;
- monorepo structure and dependency-boundary enforcement;
- backend and client application shells;
- database, spatial support, migrations, and local development services;
- authentication, authorization, privacy, audit, and security controls;
- domain models and APIs;
- testing, linting, type checking, build, and CI;
- deployment environments, secrets management, observability, backup, and recovery;
- threat models, ADRs, runbooks, and phase evidence.

## 3. Product boundaries

### MVP objective

Validate a safe motorcycle/car mobility loop in one configured market:

1. A person creates and secures one base account.
2. The person completes the identity requirements for the requested capability.
3. An approved driver and eligible vehicle go online.
4. A customer requests and receives an explainable fare estimate.
5. Automated dispatch offers the trip to eligible drivers.
6. Exactly one driver can accept.
7. Authorized actors advance the trip through a controlled lifecycle.
8. The trip is completed, recorded, and eligible for rating.
9. Sensitive and administrative actions leave privacy-safe evidence.

### Explicitly deferred until after mobility validation

- merchant onboarding and catalogs;
- food and retail ordering;
- errands and purchase-on-behalf flows;
- courier proof of delivery;
- promotions beyond foundational extension points;
- a consumer wallet;
- multi-country launch operations;
- machine-learned matching or fraud scoring.

Deferral does not permit designing the mobility core in a way that prevents these capabilities later.

## 4. Core principles and invariants

1. **One person, one identity, one active base account.** Roles and capabilities attach to the account; they do not create separate identities.
2. **Technical IDs are opaque.** Official document numbers are never primary keys, public identifiers, URL components, or cross-domain references.
3. **Sensitive identifiers are minimized and protected.** Equality uses a versioned keyed fingerprint; recoverable values, only when necessary, use envelope encryption.
4. **Assignment is policy-driven and automated.** Ordinary staff cannot select a driver for a trip.
5. **At most one driver wins a trip.** This is a database-backed transactional invariant, not a UI convention.
6. **State changes use explicit commands and transition rules.** Status columns are never edited arbitrarily.
7. **Money uses integer minor units plus ISO currency.** Floating point is forbidden for financial amounts.
8. **Fiat and promotional value are separate.** Saldo Trayvi and non-withdrawable Créditos Trayvi use separate ledger books and are never exposed as one withdrawable balance.
9. **Financial history is immutable.** Material money/value movements use balanced ledger transactions; refunds, reversals, and adjustments create linked entries rather than editing balances.
10. **Historical decisions are reproducible.** Fare, policy, and relevant market configuration versions are snapshotted or referenced immutably.
11. **Authorization is deny-by-default and server-side.** Permissions, ownership, market scope, and resource state are all evaluated.
12. **Sensitive actions are attributable.** Audit evidence includes actor, action, target, outcome, reason where required, time, and correlation metadata without secret values.

## 5. Stakeholders and actors

- Customers
- Drivers and couriers
- Merchant owners and staff (post-MVP)
- Support agents
- Trust and Safety agents
- Operations administrators
- Security administrators
- Super administrators under exceptional controls
- External identity, messaging, maps/routing, payment, and notification providers
- Platform services and scheduled workers acting as service principals

## 6. Major risks at inception

| Risk                             | Initial response                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Duplicate or stolen identities   | Unique keyed fingerprint, verification evidence, recovery instead of duplicate creation, risk review           |
| Account takeover                 | Strong password hashing, OTP abstraction, rotating sessions, revocation, device/risk signals, step-up controls |
| Privileged insider abuse         | Explicit permissions, scoped access, mandatory reasons, immutable audit path, break-glass governance           |
| Double trip acceptance           | Atomic compare-and-set/row locking plus constraints and concurrency tests                                      |
| Location spoofing and fake trips | Provenance and quality metadata, anomaly signals, lifecycle evidence, later rules engine                       |
| Price disputes                   | Versioned rate cards and immutable, explainable pricing snapshots                                              |
| Cash commission leakage          | Do not implement before ledger, settlement, limits, collections, and reconciliation design is approved         |
| Premature distributed complexity | Modular monolith first; extract only on measured operational or scaling evidence                               |
| Sensitive-data leakage           | Data classification, log redaction, safe errors, access controls, encryption, retention rules                  |
| Local-market hardcoding          | Market, service area, feature, currency, rate, and requirement configuration in data                           |

## 7. Planning deliverables

- [Architecture vision](ARCHITECTURE_VISION.md)
- [Implementation roadmap](IMPLEMENTATION_ROADMAP.md)
- [Security principles](SECURITY_PRINCIPLES.md)
- [Trust & Safety principles](TRUST_SAFETY_PRINCIPLES.md)
- [Provisional design documentation](docs/design/README.md)
- [Provisional brand direction](docs/design/BRAND_DIRECTION.md)
- [Provisional design tokens](docs/design/DESIGN_TOKENS.md)
- [Visual reference register](docs/design/references/README.md)
- [System master plan](docs/architecture/SYSTEM_MASTER_PLAN.md)
- [Financial architecture](docs/architecture/FINANCIAL_ARCHITECTURE.md)
- [Saldo Trayvi and Créditos Trayvi](docs/product/TRAYVI_BALANCE.md)
- [ADR-018 financial ledger decision](docs/adr/ADR-018-financial-ledger-and-trayvi-balance-model.md)
- [Phase 0 plan](docs/phases/phase-00-foundation/PLAN.md)
- [ADR process](docs/adr/README.md)

## 8. Current readiness

The planning baseline is ready for authorized Phase 0 implementation. It is not yet ready for product-feature implementation, financial implementation, production deployment, or a pilot.
