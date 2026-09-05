# Trayvi — Security Principles

**Status:** Security baseline for all phases

## 1. Security objectives

Protect people from account takeover and unsafe service interactions; protect identity, location, and financial data; prevent unauthorized state changes and insider manipulation; preserve reliable evidence; and keep essential service available under expected faults and abuse.

Security controls are server-side, deny-by-default, testable, observable, and proportionate to risk. Client validation improves usability but is never an enforcement boundary.

## 2. Data classification

| Class        | Examples                                                                                                              | Baseline handling                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Restricted   | Raw identity documents/numbers, biometrics, payment credentials, secrets, OTPs, session tokens, precise live location | Collect only with approved purpose; field/object encryption as applicable; narrowly scoped access; never logs/analytics/URLs; short explicit retention |
| Confidential | Phone/email, trip addresses/history, driver evidence, incidents, device/IP signals, earnings                          | Encryption in transit/at rest; purpose-scoped access; masked admin views; retention schedule; audited sensitive access                                 |
| Internal     | Rate drafts, operational metrics, non-public configuration                                                            | Employee/service access by role and environment                                                                                                        |
| Public       | Published service areas, public product content                                                                       | Integrity controls and normal availability protections                                                                                                 |

Every schema change identifies classification, purpose, owner, readers, retention, deletion/anonymization behavior, and whether it may appear in events or telemetry.

## 3. Identity document protection

- Normalize by issuer/type-specific rules before comparison; retain a normalization version.
- Compute a keyed fingerprint with HMAC using a secret stored outside the database. Scope uniqueness to document country, issuer/type, normalized value, and applicable identity status.
- Store `fingerprintVersion` so keys can rotate through dual-read/dual-write migration.
- Store recoverable document numbers only when a documented purpose requires them. Use authenticated envelope encryption with per-record or data-encryption keys and a managed key-encryption key.
- Separate permissions for identity verification, masked display, and exceptional reveal. Reveal requires purpose/reason and audit; most staff never receive it.
- Do not return a different public registration response that reveals whether a fingerprint already exists. Route verified claimants into secure recovery.
- Never use document numbers in resource IDs, URLs, logs, tokens, event payloads, filenames, metrics labels, or analytics.
- A dedicated ADR in Phase 1 defines cryptographic algorithms, key custody, normalization, collision/error handling, rotation, and deletion constraints.

## 4. Authentication and session controls

- Passwords, if supported, use a current memory-hard password hashing algorithm with calibrated work factors and upgrade-on-login.
- Verification and recovery responses resist account enumeration.
- OTPs are short-lived, single-use, attempt-limited, purpose-bound, and stored only as a keyed/slow verification value; plaintext OTPs are never logged.
- Access tokens are short-lived and audience/issuer constrained. Long-lived session/refresh tokens rotate, are stored hashed, and support family reuse detection and revocation.
- Sensitive actions require recent authentication or step-up verification according to risk.
- Administrative accounts require phishing-resistant MFA before production access where provider/tooling permits.
- Recovery is its own auditable risk flow, not an alternate weak login. High-risk recovery can impose temporary restrictions on identity, payout, phone, email, and password changes.
- Session views and revocation are available to users and security operations.

## 5. Authorization

- Permissions are explicit verbs over resources, for example `driver.application.review`, not broad admin booleans.
- Effective access combines role grants, market scope, ownership/relationship, resource state, account enforcement, and step-up requirements.
- Roles never bypass domain invariants.
- Service principals have separate credentials, audiences, grants, rotation, and audit identity.
- Support cannot assign trips. Any extraordinary reassignment/break-glass procedure is separately designed, strongly permissioned, reason-bound, alerted, and reviewed.
- Authorization tests cover each route and command, including horizontal access, vertical escalation, confused deputy, stale grants, and cross-market access.

## 6. Application and API security

- Parse all external data against explicit schemas; reject unsupported content types, oversized bodies, malformed coordinates, and unsafe files.
- Use parameterized database queries and allowlists for dynamic sorting/filtering.
- Browser sessions use secure cookie and CSRF protections when cookie authentication is chosen; CORS is an explicit environment allowlist and never reflects arbitrary origins with credentials.
- Mobile deep links and redirects use allowlists.
- Uploads are private by default, size/type constrained, malware-scanned where appropriate, stored outside the web root, and served through short-lived authorization.
- Webhooks verify signature, timestamp/replay window, provider identity, and idempotency before mutation.
- Rate limits combine account, device, destination, token, and IP signals according to endpoint risk. NAT/shared-network users are considered.
- Errors expose stable safe codes and correlation identifiers, not internal exceptions, queries, provider credentials, or existence of protected resources.
- Outbound requests use timeouts, bounded retries with jitter, circuit breaking where useful, and SSRF-resistant destination controls.

## 7. Secrets and cryptography

- No secret is committed, embedded in client apps, copied into tickets, or placed in normal environment examples.
- Local development uses non-production credentials. Staging and production use a managed secrets service and workload identity where available.
- Encryption/HMAC/signing keys have distinct purposes and environments, named owners, rotation procedures, version identifiers, and access logs.
- TLS protects all network traffic. Database and object-storage encryption at rest are enabled; field encryption is added for restricted values.
- Randomness comes from operating-system cryptographic generators. Custom cryptographic protocols are prohibited.

## 7A. Financial security

- Posted ledger entries are immutable and balanced; there is no generic balance-edit operation.
- Fiat and promotional-credit books are separate. Withdrawal/payout eligibility can never include non-withdrawable credits.
- Payment, webhook, refund, payout, settlement, adjustment, and reconciliation commands are idempotent and protected by database uniqueness/transaction controls.
- Provider callbacks verify signature, timestamp/replay window, environment/account binding, and unique provider event identity before changing state.
- Payout and bank-destination changes require recent authentication, step-up, risk evaluation, notification, cooling-off or review according to policy.
- High-value adjustments/refunds/payout overrides use limits and separation of duties; creators cannot self-approve above defined thresholds.
- Card/bank credentials remain tokenized at approved providers and never enter ordinary logs, audit metadata, analytics, ledger descriptions, or event payloads.
- Provider acceptance is not settlement. Unknown outcomes enter reconciliation/investigation rather than blind retry.
- Cash-liability offsets and holds use explicit authorized entries, reasons, evidence, expiry/review policy, and user-visible history.
- Recovery of an account with available funds or payout capability triggers additional controls before sensitive destination or withdrawal changes.

## 8. Logging, telemetry, and audit safety

- Structured logging uses an allowlist mindset for context and a central recursive redactor.
- The sanitizer covers case-insensitive keys and nested structures for passwords, authorization headers, cookies, tokens, OTPs, document values, payment data, biometrics, and precise locations unless a separately approved secure evidence channel exists.
- HTTP bodies are not logged by default. Query strings are treated as untrusted/sensitive.
- High-cardinality personal data is prohibited in metric labels.
- Audit records contain opaque IDs and safe metadata. Details requiring restricted evidence live in a separate protected store and are referenced.
- Redaction and safe-error behavior have automated tests, including nested and alternate-case keys.

## 9. Infrastructure and supply chain

- Environments and credentials are isolated. Production access is time-bounded, least-privilege, and logged.
- Databases/object stores are private; administrative interfaces are not exposed directly to the internet.
- Runtime containers/processes use non-root identities, read-only filesystems where possible, minimal images, dropped capabilities, and resource limits.
- Dependencies are lockfile-pinned. CI runs static checks, dependency/license review, secret scanning, and artifact provenance checks appropriate to the deployment platform.
- Builds are reproducible; production artifacts are built in CI, scanned, signed/attested when platform support is selected, and promoted rather than rebuilt per environment.
- Backups are encrypted, access-controlled, retention-bound, and restore-tested.

## 10. Security verification by phase

Every phase plan answers:

- What assets and restricted data are introduced?
- Which actors and trust boundaries change?
- What misuse/STRIDE threats apply?
- Which authorization decisions exist and where are they enforced?
- Which logs, metrics, alerts, and audit events prove control behavior?
- Which adversarial tests prevent regression?
- What residual risks remain, who owns them, and when are they revisited?

Critical and High findings block phase completion. Exceptions require an owner-approved written risk acceptance with expiry and compensating control; such acceptance cannot be invented by the implementation team.

## 11. Incident readiness

Before pilot, Trayvi needs severity definitions, on-call ownership, notification trees, containment playbooks, evidence preservation, credential/key rotation, compromised-session revocation, provider escalation, user/regulatory communication decision paths, post-incident review, and tested restoration. Security events must be correlatable without exposing the data they protect.
