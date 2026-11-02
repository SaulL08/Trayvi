# SPEC-003 — Account recovery and contact change — Requirements

Status: Draft  
Phase: `phase-02-authentication-sessions-recovery` ([PLAN.md](../../PLAN.md))  
Owners: Auth, Identity  
Last updated: 2026-11-02

## 1. Purpose

This spec lets a person regain control of their existing account, or change its
phone number, without creating a second account and without handing an attacker
an easy takeover path. It adds recovery cases with risk tiers, an Identity
re-verification seam, cooling-off with old-contact notice and cancel,
post-recovery restrictions, and the worker jobs that complete and expire cases.
It refines PLAN §§5.5, 12, 13, and 14 and starts only after SPEC-002 is
`integrated`.

## 2. Scope

### 2.1 In scope

- Recovery cases for Tiers 1–3 and authenticated contact-change cases, including
  decoy cases for unknown entries.
- `account_restrictions` and the real `RestrictionReader`.
- An Identity re-verification port, its synthetic provider, and the
  re-verification callback handler.
- Cancel paths through an active session or the old contact.
- Worker jobs for completion after cooling-off and for expiry.
- Recovery and contact-change routes.

### 2.2 Out of scope

- Governed human review of failed or disputed recoveries: Phase 3.
- Enforcement of `HIGH_RISK_ACTIONS` in payouts and balances: Phases 12B and
  later. This spec exposes the restriction; those phases check it.
- Any change to Phase 1 identity, document, or claim state.

## 3. Requirements

| Id   | Requirement                                                                                                                                                                                                                                      | Traces to            | Verified by             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ----------------------- |
| R-01 | The recovery lifecycle shall allow only the PLAN §5.5 transitions, and PostgreSQL shall reject any other state change.                                                                                                                           | P2-AC-026, P2-AC-034 | ws-a                    |
| R-02 | PostgreSQL shall allow at most one case per account in `OPEN`, `AWAITING_PROOFS`, or `COOLING_OFF`.                                                                                                                                              | P2-AC-029            | ws-a                    |
| R-03 | When recovery starts, the system shall return the same accepted response and a `tvc_` case handle whether or not the entry maps to an account, creating a decoy case when it does not.                                                           | P2-AC-029, P2-AC-035 | ws-a, ws-c              |
| R-04 | When recovery starts for an account with a case in `OPEN` or `AWAITING_PROOFS`, the system shall cancel that case with `SUPERSEDED` in the same transaction; a case in `COOLING_OFF` shall not be superseded.                                    | P2-AC-029            | ws-a                    |
| R-05 | Recovery starts shall be limited by `RECOVERY_START_ACCOUNT_DAY` and `RECOVERY_START_NETWORK_HOUR`, and decoy cases shall consume the same limits.                                                                                               | P2-AC-029            | ws-a                    |
| R-06 | The tier policy shall require exactly the PLAN §13.1 proofs for each tier and the identity-establishment precondition for Tiers 2–3.                                                                                                             | P2-AC-026, P2-AC-027 | ws-a                    |
| R-07 | When a new-contact proof is accepted, the system shall consume it once and store the new number only as a `SealedPhone` bound to the case, with its fingerprints.                                                                                | P2-AC-027            | ws-a                    |
| R-08 | When re-verification resolves, the case shall accept the proof only if Identity reports a match with the account's established identity; a decoy or a mismatch shall move the case to `REJECTED`.                                                | P2-AC-027            | ws-a, ws-b              |
| R-09 | If the account has an active password, then Tiers 2–3 shall require a password proof, rate limited like sign-in.                                                                                                                                 | P2-AC-027            | ws-a                    |
| R-10 | When every required proof is accepted, the case shall enter `COOLING_OFF` with the tier's duration and the system shall request a recovery notice to the current contact, if one exists.                                                         | P2-AC-027, P2-AC-029 | ws-a                    |
| R-11 | When a principal of the account or a holder of a valid `RECOVERY_CANCEL` proof for the current contact cancels during `COOLING_OFF`, the case shall become `CANCELLED` and nothing else shall change.                                            | P2-AC-029            | ws-a, ws-c              |
| R-12 | When cooling-off ends, completion shall, in one transaction: replace the contact (Tiers 2–3) or remove the password (Tier 1), revoke every family with `RECOVERY`, insert the restrictions in PLAN §13.2, write transitions, and enqueue events. | P2-AC-028, P2-AC-031 | ws-a, ws-d              |
| R-13 | If at completion the account is `SUSPENDED` or `CLOSED`, the expected contact changed, or the new number is bound elsewhere, then completion shall end the case `REJECTED` and change nothing else.                                              | P2-AC-028            | ws-a                    |
| R-14 | Completion shall never insert an account, identity, document, or second active contact; row counts before and after shall prove it.                                                                                                              | P2-AC-026            | ws-a                    |
| R-15 | `RestrictionReader` shall return restrictions whose window contains the given time, and the principal from SPEC-002 shall carry them.                                                                                                            | P2-AC-028            | ws-a, ws-c              |
| R-16 | If a principal with `CONTACT_CHANGE_BLOCKED` starts a contact change, or one with `PASSWORD_CHANGE_BLOCKED` sets a password, then the route shall return `ACTION_RESTRICTED`.                                                                    | P2-AC-028, P2-AC-030 | ws-c                    |
| R-17 | Authenticated contact change shall require recent `AAL2`, or recent `AAL1` plus a matching re-verification when no password exists, and a `CONTACT_CHANGE_NEW` proof for the new number.                                                         | P2-AC-030            | ws-a, ws-c              |
| R-18 | Contact-change completion shall follow R-12 with a 24-hour cooling-off, `CONTACT_CHANGED` revocation of other families, and the contact-change restrictions in PLAN §13.2.                                                                       | P2-AC-030            | ws-a, ws-d              |
| R-19 | The Identity re-verification port shall open a case for a target identity or for none (decoy), and shall resolve it to `MATCHED` or `NOT_MATCHED` only.                                                                                          | P2-AC-002, P2-AC-027 | ws-b                    |
| R-20 | Identity shall compare the presenter's document by normalizing and fingerprinting it in memory against the target identity's bound claims, and shall persist neither the document value nor the provider payload.                                | P2-AC-027, P2-AC-033 | ws-b                    |
| R-21 | Re-verification shall not change any Phase 1 identity, document, claim, case, or review state, and PostgreSQL shall enforce this for the runtime role.                                                                                           | P2-AC-001, P2-AC-034 | ws-b                    |
| R-22 | The re-verification callback handler shall run through SPEC-001's `CallbackIngress`, forward only allowlisted fields, and be idempotent by provider event ID.                                                                                    | P2-AC-014            | ws-c                    |
| R-23 | The completion job shall claim due cases with `FOR UPDATE SKIP LOCKED` in bounded batches, so two workers never complete one case twice.                                                                                                         | P2-AC-028, P2-AC-031 | ws-d                    |
| R-24 | The expiry job shall move non-terminal cases past their expiry to `EXPIRED`.                                                                                                                                                                     | P2-AC-029            | ws-d                    |
| R-25 | Security notices shall be requested after commit and shall never carry the case handle, codes, or numbers in logs or events.                                                                                                                     | P2-AC-033            | ws-a, ws-d              |
| R-26 | Events from this spec shall carry only the fields in design §2.3.                                                                                                                                                                                | P2-AC-032            | ws-a                    |
| R-27 | Recovery and contact-change routes shall emit only the PLAN §15 codes, and start, proof, and cancel responses shall not differ between real and decoy cases in status, schema, or size class.                                                    | P2-AC-029, P2-AC-035 | ws-c                    |
| R-28 | Migrations `0019`–`0020` shall pass `up -> verify -> down -> up -> verify` and grant the runtime role only the privileges in design §2.2.                                                                                                        | P2-AC-034            | ws-a, ws-b, integration |

## 4. Security, privacy, and abuse requirements

This spec closes these PLAN §18 threats: recovery takeover (R-06–R-13, R-17),
recovery lockout (R-04, R-05, R-11, R-24, with residual risk recorded in PLAN
§13.2), SIM swap (cooling-off and notice, R-10, R-11), and account enumeration
through recovery (R-03, R-27). The re-verification callback is subject to the
forged-callback and replay controls of SPEC-001.

Data classes touched: sealed pending contact, contact fingerprints, case handle
hash, presenter document attributes in memory only, recovery case state,
restrictions (PLAN §17).

## 5. Non-functional requirements

- Completion and expiry jobs run every 60 seconds by default, each claiming at
  most 50 cases per run.
- A case is never completed before its cooling-off end, even if the worker clock
  is ahead: the SQL predicate uses `now()` from PostgreSQL.
- Decoy cases cost the same database work as real ones up to re-verification.
- Re-verification calls to the provider are bounded by the existing delivery
  budget style: a `REVERIFICATION_GLOBAL_HOUR` limit in configuration.

## 6. Open questions

| Question                                                                                                                          | Owner           | Blocks approval |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------- |
| Confirm migration numbers after SPEC-002 integrates.                                                                              | Auth            | Yes             |
| Re-verification provider evidence shape: presenter document attributes, or a provider-side match against a document Trayvi sends. | Identity, Legal | Yes             |
| Cooling-off and restriction durations.                                                                                            | Trust & Safety  | No (config)     |
| Whether decoy re-verification may call the real provider in production (cost).                                                    | Product         | No              |
