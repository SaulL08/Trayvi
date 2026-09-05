# Trayvi — Implementation Roadmap

**Status:** Proposed revision  
**Rule:** Every phase is independently planned, implemented, audited, remediated, and documented before the next dependent phase closes.

## 1. Changes to the supplied roadmap

The original sequence is directionally strong. The revised roadmap makes five material changes:

1. **Separate identity/account lifecycle from authentication/recovery.** Both are security-critical and deserve smaller auditable boundaries.
2. **Move permissions and audit before administrative or driver approval workflows.** Sensitive workflows must not precede their control plane.
3. **Introduce service catalog before pricing.** Market-enabled service and vehicle capabilities need stable identifiers before rates reference them.
4. **Separate payment architecture from payment implementation.** Cash commission, ledger, settlement, refunds, and reconciliation require an approved financial plan before schema/code.
5. **Add pilot operations/release readiness.** Backups, incident response, key rotation, support procedures, and rollback are release requirements rather than implicit engineering tasks.

The realtime phase remains after dispatch because it projects authoritative domain state; it must not become an alternate state machine. Trust foundations begin early, while richer fraud rules come after real trip/payment signals exist.

## 2. Phase gates

Every phase contains:

1. `PLAN.md` approved for internal coherence and dependencies.
2. Implementation and reproducible migrations where applicable.
3. Unit/integration/contract/security/concurrency tests proportional to risk.
4. `IMPLEMENTATION.md` mapping delivered artifacts to acceptance criteria.
5. Independent adversarial `AUDIT.md` with evidence and severity.
6. Remediation and retest of every Critical/High finding.
7. Decision `PASS` only when no open Critical/High finding remains.

A later phase may begin exploratory planning, but cannot rely on an unpassed prerequisite.

## 3. Revised phases

| Phase | Name                                                | Principal outcome                                                                                                                                                  | Prerequisites                        |
| ----: | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
|     0 | Foundation and engineering system                   | Reproducible, secure repository; API/worker shells; DB migrations; CI; observability baseline                                                                      | Approved Phase 0 plan                |
|     1 | Accounts and identity                               | One-person/one-identity/one-account model; protected document identity; account states                                                                             | 0                                    |
|     2 | Authentication, sessions, verification and recovery | Login/challenges, rotating sessions, revocation, verification provider ports, risk-tiered recovery foundation                                                      | 1                                    |
|     3 | Authorization, audit and trust control plane        | Permission catalog, scoped grants, append-oriented audit, device/risk signals, enforcement hooks                                                                   | 1–2                                  |
|     4 | Markets, service catalog and geospatial foundation  | Country/region/market/areas/zones, feature flags, service/vehicle types, position/query/provider ports                                                             | 0, 3                                 |
|     5 | Drivers, vehicles and eligibility                   | Onboarding, evidence, approvals, expirations, suspension, capabilities, online/offline eligibility                                                                 | 1–4                                  |
|     6 | Pricing                                             | Versioned market rate cards, integer-money calculations, explainable estimate and immutable snapshot                                                               | 4                                    |
|     7 | Trip domain                                         | Idempotent request, locations, explicit lifecycle/cancellation, ownership and transition invariants                                                                | 1–4, 6                               |
|     8 | Automated dispatch and matching                     | Policy-based candidates/offers, expiry, atomic single-winner acceptance, no ordinary manual assignment                                                             | 5, 7                                 |
|     9 | Realtime trip experience and notifications          | Authorized location/events, arrival/progress projection, reconnect/resume, notification delivery                                                                   | 7–8                                  |
|    10 | Ratings and reputation                              | Completion-bound bilateral ratings, uniqueness, moderation and robust aggregates                                                                                   | 7, 3                                 |
|    11 | Admin and operations                                | Least-privilege review tools for accounts, drivers, trips, incidents, rates, zones and audit                                                                       | 3–10 as exposed                      |
|   12A | Financial architecture and ledger design            | Audited account taxonomy, journal templates, fiat/promo separation, cash obligations, earnings, holds, refunds, payouts, reconciliation and regulatory assumptions | 6–7                                  |
|   12B | Payments implementation                             | Double-entry ledger and approved payment/cash/payout provider integrations implemented only from the passed 12A design                                             | 12A, 3                               |
|    13 | Fraud engine foundation                             | Versioned signals/rules/evaluations/cases/enforcement for initial abuse scenarios                                                                                  | 3, 7–8, 12B where relevant           |
|    14 | Customer application MVP                            | Accessible customer flow from registration to rating                                                                                                               | Stable APIs 1–10, 12B scope decision |
|    15 | Driver application MVP                              | Secure driver flow from availability to trip history/earnings view                                                                                                 | Stable APIs 2–10, 12B scope decision |
|    16 | MVP hardening and pilot operations                  | E2E/load/failure/security/privacy audits, backups restore proof, runbooks, release decision                                                                        | All pilot-scope phases               |

## 4. Phase intent and non-negotiable evidence

### Phase 0 — Foundation and engineering system

No product workflows. Evidence includes fresh-clone setup, deterministic install, migrations up/down in disposable databases, health behavior, redaction tests, architecture-boundary test, CI, dependency scan, and documented recovery/operational assumptions.

### Phase 1 — Accounts and identity

Evidence must prove concurrent attempts cannot create two active identities/accounts for the same verified document. National-ID normalization and keyed fingerprinting require test vectors; ciphertext and fingerprint keys are separately managed and versioned. Duplicate attempts enter recovery/review without confirming account existence to an unauthorized caller.

### Phase 2 — Authentication, sessions, verification and recovery

Evidence must cover brute force, enumeration, OTP retry/expiry, token rotation and reuse, logout/revocation, lost-device recovery, and high-risk post-recovery restrictions. Provider callbacks are authenticated and idempotent.

### Phase 3 — Authorization, audit and trust control plane

Build a permission matrix rather than `isAdmin`. Tests cover horizontal and vertical escalation, market scoping, service principals, reason-required actions, audit redaction, and failed-action evidence. Audit readers cannot mutate records.

### Phase 4 — Markets, service catalog and geo

Villa Altagracia is seed data. Tests add a second market to prove no city logic is hardcoded. Geometry validity, coordinate bounds, spatial reference, freshness, and provider fallbacks are explicit.

### Phase 5 — Drivers and vehicles

Driver availability requires account eligibility, approvals, current documents, qualified vehicle/capabilities, market enablement, and no active enforcement. Approval and suspension require permissions/reasons/audit. Document expiry changes eligibility predictably.

### Phase 6 — Pricing

Golden tests cover rounding, minimums, boundary zones, currencies, effective time, and rate-card versioning. Client-supplied totals are ignored. Stored snapshots can explain historic estimates after rates change.

### Phase 7 — Trips

The transition matrix identifies actors, preconditions, side effects, and idempotency. Tests prove other customers/drivers cannot view or mutate a trip and terminal states cannot reopen.

### Phase 8 — Dispatch

Candidate policy inputs and exclusions are recorded without leaking precise competitor location. Mandatory database-level concurrency evidence launches at least 100 simultaneous accepts against one offer set and demonstrates exactly one assignment in repeated runs. Staff assignment is absent from normal permissions/routes.

### Phase 9 — Realtime

Realtime messages are authorized per connection and resource, ordered/versioned, resumable, bounded, and treated as projections. Location ingestion enforces plausibility/freshness/rate limits while retaining provenance for risk analysis.

### Phase 10 — Ratings

Only eligible participants in completed trips can rate once per direction within the allowed window. Aggregate changes are reproducible and moderation does not erase original evidence.

### Phase 11 — Admin

Every screen/API begins from a job-specific permission. Sensitive views minimize fields. Exports are separately permissioned, watermarked/attributed where practical, bounded, expiring, and audited. Break-glass is conspicuous and reviewed.

### Phase 12A/12B — Payments

12A is a design/audit phase and introduces no real provider integration. It cannot pass without final account taxonomy and normal sides; balanced journal templates for cash, external digital payment, Saldo Trayvi, Créditos Trayvi, mixed tender, commission, subsidy, holds, refunds, disputes, chargebacks, payouts and reversals; driver debt/limit/offset rules; principal-agent, custody, regulatory and tax assumptions; provider failure/idempotency/reconciliation contracts; permissions; threat model; and adversarial test plan.

12B implements only the audited 12A model. Property and real-database concurrency tests must prove every posted transaction balances, fiat and promotional books cannot mix, cash never creates a duplicate driver payment, payouts cannot exceed eligible funds, and idempotent retries/webhooks never double-post. Provider request success cannot be treated as settlement without reconciliation evidence.

### Phase 13 — Fraud

Signals retain provenance/confidence; rules and scores are versioned and explainable. Weak signals alone do not create irreversible enforcement. Human overrides require reasons and evidence.

### Phases 14–15 — Applications

Apps consume stable APIs and design tokens. They provide accessible, low-bandwidth, recoverable flows and never enforce the sole authorization or financial invariant. Sensitive values are protected in device storage and excluded from telemetry.

### Phase 16 — Hardening and pilot

Required artifacts include `MVP_SECURITY_AUDIT.md`, `MVP_ARCHITECTURE_AUDIT.md`, `MVP_PRIVACY_REVIEW.md`, `MVP_RELEASE_READINESS.md`, incident/support runbooks, load and failure results, restore evidence, rollback rehearsal, known-risk acceptance with owners/expiry, and explicit go/no-go.

## 5. Cross-cutting workstreams

These are acceptance criteria inside every applicable phase, not end-of-project chores:

- privacy/data inventory and retention;
- STRIDE-oriented threat modeling;
- accessibility and localization;
- API/event compatibility;
- schema migration/rollback safety;
- abuse and insider-threat tests;
- observability/alerts/runbooks;
- cost and capacity assumptions;
- dependency and secret scanning;
- Dominican legal, tax, insurance, labor, transport, payments, and privacy review by qualified counsel before pilot.

## 6. Change control

- Scope changes update the owning `PLAN.md` before significant implementation.
- Cross-cutting decisions use ADRs.
- Accepted ADRs are superseded, never silently rewritten.
- New phase dependencies and deferrals are recorded here with rationale.
- Known limitations have an owner, severity, target phase/date, and operational mitigation.
