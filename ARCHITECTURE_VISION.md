# Trayvi — Architecture Vision

**Status:** Proposed  
**Decision horizon:** MVP through initial multi-city expansion

## 1. Architecture outcome

Trayvi will begin as a modular monolith with strict domain boundaries, backed by PostgreSQL/PostGIS and exposed through versioned HTTP APIs. Client applications are separate deployables. Background work is processed by workers using a transactional outbox; synchronous module calls are used when an immediate transaction is required. This yields simple operations now while preserving credible extraction seams later.

## 2. Proposed technology baseline

Final patch versions are pinned and compatibility-verified during Phase 0 implementation.

| Area                         | Selection                                                                  | Rationale                                                                           |
| ---------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Language                     | TypeScript, strict mode                                                    | Shared skills and contracts across API, web, and mobile; strong tooling             |
| Runtime                      | Supported Node.js LTS                                                      | Stable production lifecycle and mature ecosystem                                    |
| Package/build                | pnpm workspaces + Turborepo                                                | Deterministic installs, workspace isolation, cached task graph                      |
| Backend                      | NestJS with Fastify adapter                                                | Modules/DI and guards with efficient HTTP runtime                                   |
| Database access              | `pg` + Kysely; reviewed SQL migrations                                     | Type-safe queries while preserving explicit SQL and database constraints            |
| Primary database             | PostgreSQL with PostGIS                                                    | Transactions, constraints, indexing, and geospatial queries in one system of record |
| Background jobs              | Worker process; PostgreSQL outbox initially                                | Avoid a second source of truth; broker can be introduced on evidence                |
| Cache/ephemeral coordination | Redis only when a phase demonstrates need                                  | Useful for rate limits and realtime presence, but not required in Phase 0           |
| Web admin                    | Next.js/React                                                              | Accessible internal web application with mature ecosystem                           |
| Mobile apps                  | React Native with Expo development builds                                  | Separate customer/driver experiences with shared foundations                        |
| Contracts                    | OpenAPI generated from API, compatibility checked in CI                    | Discoverable, versioned external boundary                                           |
| Tests                        | Vitest or Jest selected by a Phase 0 spike; Testcontainers for integration | Fast unit tests plus real PostgreSQL behavior                                       |
| Observability                | OpenTelemetry, structured JSON logging, Prometheus-compatible metrics      | Vendor-neutral traces/metrics and searchable logs                                   |
| Local environment            | Docker Compose for PostgreSQL/PostGIS and observability dependencies       | Reproducible development without containerizing every edit loop                     |

The test-runner choice is the only intentional implementation spike. Its acceptance criteria are defined in the Phase 0 plan; the resulting choice must be captured in an ADR before scaffolding tests.

## 3. Repository shape

```text
apps/
  api/                 HTTP composition root
  worker/              outbox and asynchronous jobs
  admin-web/           internal operations UI shell
  customer-mobile/     introduced in its product phase
  driver-mobile/       introduced in its product phase
packages/
  config/              typed configuration and environment schema
  contracts/           API/event schemas without domain implementations
  observability/       logging, metrics, tracing, redaction
  test-support/        factories and integration harnesses
  ui/                  cross-app design tokens and primitives
modules/
  accounts/
  identity/
  auth/
  authorization/
  audit/
  trust/
  markets/
  geo/
  drivers/
  vehicles/
  service-catalog/
  pricing/
  trips/
  dispatch/
  notifications/
  ratings/
  promotions/          promotional-credit rules and isolated promotional book
  payments/            added only after approved financial design
docs/
  architecture/
  design/               provisional brand direction, tokens, and references
  product/
  security/
  adr/
  phases/
infra/
  local/
  deployment/          provider-specific assets only after environment decision
```

Directories are created only when they contain a real artifact. Empty future modules are not scaffolded merely to mirror this diagram.

### Future shared design system

The [provisional design documentation](docs/design/README.md) defines the presentation direction shared by future Customer, Driver, Business, and Admin surfaces. A future `packages/ui` implementation will organize foundations, semantic tokens, accessible components, patterns, and product-surface adaptations; it will be introduced only in the phase that needs real UI.

Design tokens and components are consumers of product state, market configuration, permissions, and feature availability. They never replace or duplicate those backend decisions. Concept screens are not implemented capabilities, and reference images are not production assets.

## 4. Domain boundaries

| Module          | Owns                                                                                       | Must not own                                           |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Accounts        | Base account, status, profile references                                                   | Credentials, official document values, driver approval |
| Identity        | Identity records, protected documents, verification cases/evidence                         | Sessions, application roles                            |
| Auth            | Credentials, challenges, sessions, recovery orchestration                                  | Driver/customer business data                          |
| Authorization   | Roles, permissions, grants, scope evaluation                                               | Business state transitions                             |
| Audit           | Append-oriented security/business evidence                                                 | Primary business state                                 |
| Trust           | Risk signals, evaluations, cases, enforcement recommendations                              | Silent mutation of source domains                      |
| Markets         | Country/region/market/service-area configuration and feature availability                  | Live driver position                                   |
| Geo             | Coordinates, provider ports, position ingestion/query policies                             | Trip assignment decisions                              |
| Drivers         | Driver application, eligibility and availability                                           | Vehicle ownership data, trip lifecycle                 |
| Vehicles        | Vehicle and document eligibility                                                           | Driver identity                                        |
| Service catalog | Service/vehicle capability definitions                                                     | Rates                                                  |
| Pricing         | Rate cards, fare estimates, immutable calculation snapshots                                | Payment capture or balances                            |
| Trips           | Trip aggregate and lifecycle                                                               | Candidate selection, provider routing implementation   |
| Dispatch        | Eligibility policies, offers, acceptance winner                                            | Arbitrary trip status editing                          |
| Notifications   | Templates, delivery requests/status                                                        | Truth of domain actions                                |
| Ratings         | Rating eligibility, submissions, aggregates                                                | Trip completion authority                              |
| Promotions      | Campaigns, grants, eligibility, expiry and promotional-credit rules                        | Fiat custody, payouts, fare calculation                |
| Payments        | Fiat ledger, payment intents, cash liabilities, holds, refunds, payouts and reconciliation | Fare calculation or promotion eligibility policy       |

Each module owns its tables and exposes application commands, queries, and published events. Cross-module SQL joins are limited to read models explicitly reviewed for ownership impact. A module may not update another module's tables.

## 5. Internal layering

Each business module follows these dependency directions:

```text
transport/adapters -> application -> domain
infrastructure     -> application/domain ports
domain             -> no framework or database dependency
```

- Transport parses/authenticates input and maps output; it does not implement business rules.
- Application services coordinate transactions, authorization context, repositories, and side effects.
- Domain code owns invariants, value objects, state transitions, and policies.
- Infrastructure implements repositories/providers and translates technical failures.

Boundary enforcement is automated through lint/import rules and architecture tests.

## 6. Data architecture

- PostgreSQL is authoritative for transactional data.
- PostGIS represents service areas, zones, and proximity queries.
- UUIDv7-compatible opaque IDs are generated centrally; database defaults provide a safe fallback if supported by the selected version.
- Every mutable aggregate includes a version for optimistic concurrency where appropriate.
- Timestamps are UTC instants; market time zones are explicit IANA identifiers.
- Money is `{ amountMinor: bigint, currency: ISO-4217 }`. APIs serialize minor amounts as decimal strings when the JavaScript safe-integer range could be exceeded.
- Material financial truth uses immutable balanced journals. `FIAT` and `PROMOTIONAL` books are isolated; cached balances are rebuildable projections and never edited as source of truth.
- Product terminology distinguishes fiat-denominated **Saldo Trayvi** from normally non-withdrawable **Créditos Trayvi**. Trayvi does not initially issue a coin, cryptocurrency, or parallel currency.
- Sensitive encrypted values store ciphertext, key identifier, algorithm/version, and necessary authenticated metadata separately from the keyed fingerprint.
- Database constraints reinforce uniqueness, referential integrity, legal states, and singleton active relationships.
- Migrations are forward-only, reviewed SQL. Destructive changes use expand/migrate/contract.
- Production access uses separate migration and runtime roles; the runtime role cannot alter schema.

The detailed [Financial Architecture](docs/architecture/FINANCIAL_ARCHITECTURE.md) is authoritative for future financial boundaries and invariants. Its implementation remains deferred to Phases 12A and 12B.

## 7. Communication and consistency

### Synchronous

Use an in-process application interface for operations requiring an immediate answer or a shared transaction. HTTP controllers call one application entry point; they do not coordinate multiple modules themselves.

### Asynchronous

Domain changes and their outbox records commit atomically. A worker publishes versioned integration events with:

- event ID;
- event type and schema version;
- aggregate type and opaque ID;
- occurrence time;
- correlation and causation IDs;
- non-sensitive payload.

Consumers are idempotent and maintain processed-event records or equivalent unique constraints. Delivery is at least once. No design assumes exactly-once delivery.

### Extraction criteria

A module becomes a service only when data ownership is clear and at least one measured need exists: independent scaling, isolation, deployment cadence, regulatory boundary, or team ownership. Extraction requires an ADR and contract/migration plan.

## 8. API conventions

- Base path `/api/v1`; breaking changes require a new version or a documented compatibility migration.
- JSON uses consistent camelCase fields, ISO-8601 UTC timestamps, and opaque resource IDs.
- Validation rejects unknown fields on commands unless forward-compatibility is explicitly intended.
- Errors use Problem Details style with stable machine-readable codes, safe messages, request ID, and field violations; no stack traces or secrets.
- Authentication identifies the principal. Authorization checks permission, ownership/scope, resource state, and relevant risk enforcement.
- `Idempotency-Key` is required for retryable creation commands such as trip request and future payment creation. Keys are scoped to principal, operation, and bounded retention; mismatched payload reuse fails.
- Cursor pagination is the default for changing collections.
- Mutating operations accept/return aggregate versions when optimistic concurrency matters.
- Rate limits are per route risk class and multiple signals, never solely IP.
- OpenAPI is generated, linted, and checked for unreviewed breaking changes.

## 9. Critical state machines

Detailed transition tables belong to their phase plans. The target trip lifecycle is:

```text
REQUESTED -> SEARCHING -> DRIVER_ASSIGNED -> DRIVER_ARRIVING
          -> CANCELLED                     -> DRIVER_ARRIVED
                                              -> IN_PROGRESS -> COMPLETED

Any non-terminal state may transition to CANCELLED only under explicit actor,
reason, timing, and fee rules. Terminal states are immutable.
```

Dispatch offers have their own lifecycle (`PENDING`, `ACCEPTED`, `REJECTED`, `EXPIRED`, `LOST`). The accepted offer and assigned trip are committed atomically. The schema prevents more than one accepted/winning offer per trip.

## 10. Deployment topology

Initial production topology uses:

- stateless API replicas behind managed TLS/load balancing;
- independently scalable worker replicas;
- managed PostgreSQL/PostGIS with private connectivity, encryption, backups, and point-in-time recovery;
- managed secrets and key management;
- object storage for encrypted driver/identity evidence using private access and short-lived signed retrieval;
- centralized logs, metrics, traces, alerts, and error reporting;
- separate development, staging, and production accounts/projects and credentials.

Availability targets, provider, region, RPO, and RTO are explicit Phase 0/operations decisions before production infrastructure is created. No production database is exposed publicly.

## 11. Security and privacy architecture

- Deny-by-default RBAC with explicit permissions and market/resource scopes.
- Administrative access uses stronger authentication and short session lifetimes.
- Break-glass actions require elevated permission, reason, correlation, alerting, and post-event review; normal support tooling cannot assign drivers.
- Passwords use a reviewed memory-hard algorithm and versioned parameters.
- Refresh/session tokens rotate and are stored hashed; reuse detection revokes the token family.
- National ID equality uses `HMAC(normalizedDocument, pepperVersionKey)`, with uniqueness scoped to issuer, country, type, and active identity policy.
- Raw document values are neither logged nor included in tokens/events/analytics.
- Encryption keys are external to the database and rotated using key identifiers.
- Retention, access purpose, subject-request handling, and legal requirements are documented before collection.
- Audit integrity is protected through append-only application privileges, restricted readers, export/retention controls, and monitoring.

See [Security Principles](SECURITY_PRINCIPLES.md) and [Trust & Safety Principles](TRUST_SAFETY_PRINCIPLES.md).

## 12. Observability and operations

Every request receives or validates a request ID and correlation ID. Logs are structured and include service, environment, version, trace identifiers, safe actor/resource identifiers, event name, outcome, and latency. A central sanitizer redacts denylisted keys and values matching sensitive formats.

Required signals evolve by phase:

- API rate, errors, and latency;
- database pool saturation and query latency;
- outbox age, retries, and dead-letter count;
- authentication failures and session anomalies;
- trip transition and dispatch acceptance outcomes;
- provider latency/error rate;
- security control failures and privileged action alerts.

Health endpoints are split: liveness proves the process loop is responsive; readiness verifies only dependencies required to accept traffic. Health responses expose no secrets or internal topology.

## 13. Architecture decisions to record

Phase 0 creates accepted ADRs for:

1. Modular monolith and extraction criteria
2. Monorepo and toolchain
3. Module boundary and ownership rules
4. PostgreSQL/PostGIS and migration approach
5. Identifier strategy
6. Money representation
7. Configuration and secrets
8. API/error/idempotency conventions
9. Transactional outbox/event strategy
10. Observability and redaction
11. Test strategy

Identity protection, authentication, trip state, and dispatch concurrency ADRs are drafted/accepted in their owning phases when evidence and implementation detail are sufficient.

[ADR-018](docs/adr/ADR-018-financial-ledger-and-trayvi-balance-model.md) is accepted early as a cross-cutting constraint: no Trayvi Coin, separate Saldo/Créditos concepts and ledger books, immutable double-entry postings, and explicit cash liabilities. It does not authorize provider or ledger implementation before Phase 12A design and audit.
