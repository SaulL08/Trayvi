# Trayvi — Financial Architecture

**Status:** APPROVED ARCHITECTURAL DIRECTION — implementation deferred  
**Owner phase:** 12A Financial Architecture and Ledger Design  
**Implementation phase:** 12B Payments Implementation  
**Last updated:** 2026-09-04

## 1. Purpose

Define the financial boundaries and non-negotiable invariants that future pricing, payments, cash rides, driver earnings, promotional credits, refunds, payouts, settlement, and reconciliation must respect.

This document does not authorize a wallet, stored-value product, payment provider, deposit, withdrawal, card flow, payout, transfer, cryptocurrency, or production ledger implementation. Detailed journals, accounting policy, custody model, and regulatory treatment must pass Phase 12A audit before Phase 12B begins.

## 2. Product decision

Trayvi will not launch a cryptocurrency, negotiable token, parallel currency, or convertible product called “Trayvi Coin.” Product and code terminology must avoid `coin`, `crypto`, `token currency`, or equivalent concepts unless a future separately approved business and regulatory decision supersedes this one.

Two customer-facing concepts are allowed and must remain distinct:

### Saldo Trayvi

A simple product view of fiat-denominated value. The initial market displays Dominican pesos (`DOP`, `RD$`). Its legal and custody implementation remains open: depending on the final product, funds may need to be held and administered by an authorized external provider while Trayvi maintains a reconciled internal subledger.

### Créditos Trayvi

Promotional value funded or authorized by Trayvi for restricted redemption. Credits may have campaign, eligibility, market, service, expiry, maximum-use, and anti-abuse rules. By default they are not cash, deposits, transferable value, or withdrawable funds.

Displaying a DOP redemption value for credits does not turn them into fiat funds. The UI must state material restrictions and must never combine them into a single withdrawable balance.

## 3. Bounded contexts

| Context    | Owns                                                                                                                                  | Does not own                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Pricing    | Fare calculation, rate-card versions, itemized pricing snapshot                                                                       | Collection, ledger posting, driver payable, promotions funding |
| Promotions | Campaigns, grants, eligibility, expiry, redemption limits, promotional book                                                           | Fiat custody, payouts, bank/provider settlement                |
| Payments   | Payment intents, provider orchestration, financial operations, fiat ledger, holds, refunds, payouts, cash liabilities, reconciliation | Fare policy, trip lifecycle, promotion eligibility rules       |
| Trips      | Service lifecycle and reference to immutable pricing/payment handling outcomes                                                        | Monetary balances or provider state                            |
| Drivers    | Driver eligibility and presentation of financial read models                                                                          | Posting or editing earnings/balances                           |
| Trust      | Signals, evaluation, cases, recommended enforcement/holds                                                                             | Direct ledger mutation or silent balance editing               |
| Audit      | Evidence of sensitive action and outcome                                                                                              | Accounting source of truth                                     |

Pricing answers “what is economically charged and why.” Payments answers “what monetary obligation/movement occurred and how it settled.” Promotions answers “what restricted promotional value was granted or consumed.” The ledger never recalculates a historical fare from a current rate card.

## 4. Money representation

All amounts use a Money value with:

```text
amountMinor: signed integer at domain boundary; positive magnitude on journal entries
currency: ISO 4217 alphabetic code
```

- DOP amounts use minor units according to the versioned currency metadata adopted in Phase 12A; the expected initial exponent is two.
- Floating-point numbers are forbidden for storage, transport calculations, ledger arithmetic, commission, tax, or balance decisions.
- Database amounts use a type with range proven against capacity estimates, normally `BIGINT`; application code uses `bigint` or an exact decimal only at explicitly justified conversion boundaries.
- JSON APIs serialize potentially large minor-unit values as decimal strings.
- Every arithmetic operation requires identical currency unless an explicit foreign-exchange operation with separate rate/evidence is designed.
- Rounding mode and allocation of remainder minor units are explicit, deterministic, versioned, and tested.
- Display formatting is presentation logic and never parsed back as authoritative money.

## 5. Ledger model

Trayvi will use an immutable double-entry ledger as the source of truth for material financial obligations and movements.

### Core concepts

```text
FinancialOperation
├── one or more JournalTransactions
│   ├── LedgerEntry (debit)
│   └── LedgerEntry (credit)
├── business references
├── idempotency identity
└── provider/reconciliation references
```

- **LedgerBook:** an isolated accounting universe, initially `FIAT` or `PROMOTIONAL`.
- **LedgerAccount:** scoped by book, currency, owner/purpose, and lifecycle; it has an account class and normal side.
- **FinancialOperation:** the business-level intent linking trip/payment/refund/payout/promotion and all related journals.
- **JournalTransaction:** an immutable balanced posting with type, effective/recorded time, description/reason code, correlation, and reversal links.
- **LedgerEntry:** a positive amount, `DEBIT` or `CREDIT`, assigned to one account and currency.
- **Balance projection:** a rebuildable optimization derived from posted entries, never an independently editable source of truth.

### Book separation

FIAT and PROMOTIONAL transactions never share a journal. Each journal balances independently within one book and one currency. A mixed payment uses a parent FinancialOperation that links:

1. a balanced promotional redemption journal;
2. a balanced fiat collection/subsidy/obligation journal;
3. the same immutable fare and allocation references.

This prevents non-withdrawable credits from becoming withdrawable funds through an accidental transfer or shared balance column.

### Posting lifecycle

- Draft/prepared records may be changed only before posting and must not affect balance.
- A posted journal is immutable.
- Correction uses a linked equal-and-opposite reversal plus a new corrected journal when required.
- Deletion or in-place amount/account/currency mutation of a posted entry is forbidden by application and database permissions.
- A journal posts atomically with every entry and its idempotency record.
- Sum of debits equals sum of credits per journal, book, and currency.

## 6. Preliminary account taxonomy

Phase 12A must finalize accounting treatment with qualified accounting/legal input. The minimum conceptual taxonomy is:

### FIAT book

- provider/bank cash or settlement assets;
- payment-provider clearing and receivable accounts;
- driver cash-commission receivable / platform-liability settlement accounts;
- customer fiat obligation or stored-value liability, only if legally/product-approved;
- driver payable accounts separated into pending, available, and held positions;
- payout clearing;
- refund/dispute/chargeback clearing;
- platform commission/revenue accounts;
- promotion subsidy/marketing expense or contra-revenue accounts as accounting policy determines;
- taxes and other statutory obligations when approved.

### PROMOTIONAL book

- promotional grant funding/authorization;
- user promotional credit outstanding;
- reserved promotional credit;
- redeemed/expired/revoked credit under explicit policy;
- campaign-level control accounts where reconciliation requires them.

Account status may prevent new postings but never erase history. Currency is part of account identity; a DOP account cannot accept an entry in another currency.

## 7. Balance semantics

### Customer

- `Saldo Trayvi`: fiat-denominated available value, only if the approved custody/provider model supports it.
- `Créditos Trayvi`: promotional value available under current rules.
- Pending, held, expired, or restricted amounts are not silently included in “available.”

### Driver

- `earningsToday`: economic earnings from eligible completed services in the market's local reporting day; it is a report, not a ledger account balance.
- `pending`: platform obligation not yet releasable.
- `held`: amount restricted by an explicit authorized hold.
- `available`: amount currently eligible for payout after liabilities/reserves/rules.
- `cashCollected`: off-platform cash the driver reported/was expected to collect for completed services.
- `platformLiability`: amount the driver owes Trayvi, including applicable commission from cash trips.

Every displayed value identifies currency and an `asOf` time. Cached balance views must be reconcilable to ledger entries and rebuildable.

## 8. Cash ride economics

For an illustrative DOP 120 fare with DOP 100 driver economic earning and DOP 20 platform fee:

```text
customer hands driver cash:       12000 minor units
driver economic earning:          10000 minor units
driver platform liability:         2000 minor units
new digital driver payable:            0 minor units
```

The driver must not receive another DOP 100 digitally. The completion operation records evidence that cash was expected/declared collected and creates the applicable platform receivable/liability treatment atomically with the economic allocation.

The illustrative accounting direction may debit a driver receivable and credit commission revenue for the platform fee, but the exact journal depends on principal-versus-agent, tax, contractual, and collection-policy decisions. Phase 12A must approve that treatment before code.

Cash liability settlement may use approved deposits or offset future digital driver payables. Offsetting must be explicit, itemized, legally/contractually permitted, currency-consistent, and visible to the driver. It cannot silently turn a negative payable into data loss.

The cash design must define credit limits, offline eligibility, aging, collections, disputes, write-offs, market policy, and what happens when liability exceeds available earnings.

## 9. Promotions and mixed tender

Tender priority—such as credits, then Saldo Trayvi, then external payment method—is not approved by this document. Phase 12A or a product plan must define ordering, opt-in behavior, partial use, maximum redemption, expiration ordering, cancellation, and insufficient-funds behavior.

For a DOP 200 economic fare with DOP 150 promotional credit and DOP 50 customer fiat contribution:

- the PROMOTIONAL book records consumption of DOP 150 equivalent promotional value;
- the FIAT book records DOP 50 collected/receivable and DOP 150 Trayvi-funded subsidy according to accounting policy;
- driver earning is calculated from the contractual fare/commission basis, not accidentally from only the customer's DOP 50 payment;
- platform revenue, subsidy cost, customer consideration, and driver payable remain separately explainable.

A promotion may reduce driver earnings only when an explicit, versioned commercial rule and driver agreement authorize that economic allocation. It must never occur as a side effect of payment-tender ordering.

## 10. Holds, availability, and reservations

Available, pending, and held are ledger positions or derived classifications backed by reclassification journals; they are not three mutable amount fields.

- A hold references source amount, reason code, policy/case, creator, expiry/review time, and release/forfeit outcome.
- Spending/payout first creates an atomic reservation against available funds.
- Concurrent reservations cannot make an account exceed its permitted balance/credit policy.
- Expired or released holds produce explicit entries/events.
- Trust may request a hold through an authorized Payments command; it cannot update financial tables directly.

## 11. Refunds, reversals, and adjustments

- Refunds never edit or delete the original charge/journal.
- A refund is a separate operation with eligibility, amount, currency, original reference, reason, actor, state, and its own provider/reconciliation records.
- Technical reversal restores accounting effects; a commercial refund may differ and requires explicit accounting treatment.
- Partial refunds are bounded by refundable amount after previous refunds/reversals and protected against concurrency.
- Administrative adjustments are named transaction types, never “edit balance.”
- Adjustment requires elevated permission, step-up where appropriate, reason code, human-readable justification, evidence/reference, amount limits, separation of duties above thresholds, audit event, and anomaly monitoring.

## 12. Payout lifecycle

Candidate state machine for Phase 12A validation:

```text
REQUESTED -> VALIDATING -> RESERVED -> SUBMITTED -> PROCESSING -> SETTLED
                |            |            |             |
                +-> REJECTED +-> RELEASED +-> FAILED    +-> FAILED
                                                        SETTLED -> REVERSED
```

- Request does not remove funds; successful reservation reclassifies available funds atomically.
- Calling a provider does not mean payout settled.
- `SETTLED` requires authoritative provider/bank evidence and reconciliation policy.
- Failure releases or retains reservation according to known provider outcome; unknown outcome becomes investigation/reconciliation, not automatic retry.
- Retry uses the same provider/business idempotency identity.
- Destination changes trigger step-up, cooling-off/risk controls, session review, and audit.

Payment and refund state machines are finalized in Phase 12A. Provider states are mapped into Trayvi states; they do not become the domain model directly.

## 13. Provider integration and reconciliation

Provider ports may include `PaymentProvider`, `PayoutProvider`, and an approved stored-value/custody provider abstraction. Interfaces are introduced when real use cases exist, not in Phase 0.

Every provider interaction records:

- Trayvi operation and attempt ID;
- provider and merchant/account scope;
- provider object/event ID;
- idempotency key;
- requested amount/currency and safe response classification;
- timestamps, retry count, and correlation;
- reconciliation state and mismatch reason;
- protected raw evidence reference when retention is justified.

Reconciliation compares Trayvi journals/operations with provider settlement reports and bank/payout evidence. Mismatches create cases; they are never “fixed” by mutating history. The system assumes webhooks can be duplicated, delayed, reordered, forged, or permanently missing.

## 14. Idempotency and concurrency

- Financial command idempotency is scoped to principal/system, operation type, and key; a canonical request hash rejects reuse with different inputs.
- Provider event IDs are unique within provider and receiving account/environment.
- Business references enforce one allowed posting per event/type, such as one initial trip-completion allocation.
- Idempotency result and monetary mutation commit together.
- Balance-affecting commands use atomic conditional posting/reservation with database constraints and appropriate row/advisory/serializable controls.
- External calls do not occur while holding long ledger locks.
- Retries happen only when the operation's outcome is known safe or can be queried by idempotency identity.
- Duplicate completion, webhook, refund, payout, settlement, and reconciliation tests run concurrently against real PostgreSQL.

## 15. Financial invariants

1. Every posted journal balances: debits equal credits within one book and currency.
2. Funds/value never appear without an explicit authorized, attributable transaction.
3. Mutable balance columns are never the source of truth; balance projections derive from posted entries.
4. Posted entries are immutable; refunds, reversals, expiries, releases, and corrections preserve history.
5. Replaying an idempotent operation cannot duplicate monetary effect.
6. Fiat funds and promotional credits remain in separate books/accounts and never share a journal.
7. Non-withdrawable promotional credit cannot become available/withdrawable fiat accidentally or by ordinary transfer.
8. A cash-paid service creates the applicable driver-to-platform commission obligation exactly once.
9. Cash collection never creates a duplicate digital driver payable for the same earning.
10. A payout cannot reserve or settle more than the eligible available funds under the approved overdraft/liability policy.
11. Provider request success does not imply settlement; settled state requires reconciled evidence.
12. Currency mismatch cannot post; FX requires an explicit separately balanced operation and rate evidence.
13. Driver earnings, gross fare, platform fee, promotion subsidy, tax, adjustment, and customer tender remain separately explainable.
14. Administrative financial action requires explicit permission, reason, actor, evidence, and audit.
15. Every financial read model is reconstructable and reports currency plus `asOf` time.
16. Trust or Admin modules cannot write ledger entries except through authorized Payments commands enforcing all invariants.

## 16. Permissions and separation of duties

Candidate permission families:

- `balance.self.read`, `credit.self.read`;
- `payment.self.create/read`, `refund.self.request/read`;
- `driver.earnings.self.read`, `payout.self.request/read`, `payout.destination.manage`;
- `payment.ops.read`, `refund.review`, `payout.review`, `reconciliation.review`;
- `ledger.read`, `ledger.export`, `financial.adjustment.create/approve`;
- `promotion.manage`, `promotion.grant`, `promotion.revoke`;
- `financial.hold.create/release` with case/policy scope.

Ledger read does not imply restricted provider evidence access. Adjustment creation and approval are separated above defined thresholds. Production database operators do not receive an application mechanism to post arbitrary entries.

## 17. Audit and observability

Candidate audit events include:

```text
LEDGER_TRANSACTION_POSTED
LEDGER_TRANSACTION_REVERSED
PROMO_CREDIT_GRANTED
PROMO_CREDIT_RESERVED
PROMO_CREDIT_CONSUMED
PROMO_CREDIT_EXPIRED
PAYMENT_CREATED
PAYMENT_AUTHORIZED
PAYMENT_CAPTURED
PAYMENT_FAILED
PAYOUT_REQUESTED
PAYOUT_RESERVED
PAYOUT_SUBMITTED
PAYOUT_SETTLED
PAYOUT_FAILED
PAYOUT_REVERSED
REFUND_CREATED
REFUND_SETTLED
ADJUSTMENT_CREATED
ADJUSTMENT_APPROVED
CASH_LIABILITY_CREATED
CASH_LIABILITY_SETTLED
RECONCILIATION_MISMATCH_DETECTED
```

Audit contains safe opaque IDs, amount/currency when policy permits, action/outcome/reason, actor/service, correlation, and evidence reference. It never includes full payment credentials, bank account numbers, CVV, secrets, raw provider signatures, or unnecessary personal data.

Metrics include posting/reversal counts, imbalance prevention, idempotent replay, provider latency/error/unknown outcome, reconciliation age/mismatch, cash liability aging, payout failure, hold age, and privileged adjustment patterns. Currency/account/user IDs must not create unsafe or unbounded metric labels.

## 18. Financial threat model

| Threat                                  | Required architectural response                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Duplicate/reordered webhook             | Signature/timestamp verification, provider-event uniqueness, idempotent state mapping, query provider on ambiguity         |
| Double spend / balance race             | Atomic reservation/posting, account/currency locks or serializable policy, non-negative/limit invariant, concurrency tests |
| Duplicate trip completion               | Unique business posting reference and idempotent completion allocation                                                     |
| Fake/over refund                        | Original-operation linkage, cumulative refundable constraint, permission/state checks, independent review above thresholds |
| Payout account takeover                 | Step-up, verified destination, cooling-off, session/device risk, notification, hold/review, token-family revocation        |
| Administrative adjustment abuse         | No balance editor, reason/evidence, dual control, limits, alerting, immutable audit, anomaly analytics                     |
| Promo laundering                        | Separate non-withdrawable book, transfer restrictions, identity/device/payment graph signals, redemption limits            |
| Cash-liability evasion                  | Exactly-once obligation, aging/limits, eligibility enforcement, reconciled collections, dispute path                       |
| Customer/driver collusion or fake rides | Trip evidence, relationship/velocity/location signals, delayed availability/holds, review and appeal                       |
| Replay/forged provider request          | Authenticated webhook, nonce/timestamp/replay window, environment/account binding, idempotency                             |
| Provider mismatch/outage                | Internal/provider state separation, clearing accounts, reconciliation cases, bounded retry, unknown state                  |
| Credit-to-fiat conversion bug           | Separate books, prohibited cross-book journal, withdrawal eligibility checks and property tests                            |
| Insider data theft                      | Field minimization/masking, purpose-scoped access, separate evidence permission, export controls and audit                 |

## 19. Regulatory and accounting boundary

Trayvi must not assume it may hold customer funds, issue electronic money, operate a payment account, or execute withdrawals merely because the software can represent them.

The Dominican Republic's 2025 payment-system regulation defines electronic money, electronic-payment accounts, electronic-payment entities, digital-wallet providers, payment gateways, and other provider roles. This makes the custody, redemption, transfer, and branding of “Saldo Trayvi” a pre-implementation legal/product question. See the [Banco Central de la República Dominicana 2025 payment-system resolution](https://cdn.bancentral.gov.do/documents/resoluciones-jm/documents/JM250828-02.pdf) and the BCRD's [payment-system reform summary](https://www.bancentral.gov.do/a/CustomView/2647-antecedentes-y-reforma).

Phase 12A requires qualified Dominican legal, accounting, and tax review of at least:

- whether Trayvi is merchant/marketplace agent or principal for each service;
- who legally holds customer/driver funds and safeguards them;
- whether Saldo Trayvi is only a provider-backed view or a regulated payment/e-money product;
- required provider licenses/contracts and Trayvi's role with each provider;
- KYC/AML/sanctions/transaction-monitoring and suspicious-activity obligations;
- consumer disclosures, complaints, unclaimed balances, refunds, and dormancy;
- driver income, commission invoicing, withholding, ITBIS/tax treatment, and reporting;
- cash collection/offset legality and contract terms;
- data localization/retention, audit access, and incident/reporting duties.

The [Dominican Monetary and Financial Law No. 183-02](https://www.sb.gob.do/regulacion/compendio-de-leyes-y-reglamentos/ley-no-183-02-monetaria-y-financiera/) and regulations must be reviewed in their then-current form. These links are research starting points, not legal advice or a compliance determination.

## 20. Phase 12A required decisions and acceptance evidence

Before provider implementation, Phase 12A must produce and audit:

- final product/custody/regulatory model for Saldo Trayvi;
- principal-versus-agent and tax/accounting policy;
- ledger account taxonomy, normal sides, journal templates, and posting lifecycle;
- exact trip allocation journals for cash, external digital payment, Saldo, credits, mixed tender, cancellation, refund, dispute, and chargeback;
- driver pending/held/available and cash-liability rules;
- credit grant/reserve/consume/release/expire/revoke rules;
- tender priority and insufficient-funds behavior;
- payment, refund, payout, hold, dispute, and reconciliation state machines;
- provider failure/idempotency/reconciliation contracts;
- permissions, dual control, limits, audit, alerts, retention, and runbooks;
- property, integration, concurrency, failure, and adversarial test plan;
- qualified legal/accounting/tax assumptions with owner and review date.

12A fails if any material journal is unbalanced/unexplained, promotional value can become withdrawable inadvertently, cash creates double payment, an external callback can double-post, a payout can exceed eligible funds, or Critical/High audit findings remain.
