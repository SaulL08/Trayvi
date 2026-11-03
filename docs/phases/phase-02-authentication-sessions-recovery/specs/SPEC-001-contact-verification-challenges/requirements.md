# SPEC-001 — Contact verification and OTP challenges — Requirements

Status: Approved (early, see requirements §7)  
Phase: `phase-02-authentication-sessions-recovery` ([PLAN.md](../../PLAN.md))  
Owners: Auth  
Last updated: 2026-11-03

## 1. Purpose

This spec delivers proof of possession of a phone number. It creates the Auth
module, protects and binds phone contact points, issues and verifies OTP
challenges, limits abuse in PostgreSQL, sends codes through a provider-neutral
port, and accepts signed provider callbacks. SPEC-002 builds sign-in and sessions
on the contact proof this spec produces. It refines PLAN §§3–8, §11, §14, and
§16–17 and does not widen them.

## 2. Scope

### 2.1 In scope

- `modules/auth` skeleton, frozen contracts, and the `auth` schema.
- `e164-v1` normalization, contact fingerprint, and contact envelope.
- Contact point domain lifecycle and repository, including the binding command
  SPEC-002 calls during registration.
- Verification challenges, OTP generation and commitment, contact proofs.
- Rate-limit buckets and the policies in PLAN §11 that apply to challenges.
- `OtpDeliveryPort` with a synthetic adapter and a global delivery budget.
- Provider callback verification and receipts, with the delivery-status handler.
- HTTP routes for challenge start, resend, verify, and provider callbacks.

### 2.2 Out of scope

- Sign-in, sessions, tokens, passwords, and registration binding: SPEC-002.
- Recovery, contact change, re-verification callbacks: SPEC-003. This spec only
  provides the callback framework they register handlers with.
- Any real SMS/WhatsApp provider (production blocker P2-AC-039).

## 3. Requirements

| Id   | Requirement                                                                                                                                                                                                                   | Traces to            | Verified by             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------- |
| R-01 | The Auth module shall keep domain, application, and infrastructure layers and shall depend on no other module's infrastructure.                                                                                               | P2-AC-001, P2-AC-002 | ws-a..ws-e              |
| R-02 | When given phone input, the normalizer shall produce exactly the PLAN §6.1 results and codes for configurations A and B.                                                                                                      | P2-AC-004            | ws-a                    |
| R-03 | The normalizer shall be idempotent: normalizing a canonical value returns the same value.                                                                                                                                     | P2-AC-004            | ws-a                    |
| R-04 | The contact fingerprinter shall reproduce the PLAN §7.1 vector, and changing any field, separator, encoding, or key shall change the output.                                                                                  | P2-AC-005            | ws-a                    |
| R-05 | If any two configured Auth or Identity key purposes share key bytes, then the Auth key configuration shall fail at startup without revealing a value.                                                                         | P2-AC-005            | ws-a                    |
| R-06 | The contact envelope shall reproduce the PLAN §7.2 vector, use a random nonce in production adapters, and reject changed ciphertext, tag, nonce, AAD, or key.                                                                 | P2-AC-006            | ws-a                    |
| R-34 | `ContactEnvelopeSealer` shall use the same envelope construction with the pending-contact AAD in design §2.1, and opening under a different owner ID shall fail.                                                              | P2-AC-006            | ws-a                    |
| R-07 | PostgreSQL shall reject a second `ACTIVE` contact point with the same `(channel, normalization profile, key version, fingerprint)` and a second `ACTIVE` primary contact for one account.                                     | P2-AC-007            | ws-a                    |
| R-08 | When 50 independent connections bind the same fingerprint to different accounts, each of 10 rounds shall commit exactly one binding and roll the others back with `CONTACT_ALREADY_BOUND`.                                    | P2-AC-007, P2-AC-031 | ws-a                    |
| R-09 | The contact point lifecycle shall allow only the PLAN §5.2 transitions, and direct SQL shall not change `state` outside the guarded function.                                                                                 | P2-AC-009, P2-AC-034 | ws-a                    |
| R-10 | The OTP generator shall produce 6 ASCII digits uniformly from a CSPRNG by rejection sampling.                                                                                                                                 | P2-AC-008            | ws-b                    |
| R-11 | The challenge store shall persist only the PLAN §8.1 commitment, which shall reproduce the vector, and verification shall compare commitments in constant time.                                                               | P2-AC-008            | ws-b                    |
| R-12 | The challenge lifecycle shall allow only the PLAN §5.3 transitions and shall enforce lifetime, attempt cap, resend count, and resend cooldown from validated configuration.                                                   | P2-AC-009            | ws-b                    |
| R-13 | When a code is verified, the system shall create exactly one contact proof bound to the challenge purpose, destination fingerprint, and installation commitment, valid for the configured proof lifetime.                     | P2-AC-009            | ws-b                    |
| R-14 | If a contact proof is presented for a different purpose, a different installation, after expiry, or a second time, then consumption shall fail and change nothing.                                                            | P2-AC-009, P2-AC-015 | ws-b                    |
| R-15 | When 50 connections submit the correct code for one challenge, exactly one proof shall be created; when 50 connections submit wrong codes, the recorded failures shall never exceed the attempt cap.                          | P2-AC-010            | ws-b                    |
| R-16 | When a new challenge starts for the same destination fingerprint and purpose, the previous `PENDING` challenge shall become `CANCELLED`.                                                                                      | P2-AC-009            | ws-b                    |
| R-17 | The rate limiter shall increment a bucket atomically in one statement and shall key buckets by an HMAC commitment under the `auth-subject-commitment` key, never by a plain phone number or address.                          | P2-AC-011            | ws-c                    |
| R-18 | The rate limiter shall implement the challenge-related dimensions and defaults of PLAN §11 as configurable policies with validated bounds.                                                                                    | P2-AC-011            | ws-c                    |
| R-19 | When a contact-dimension limit is exceeded, challenge start shall return the same `202` envelope as an accepted start and shall send nothing; network and installation limits shall return `RATE_LIMITED`.                    | P2-AC-011, P2-AC-012 | ws-c, ws-e              |
| R-20 | A simulation of an attacker using every permitted attempt for one number for one day shall succeed with probability no greater than `10 / 10^6`.                                                                              | P2-AC-011            | ws-c                    |
| R-21 | Challenge start shall not read account or contact-binding state.                                                                                                                                                              | P2-AC-012            | ws-b, ws-e              |
| R-22 | Responses to challenge start for registered, unregistered, and contact-limited numbers shall match in status, schema, size class, and headers, with timing differences inside the bound set in design §6.                     | P2-AC-012, P2-AC-035 | ws-e                    |
| R-23 | The delivery adapter shall receive the code and destination only in memory, and neither shall appear in a return value, error, log, metric, trace, or event.                                                                  | P2-AC-013, P2-AC-033 | ws-d                    |
| R-24 | If delivery fails or the global delivery budget is exhausted, then challenge start shall still return the generic envelope, the challenge shall record a safe delivery outcome code, and no retry shall resend the same code. | P2-AC-013            | ws-b, ws-d              |
| R-25 | When a callback arrives, the system shall verify size, signature, and timestamp before parsing the body.                                                                                                                      | P2-AC-014            | ws-d                    |
| R-26 | If the provider alias is unknown, the signature is wrong, or the timestamp is outside the window, then the callback shall receive one identical `401 CALLBACK_REJECTED` response.                                             | P2-AC-014            | ws-d, ws-e              |
| R-27 | When a callback repeats a `(providerAlias, kind, providerEventId)` already received, the system shall return `200` and apply no effect.                                                                                       | P2-AC-014            | ws-d                    |
| R-28 | The callback framework shall persist only parsed allowlisted fields and shall not retain the raw body.                                                                                                                        | P2-AC-014            | ws-d                    |
| R-29 | Each state change, its transition row, and its outbox event shall commit in one transaction or not at all.                                                                                                                    | P2-AC-031            | ws-a, ws-b              |
| R-30 | Outbox events from this spec shall contain only the allowlisted fields in design §2.3.                                                                                                                                        | P2-AC-032            | ws-a, ws-b              |
| R-31 | Logs, traces, metrics, Problem Details, and events shall contain none of the canary phone number, OTP, contact proof, fingerprint, or envelope bytes.                                                                         | P2-AC-033            | ws-e                    |
| R-32 | The public routes shall emit only the Problem Details codes listed in design §2.3.                                                                                                                                            | P2-AC-035            | ws-e                    |
| R-33 | Migrations `0012`–`0016` shall pass `up -> verify -> down -> up -> verify`, refuse destructive down on populated tables, and grant the runtime role only the privileges listed in design §2.2.                                | P2-AC-034            | ws-a..ws-d, integration |

## 4. Security, privacy, and abuse requirements

This spec closes these PLAN §18 threats: OTP brute force (R-10–R-15, R-20),
account enumeration (R-19, R-21, R-22), SMS pumping (R-18, R-24), contact-binding
race (R-07, R-08), forged callbacks and replay (R-25–R-28), log/trace leakage
(R-23, R-31), and database dump of contact data (R-04, R-06, R-11, R-17).

Data classes touched: phone number in memory, contact envelope, contact
fingerprint, OTP code, OTP commitment, contact-proof hash, installation
commitment, network-prefix commitment, provider event identifiers (PLAN §17).

## 5. Non-functional requirements

- Concurrency: PostgreSQL constraints and row locks decide every race; no
  process-local lock.
- Idempotency: challenge start is not idempotent by design (each start is a new
  challenge and cancels the previous one); verify is safe to retry because a
  verified challenge returns `CHALLENGE_NOT_ACTIVE` without changing state.
- Latency: challenge start does fixed work independent of account existence;
  delivery is awaited with a 3-second timeout and a safe outcome code.
- Observability: metrics use bounded labels (`purpose`, `outcome`, `dimension`);
  no subject identifiers.
- Migration safety: new schema and tables only; no rewrite of Phase 0 or Phase 1
  objects.

## 6. Open questions

| Question                                                                                                                    | Owner          | Blocks approval |
| --------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------- |
| ~~Confirm migration numbers after Phase 1 remediation merges.~~ Resolved: `0012`–`0016` (`0011` is taken by issue #6).      | Auth           | Resolved        |
| ~~Confirm whether contact crypto stays private to Auth or moves to a shared package.~~ Resolved: private to Auth (ADR-013). | Architecture   | Resolved        |
| OTP and rate-limit production defaults.                                                                                     | Trust & Safety | No (config)     |
| SMS versus WhatsApp channel set.                                                                                            | Product        | No (port)       |

## 7. Approval record

- 2026-11-03: approved by the repository owner, who explicitly asked to start the
  implementation on top of PR #4 (this spec) and PR #7 (issue #6).
- This approval is **ahead of the PLAN §1 gate**: Phase 1 has not recorded a final
  `PASS` and ADR-013 is still `Proposed`. The integration branch may be built and
  reviewed, but it shall not merge to `main` until Phase 1 records `PASS` and
  ADR-013 is accepted.
- Both blocking open questions in §6 are resolved above.
