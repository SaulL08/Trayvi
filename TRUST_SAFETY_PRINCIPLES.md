# Trayvi — Trust & Safety Principles

**Status:** Product and architecture baseline

## 1. Mission

Trust & Safety protects customers, drivers, couriers, merchants, staff, and the platform from physical harm, fraud, coercion, discrimination, account abuse, and unsafe internal intervention. It is a decision-support and enforcement capability grounded in evidence, due process, privacy, and measurable outcomes.

## 2. Governing principles

1. **Safety outranks growth.** Launch gates include safety operations, not only feature completeness.
2. **Signals are not verdicts.** A weak signal alone does not trigger irreversible punishment.
3. **Proportional response.** Friction, review, temporary limits, suspension, and permanent action correspond to confidence and harm.
4. **Explainable decisions.** Rule/policy versions, inputs, outcome, and reviewer evidence are reconstructable.
5. **Human accountability.** Reviewers have bounded permissions; overrides require reasons and audit.
6. **Minimize sensitive data.** Collect and retain a signal only for a defined safety/fraud purpose.
7. **Fairness and appeal.** Material adverse actions have review/appeal paths where safe and legally appropriate.
8. **No favoritism.** Dispatch policies are objective and versioned; ordinary employees cannot choose winners.
9. **Avoid retaliation and leakage.** Reports and reporter identity are disclosed only as necessary.
10. **Measure harm from controls.** False positives, disparate effects, abandonment, and reviewer disagreement are monitored.

## 3. Conceptual model

```text
Source evidence -> normalized RiskSignal -> versioned Evaluation
                -> recommended Action -> Review/Automation policy
                -> Enforcement -> Appeal/Expiry -> Outcome measurement
```

- A **RiskSignal** has type, subject(s), occurrence time, ingestion time, source, confidence, quality, expiry/retention, and opaque evidence reference.
- An **Evaluation** records the exact rules/model versions and normalized inputs used.
- A **Case** groups evidence and reviewer work without changing source-domain facts.
- An **Enforcement** is an explicit, time-bounded or permanent restriction applied through the owning domain's supported command.
- An **Override** never deletes history; it records actor, reason, evidence, previous decision, and new decision.

The Trust module recommends or orchestrates enforcement through authorized interfaces. It does not update accounts, drivers, payments, or trips directly in their tables.

## 4. Initial abuse and harm scenarios

| Scenario                       | Candidate evidence                                                                                                | Early responses                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Duplicate accounts/promo abuse | Verified identity fingerprint, phone/device/payment relationships, referral graph, velocity                       | Recovery path, promotion hold, review; avoid revealing linked account                   |
| Account takeover               | New device/location, session-token reuse, credential/OTP failures, profile change sequence                        | Step-up, session-family revocation, sensitive-change hold, recovery review              |
| Driver identity substitution   | Verification freshness, device change, selfie/liveness provider evidence, behavior discontinuity                  | Re-verification, temporary offline state, trained review                                |
| Fake/collusive trips           | Repeated customer-driver pairs, implausible route/time, no movement, payment/refund patterns                      | Withhold promotion/payout subject to policy, evidence review                            |
| GPS manipulation               | Impossible speed/teleport, provider integrity signals, timestamp/freshness anomalies                              | Degrade trust in location, challenge/review; never rely on one reading                  |
| Refund abuse                   | Claim history, evidence mismatch, linked accounts/instruments                                                     | Tiered evidence request and review; protect legitimate complainants                     |
| Promo laundering               | Credit grants/redemptions, linked identities/devices/instruments, transfer/withdrawal attempts, campaign velocity | Block prohibited conversion, reserve credit, review linked activity; keep fiat separate |
| Cash liability evasion         | Cash trips, liability age, driver availability, deposits/offsets, disputes, repeated non-settlement               | Enforce approved limits, review/dispute path, proportional availability restriction     |
| Payout takeover                | New destination/device, recovery/profile changes, session anomalies, payout velocity                              | Step-up, cooling-off, notification, hold and trained review                             |
| Financial insider abuse        | Adjustments, refunds, credit grants, holds/releases, exports and approval relationships                           | Dual control/limits, alerting, immutable audit, independent investigation               |
| Internal fraud                 | Unusual record access, repeated overrides, exports, relationship patterns                                         | Alert, access suspension under policy, independent investigation                        |
| Physical safety incident       | SOS/contact report, trip/location evidence, communications metadata where lawfully retained                       | Immediate safety protocol, evidence preservation, emergency escalation policy           |

## 5. Decision policy

- Automated irreversible enforcement requires multiple reliable signals, validated rules, monitored error rates, and explicit policy approval.
- New rules begin in shadow mode when feasible; expected precision/recall and affected populations are reviewed before enforcement.
- Actions have stable reason codes plus restricted reviewer notes.
- Temporary restrictions have expiry/review timestamps and cannot remain indefinitely because a queue was neglected.
- High-impact cases require separation of duties or second review according to policy.
- Staff cannot silently clear risk history, change dispatch outcomes, or remove audit evidence.
- Trust may request a financial hold or release only through a permissioned Payments command. It cannot post ledger entries, edit balances, or turn Créditos Trayvi into withdrawable Saldo.
- Financial enforcement distinguishes pending, held, available, promotional and cash-liability positions; a case decision never rewrites posted history.
- Emergency safety procedures may prioritize rapid containment but require prompt retrospective review.

## 6. Privacy, fairness, and evidence

- Relationship/graph signals use opaque IDs. Access to underlying identity/payment/location data remains in the owning domain and is purpose-scoped.
- Protected or sensitive traits are not used as risk proxies. Geographic rules are checked for unjustified disparate effects.
- Exact risk scores and detection logic are not exposed where doing so enables evasion, while affected users receive meaningful reason categories when appropriate.
- Evidence integrity includes source, timestamps, access trail, and retention/legal-hold state.
- Biometric/liveness collection requires provider and legal review, explicit purpose, retention/deletion rules, fallback handling, and bias/performance evaluation.
- Trust data is excluded from general analytics and support views by default.

## 7. Operational controls

- Queues are prioritized by potential harm, confidence, age, and service-level objective rather than reviewer preference.
- Reviewer interfaces show only necessary fields and distinguish facts, system inference, and human allegation.
- Quality sampling measures reviewer agreement, reversals, false positives, time to resolution, and repeat harm.
- Sensitive searches, reveals, exports, decisions, and overrides are audited and anomaly-monitored.
- Conflicts of interest and employee/customer relationships have escalation procedures.
- Law-enforcement/emergency requests follow a documented, authorized, legally reviewed process.

## 8. Phase integration checklist

Each domain phase documents:

- new abuse opportunities and affected parties;
- source signals created and their quality/provenance;
- safe events exposed to Trust;
- available proportionate restrictions;
- reviewer permissions and separation of duties;
- user notice, review, and appeal behavior;
- adversarial tests;
- operational metrics and residual risks.

The fraud-engine phase builds shared evaluation and case tooling. It does not postpone these domain-specific controls.

## 9. Pilot readiness requirements

Before serving real trips, Trayvi needs documented incident intake, emergency escalation, driver/customer suspension criteria, appeals, evidence access, reviewer training, queue ownership and coverage hours, law-enforcement handling, data retention/legal hold, critical dashboards/alerts, and tabletop exercises for account takeover, driver impersonation, serious trip incident, insider abuse, and service outage.
