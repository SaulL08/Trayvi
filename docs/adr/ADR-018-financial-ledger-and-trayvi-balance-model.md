# ADR-018 — Financial Ledger and Trayvi Balance Model

**Status:** Accepted  
**Date:** 2026-09-04  
**Owners:** Trayvi product and architecture  
**Implementation:** Deferred to Phases 12A and 12B

## Context

Trayvi must support explainable pricing, cash rides, future external digital payments, driver earnings, commissions, promotional value, refunds, holds, payouts, and reconciliation. A mutable `user.balance` model cannot preserve accounting integrity, concurrency safety, or historical evidence. A proprietary “Trayvi Coin” would also create product confusion and potentially expand financial/regulatory risk without solving an MVP need.

The initial market uses Dominican pesos, but the platform is designed for multiple markets and currencies. Cash creates a special economic fact: a driver can collect the entire fare directly while owing the platform its commission, so ordinary digital-payable logic would cause double payment.

## Decision drivers

- Correct, reconstructable financial state
- Separation of customer fiat funds and non-withdrawable promotion value
- Cash-ride commission and driver-liability representation
- Idempotency and concurrency safety
- Refund/reversal evidence
- Provider reconciliation and failure tolerance
- Multi-currency evolution
- Clear customer/driver terminology
- Avoidance of premature regulated-product assumptions

## Considered options

### Mutable balance fields

Rejected. Atomic increments reduce some races but do not explain origin, preserve balanced accounting, support reliable reversals, or reconcile providers.

### Event log without double-entry constraints

Rejected as the financial source of truth. It preserves history but does not by itself prove balanced postings or prevent incomplete economic allocation.

### One shared ledger/balance for fiat and promotions

Rejected. It risks making promotional value withdrawable, obscures subsidy cost, and complicates regulatory/accounting separation.

### Trayvi Coin or convertible proprietary token

Rejected. It is unnecessary for mobility MVP, creates user confusion, and could introduce significant regulatory, custody, security, and market risk.

### Double-entry ledger with separate books

Accepted. It gives explicit accounts, balanced immutable journals, reconstructable balances, reversals, and strong separation of fiat from promotion value.

## Decision

1. Trayvi will not initially issue or market Trayvi Coin, cryptocurrency, negotiable token, or parallel currency.
2. Product terminology is **Saldo Trayvi** for fiat-denominated value and **Créditos Trayvi** for restricted promotional value.
3. Financial truth uses an immutable double-entry ledger. Cached balance projections are rebuildable and never directly edited.
4. `FIAT` and `PROMOTIONAL` are separate books. A journal cannot mix books or currencies; mixed tender is linked by one FinancialOperation containing separately balanced journals.
5. Money uses integer minor units plus ISO 4217 currency. Floating point is prohibited for monetary decisions.
6. Posted transactions and entries are immutable. Refunds, reversals, adjustments, expiries, releases, and corrections use new linked transactions.
7. Cash rides explicitly record cash collection and the applicable driver-to-platform liability. They do not create a duplicate digital driver payable.
8. Driver positions distinguish economic earnings, pending, held, available, cash collected, and platform liability.
9. Payment, webhook, refund, payout, settlement, and reconciliation operations are idempotent and concurrency-safe.
10. Provider success is not settlement. Internal state is reconciled against provider/bank evidence.
11. External providers hold/process funds when required by the approved legal/product model; ports avoid unnecessary vendor lock-in.
12. The exact account taxonomy, normal sides, journal templates, state machines, custody model, and accounting/tax policy must pass Phase 12A before financial implementation.

## Consequences

### Positive

- Balances and obligations can be reconstructed and explained.
- Cash, digital tender, credits, subsidies, commissions, and payouts remain distinct.
- Duplicate callbacks/retries can be prevented from duplicating money.
- Historical corrections retain evidence.
- Provider migration and reconciliation have explicit seams.

### Costs

- Ledger design and testing require specialist review and more disciplined APIs.
- Every new financial use case needs reviewed journal templates.
- Read models and reconciliation operations add complexity.
- Product copy must explain separate balance types and states clearly.

### Risks

- A technically balanced journal can still encode incorrect accounting; professional accounting/tax review remains mandatory.
- “Saldo Trayvi” behavior may trigger regulated payment/e-money obligations depending on custody, transfer, redemption, and provider model.
- Cash liabilities create collection, dispute, driver-retention, and fraud risks.

## Security, privacy, and operational impact

- Payout destination, recovery, refund, adjustment, promotion grant, and hold controls require explicit permissions, step-up/dual control where appropriate, audit, and anomaly detection.
- Payment/bank credentials remain provider-tokenized and are not stored in general ledger entries, logs, or audit metadata.
- Real PostgreSQL concurrency/property tests must prove balanced, idempotent posting and payout/spend limits.
- Reconciliation queues, unknown provider outcomes, cash-liability aging, and privileged adjustments require dashboards and runbooks.

## Validation and revisit triggers

Validate during Phase 12A with journal walkthroughs for every tender/refund/cash/payout scenario, property tests, concurrent adversarial cases, and qualified Dominican legal/accounting/tax review.

Revisit if Trayvi enters a new country/currency, changes principal/agent status, holds customer funds, enables transfers/withdrawals, changes cash commission collection, adds merchants/couriers, or considers any token/crypto product.

## References

- [Trayvi Financial Architecture](../architecture/FINANCIAL_ARCHITECTURE.md)
- [Saldo Trayvi and Créditos Trayvi](../product/TRAYVI_BALANCE.md)
- [BCRD 2025 payment-system resolution](https://cdn.bancentral.gov.do/documents/resoluciones-jm/documents/JM250828-02.pdf)
- [BCRD payment-system reform summary](https://www.bancentral.gov.do/a/CustomView/2647-antecedentes-y-reforma)
- [Dominican Monetary and Financial Law No. 183-02](https://www.sb.gob.do/regulacion/compendio-de-leyes-y-reglamentos/ley-no-183-02-monetaria-y-financiera/)
