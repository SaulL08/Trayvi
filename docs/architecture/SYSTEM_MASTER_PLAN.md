# Trayvi — System Master Plan

**Status:** Proposed master blueprint  
**Scope:** Target architecture and delivery controls; implementation starts only after Phase 0 plan approval.

## 1. Objectives

- Deliver a safe, commercially credible mobility MVP for a configurable initial market.
- Preserve the one-person/one-identity/one-account invariant across customer and provider roles.
- Make automated, objective dispatch the normal and only ordinary assignment path.
- Provide strong transactional integrity for identity, trips, dispatch, and future money movement.
- Establish privacy, security, Trust & Safety, observability, and audit as foundations.
- Support multiple markets without early microservice or configuration-platform overengineering.

## 2. Scope and exclusions

The master plan covers product boundaries, modules, data ownership, API/event conventions, critical flows, state machines, permissions, threats, operations, testing, migrations, and phase governance.

It does not approve a production cloud/provider, legal compliance posture, final payment/cash journals or custody model, biometric vendor, routing vendor, or final service pricing. The financial direction—no Trayvi Coin, separate fiat/promotional books, and an immutable double-entry ledger—is accepted, while detailed accounting, provider, tax, and regulatory decisions remain gated by Phase 12A and qualified review.

## 3. System context

```text
Customer app ----\
Driver app -------+--> Edge/API --> Modular monolith --> PostgreSQL/PostGIS
Admin web --------/          |              |                  |
                              |              +--> Outbox --> Worker
                              |                              /  |  \
                              +--> Realtime gateway        SMS Maps Payments*

* Payments are introduced only after Phase 12A approval.
```

External providers are behind typed ports and adapters. Provider-specific payloads do not enter domain models. Every callback is authenticated, replay-protected, idempotent, and observable.

## 4. Component model

The [Architecture Vision](../../ARCHITECTURE_VISION.md) is authoritative for module ownership and layering. The initial runtime units are:

- **API:** authentication boundary, versioned HTTP endpoints, application commands/queries.
- **Worker:** outbox relay, notifications, expirations, scheduled verification/eligibility work.
- **Admin web:** internal UI using the same authorized APIs; never direct database access.
- **Customer/driver apps:** separate application experiences added late against stable contracts.
- **PostgreSQL/PostGIS:** transactional truth and initial geospatial engine.
- **Redis/realtime infrastructure:** deferred until justified by the realtime/rate-limit design.

### Product presentation and design-system boundary

The [provisional design documentation](../design/README.md) is the official current presentation reference. Future Customer, Driver, Business, and Admin applications share brand foundations, semantic tokens, accessibility requirements, and interaction principles while retaining layouts appropriate to each audience.

The design system is a presentation-layer dependency. It does not own service availability, market configuration, authorization, pricing, trip state, or any other domain truth. A UI surface renders a capability as operational only when the backend exists, its owning phase has passed audit, the active market is operationally ready, and feature configuration enables it. Concept mockups never override those conditions.

Phase 0 records this boundary but does not implement user applications, components, or a token package. The current raster concepts remain reference material and are not production assets.

## 5. Core conceptual data model

This is a boundary map, not a substitute for phase-level schemas.

| Aggregate/entity                                  | Key relationships and constraints                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                                           | Opaque ID; lifecycle state; many role/capability relationships; at most one active person identity                                                   |
| PersonIdentity                                    | Belongs to account; verification status; identity assurance; protected document references                                                           |
| IdentityDocument                                  | Country/issuer/type; encrypted value optional; keyed fingerprint/version; verification evidence; uniqueness policy                                   |
| Credential/Session                                | Owned by Auth; hashed secret/token material; rotation family; revoked/expiry state                                                                   |
| Role/Permission/Grant                             | Explicit permission mapping with optional market/resource scope and validity window                                                                  |
| AuditEvent                                        | Append-oriented event ID, actor, action, target, outcome, time, reason code, correlation, safe metadata                                              |
| RiskSignal/Evaluation/Case/Enforcement            | Provenance, confidence, versions, evidence references, lifecycle, owner/reviewer                                                                     |
| Country/Region/Market                             | Locale, time zone, currency, operational status; no city constants in code                                                                           |
| ServiceArea/Zone                                  | Valid PostGIS geometry, market ownership, effective/active state                                                                                     |
| ServiceType/VehicleType/MarketService             | Stable capability codes; per-market enablement and requirements                                                                                      |
| DriverProfile/Application                         | Account link, review/eligibility state, no duplicate active driver profile per account                                                               |
| Vehicle/DriverVehicle                             | Ownership/use and verification periods; capability eligibility                                                                                       |
| DriverPosition/Availability                       | Spatial point, recorded/received time, quality/source; bounded freshness                                                                             |
| RateCard/RateRule                                 | Market/service/zone/effective version; integer money and deterministic rounding                                                                      |
| FareEstimate/PricingSnapshot                      | Inputs, route/provider facts, itemized result, currency, policy/rate versions, expiry                                                                |
| Trip                                              | Customer, market/service, immutable requested locations/snapshots, assigned driver/vehicle, version/state                                            |
| DispatchRound/Offer                               | Candidate policy version, safe factor evidence, expiry/outcome; at most one winner per trip                                                          |
| TripEvent                                         | Transition evidence, actor, previous/new state, time, reason, aggregate version                                                                      |
| Rating                                            | Trip and rater/ratee direction; uniqueness; moderation state; immutable original submission                                                          |
| OutboxEvent                                       | Event/schema version, aggregate, safe payload, attempts, published time                                                                              |
| FinancialOperation/JournalTransaction/LedgerEntry | Deferred implementation; immutable balanced postings linking business, idempotency and provider evidence                                             |
| Fiat LedgerBook/Account                           | Saldo, provider clearing, driver pending/held/available payables, cash liabilities, revenue/subsidy/refund/payout accounts; one currency per account |
| Promotional LedgerBook/Account                    | Créditos Trayvi grants, reservations, consumption, expiry/revocation; cannot become withdrawable fiat                                                |

## 6. Primary workflows

### 6.1 Registration and identity claim

1. Auth applies enumeration-safe rate limits and verifies a contact factor through a provider abstraction.
2. Accounts creates a pending base account idempotently.
3. Identity normalizes a document under an issuer/type/version policy.
4. Identity computes a versioned keyed fingerprint outside logs and normal events.
5. A transaction checks/claims uniqueness and records verification workflow/evidence.
6. If already claimed, no second identity/account is activated; the caller receives a safe recovery route.
7. Successful activation emits minimal events and append-oriented audit evidence.

The exact order of pending-account cleanup and verified-document claim is finalized in Phase 1 to avoid orphan/lockout behavior.

### 6.2 Driver onboarding and availability

1. The account requests a driver capability.
2. Required documents and vehicles are evaluated against versioned market/service requirements.
3. Authorized reviewers approve/reject evidence with reason; the system computes eligibility.
4. Going online re-evaluates account, driver, document, vehicle, market, capability, enforcement, and active-trip conditions.
5. Eligibility changes automatically force or schedule safe unavailability and generate audit/domain events.

### 6.3 Estimate and trip request

1. Customer submits market/service, pickup/destination, and idempotency key.
2. Geo validates coordinates/service areas and obtains distance/duration through a provider port.
3. Pricing selects effective rate policy and produces itemized integer-money output.
4. Pricing stores an immutable/versioned snapshot with input/provider facts.
5. Trips validates customer/market eligibility and atomically creates the trip referencing the snapshot.
6. Dispatch begins only from committed trip evidence via outbox/application coordination.

### 6.4 Automated dispatch and acceptance

1. Dispatch reads eligible, fresh candidates using market/service/vehicle/zone and policy constraints.
2. It creates a round and offers with expirations, recording policy version and safe decision factors.
3. Drivers accept or reject voluntarily.
4. Acceptance transaction locks/compares trip and offer versions, validates both remain eligible, creates the single accepted winner, assigns the trip, invalidates competing offers, and writes events/outbox.
5. Losing/replayed attempts receive a stable non-sensitive outcome.
6. No support/operations command selects a driver. A future emergency reassignment flow requires its own design, permissions, reason, alert, and audit.

### 6.5 Trip execution

Only transition commands can change trip state. Each checks authenticated actor relationship, required prior state/version, driver/vehicle eligibility where relevant, location/time evidence policy, and idempotency. Changes, trip event, audit event when sensitive, and outbox event commit consistently.

## 7. Trip and offer state rules

Phase 7 owns the final transition matrix. Minimum invariants are:

- terminal trips (`COMPLETED`, `CANCELLED`) never transition;
- only the assigned driver can send driver lifecycle commands;
- only the owning customer or an explicitly privileged case workflow can cancel as that actor type;
- `IN_PROGRESS` requires assigned driver and accepted offer;
- `COMPLETED` requires prior `IN_PROGRESS` and a final pricing/payment-handling decision;
- assignment is immutable except through a separately designed, evidence-preserving recovery/re-dispatch flow;
- no accepted offer may exist without matching trip assignment in the same transaction;
- expired/rejected/lost offers cannot win;
- retries return the prior result or a deterministic conflict, never duplicate effects.

### Financial boundary

Pricing produces an immutable economic explanation; it does not collect funds or create balances. Future Payments records fiat obligations and movements through a double-entry ledger. Future Promotions owns eligibility and restricted Créditos Trayvi, while its promotional book remains isolated from withdrawable fiat.

Cash completion must record the applicable driver-to-platform commission liability exactly once and must not create a duplicate digital driver payable. Refunds, reversals, holds, releases, expiries, adjustments and payouts create attributable entries; posted history is never rewritten. Mixed tender links separately balanced FIAT and PROMOTIONAL journals through one FinancialOperation.

The user-facing terms are **Saldo Trayvi** for fiat-denominated value and **Créditos Trayvi** for promotional value. Trayvi does not initially implement “Trayvi Coin,” cryptocurrency, or a parallel currency. Detailed account taxonomy, journals, custody/legal model and provider state machines must pass Phase 12A before financial implementation begins. See [Financial Architecture](FINANCIAL_ARCHITECTURE.md) and [Saldo Trayvi and Créditos Trayvi](../product/TRAYVI_BALANCE.md).

## 8. Permission model baseline

Roles are grant bundles, not code shortcuts. Initial permission families include:

- `account.self.read/update`, `session.self.read/revoke`;
- `identity.self.submit/status`, `identity.review`, `identity.restricted.reveal`;
- `driver.self.apply`, `driver.application.review`, `driver.suspend`;
- `vehicle.self.manage`, `vehicle.review`;
- `market.read/manage`, `zone.read/manage`, `rate.read/manage/publish`;
- `trip.self.request/read/cancel`, `trip.driver.read/transition`, `trip.ops.read`;
- `dispatch.offer.self.read/respond`, `dispatch.policy.manage`;
- `rating.self.create/read`, `rating.moderate`;
- `audit.read`, `audit.export`;
- `risk.case.read/review`, `enforcement.apply/override`;
- future `payment.*`, `ledger.*`, `payout.*`, `refund.*`, `financial.adjustment.*`, and `promotion.*` permissions with separation of duties.

Permissions additionally evaluate scope and subject relationship. `SUPER_ADMIN` is not an unconditional application bypass. Emergency powers are explicit permissions protected by step-up, reason, alert, and review.

## 9. API surface by capability

Exact resources are planned per phase. Expected groups are:

- `/api/v1/accounts`, `/sessions`, `/verification-challenges`, `/recovery-cases`;
- `/identities` with restricted document subresources never addressed by document number;
- `/markets`, `/service-areas`, `/zones`, `/service-types`;
- `/driver-profile`, `/driver-applications`, `/vehicles`, `/driver-availability`;
- `/fare-estimates`, `/trips`, `/trips/{id}/transitions` or semantic command routes;
- `/driver/offers` and response commands;
- `/ratings`;
- `/admin/...` resources that still pass through shared application authorization;
- `/health/live`, `/health/ready`, and separately protected operational metrics.

Public resource responses are explicit view models; database rows and encrypted/internal risk fields are never serialized directly.

## 10. Transaction and concurrency strategy

- Commands establish one clear transaction boundary in the owning application service.
- Database unique/check/foreign-key constraints are mandatory defense for enforceable invariants.
- Optimistic version checks handle ordinary concurrent edits.
- Pessimistic row locks or atomic conditional updates protect contested winner/ledger transitions.
- Idempotency records and business mutation commit together. Stored request hashes reject key reuse with a different payload.
- External network calls are not made while holding long database locks. Prepare/confirm patterns and outbox work isolate them.
- Deadlocks/serialization conflicts use bounded, observable retries only for safe idempotent operations.
- Concurrency tests run against real PostgreSQL/PostGIS, not an in-memory substitute.

## 11. Migration and compatibility plan

- Numbered/timestamped SQL migrations are immutable after shared deployment.
- CI applies all migrations from an empty database and upgrades from the previous release fixture.
- Each migration declares lock/table-rewrite risk and rollback/roll-forward strategy.
- Destructive schema changes use expand/migrate/contract across releases.
- API/event fields are additive by default. Consumers tolerate additive fields; event schema versions change on incompatible semantics.
- Data backfills are restartable, observable, bounded, and separate from request transactions.

## 12. Threat model summary

### Assets

Identity/contact data, credentials/sessions, live and historic location, driver documents, trip safety/evidence, pricing and financial records, dispatch fairness, privileged access, audit integrity, and service availability.

### Actors

Legitimate/compromised users and drivers, fraudulent colluding groups, malicious outsiders, curious/malicious employees, third-party providers, service principals, and operators.

### Trust boundaries

Mobile/web to API; API to database/cache/providers; provider callbacks to API; worker/event delivery; employee device to admin; CI to artifact/environment; application to key/secrets services.

### Principal threats and controls

| STRIDE area            | Examples                                                      | Planned controls                                                                          |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Spoofing               | ATO, driver impersonation, forged provider callback           | Strong auth/session controls, step-up, signed callbacks, device/risk evidence             |
| Tampering              | Client price/status edits, GPS manipulation, audit alteration | Server recomputation, state commands, constraints, provenance, append-only audit controls |
| Repudiation            | Denied acceptance/admin action                                | Correlated domain/audit events, actor/service identity, reason and outcome                |
| Information disclosure | National ID/location/log leaks                                | Minimization, envelope encryption, HMAC fingerprint, scoped views, redaction, retention   |
| Denial of service      | OTP abuse, trip spam, expensive geo queries                   | Risk-tier rate limits, quotas, query bounds, backpressure, provider timeouts              |
| Elevation of privilege | `isAdmin`, IDOR, cross-market access                          | Explicit permission+scope+relationship checks, route matrix tests, no direct DB admin UI  |

Residual physical safety, provider, legal, and sophisticated collusion risks cannot be eliminated by architecture alone; they require operations, insurance/legal advice, response coverage, and ongoing measurement.

## 13. Test strategy

- **Unit:** value objects, policies, calculations, state transitions.
- **Integration:** SQL repositories, migrations, constraints, encryption adapters, PostGIS, outbox.
- **API/contract:** validation, authentication, authorization, errors, idempotency, OpenAPI compatibility.
- **Concurrency:** duplicate identity, single dispatch winner, state updates, ledger posting.
- **Security/adversarial:** enumeration, IDOR, privilege escalation, replay, injection, unsafe upload/webhook, sensitive logging.
- **E2E:** critical customer/driver/admin flows with real dependencies except controlled external provider fakes.
- **Property/fuzz:** money/ledger invariants, transition sequences, parsers/normalizers.
- **Performance/failure:** geo/dispatch load, dependency latency, retries, worker backlog, failover and recovery.

Tests protect named invariants. Coverage thresholds may identify gaps but cannot replace behavioral evidence.

## 14. Observability and audit plan

Application logs, domain events, and audit evidence have different purposes and retention/access policies. Correlation links them through opaque IDs. Required design properties:

- no restricted secrets/data in general telemetry;
- every critical command exposes success/failure counters and latency;
- audit records include attempted denied sensitive actions when useful;
- outbox lag and failures page before business events are silently delayed;
- authentication, authorization, dispatch, payment, and privileged anomalies have alerts and runbooks;
- dashboards use low-cardinality dimensions and market/service codes, not personal identifiers.

## 15. Definition of system-level readiness

The mobility MVP is not ready merely when the happy path works. Readiness requires passed phase gates, no open Critical/High findings, qualified legal/operational decisions, restore and rollback evidence, capacity/error budgets, security/architecture/privacy audits, incident tabletop results, staffed support/safety ownership, and explicit release approval.
