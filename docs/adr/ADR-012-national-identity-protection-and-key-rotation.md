# ADR-012 — National Identity Protection and Key Rotation

**Status:** Accepted  
**Date:** 2026-09-11  
**Owners:** Identity, Security, Privacy, and Trayvi architecture

## Context

A Dominican national identifier has low entropy, yet Phase 1 needs equality detection and controlled
recovery for verification and rotation. Plaintext storage and unkeyed hashes would expose the value
after a database dump. Protection also has to survive key rotation without opening a duplicate-account
window or coupling the database to a specific KMS/provider.

## Decision drivers

Exact reproducible bytes, confidentiality, authenticated context binding, offline-guess resistance,
purpose-separated keys, least privilege, resumable rotation, database-enforced uniqueness, and a safe
path to deletion/crypto-erasure.

## Considered options

- Plaintext or database-native transparent encryption alone: rejected because broad database access
  could recover the identifier and equality still needs a protected representation.
- Plain/unsalted SHA-256 or a database salt: rejected because the identifier space is enumerable
  offline.
- Password hashing for equality: rejected because deterministic database uniqueness and online key
  rotation require a keyed equality construction.
- Domain-separated HMAC plus authenticated envelope encryption: selected.

## Decision

The immutable formatting profile is `do-cedula-v1`. It accepts no more than 64 Unicode scalar values,
removes only ASCII space, tab, CR, LF, and hyphen-minus, rejects every other control/confusable/
unsupported character, and requires exactly 11 remaining ASCII digits. It preserves leading zeroes
and performs no Unicode normalization, numeric conversion, checksum assertion, or legal
verification. Formatting, structural assessment (`NOT_PERFORMED` until an approved rule set exists),
and trusted verification are distinct typed results.

Equality aliases use HMAC-SHA-256 with an external 256-bit key. The exact UTF-8 input is these fields
joined by one NUL byte: `trayvi.identity-document-fingerprint`, normalization profile, country,
issuer, document type, and canonical value. Aliases store raw 32-byte output, algorithm, and key
version. Key configuration explicitly models `PRIMARY`, `LOOKUP_ACTIVE`, and `RETIRED`; exactly one
primary exists, retired keys are excluded from lookup/write, key versions and key material cannot be
reused, and every active version is computed in deterministic version order.

Each document receives a random 256-bit DEK and 96-bit nonce and is encrypted with AES-256-GCM. AAD
binds the envelope domain/schema, document ID, identity ID, country, issuer, type, and normalization
profile. The DEK is wrapped through a provider-neutral KEK port, and persistence contains only
ciphertext, nonce, tag, wrapped DEK, algorithm/schema, and KEK version. Authentication, missing-key,
invalid-envelope, or provider failure fails closed before mutation. In-memory DEK and recovered
plaintext buffers are overwritten on controlled paths.

Fingerprint HMAC, KEK/DEK encryption, and idempotency commitments use different keys and domains.
Idempotency commitments use a third HMAC key and length-framed fields; they are not uniqueness
aliases. Synthetic providers and deterministic keys/nonces are test-only. Production keys must be
external, non-exportable where supported, and granted to separate workload purposes.

HMAC rotation provisions a distinct lookup-active key, keeps old and new aliases blocking, decrypts
only inside the restricted Identity rotation boundary, inserts missing aliases idempotently, copies
the blocking state, verifies complete target-version counts, and only then permits configuration
promotion/cutover. Retirement happens only after approved retention/incident policy. Concurrency with
dual-active writers still collides on a common alias. KEK rotation uses `rewrap` to unwrap/re-wrap a
DEK without rewriting document ciphertext; content-key re-encryption is a separate procedure.

Document scope and crypto metadata are immutable except an authenticated same-state wrapped-DEK/KEK
rewrap. Blocking uniqueness is a partial PostgreSQL index over the full scope, normalization version,
key version, and fingerprint for `RESERVED`, `BOUND`, and `TOMBSTONED` claims. The general runtime
role cannot read ciphertext, fingerprint bytes, nonce, tag, or wrapped DEK.

Crypto-erasure means removing or revoking the unique wrapped DEK and clearing envelope material only
after an approved retention/legal-hold decision. It does not delete backups immediately and does not
release a blocking claim by default. A keyed tombstone is retained only for an approved duration.

## Consequences

Controlled HMAC-version backfill temporarily stores more than one alias per document. Recovery and
rotation require authorized decryption capability, so production KMS selection, quotas, auditing,
custody, and incident SLOs remain production blockers. The schema can retain equality after envelope
erasure, but the permitted tombstone duration is not guessed in code.

## Security/privacy/operational impact

A database-only compromise cannot perform offline document enumeration without the external HMAC
key and cannot decrypt envelopes without KEK access. A live workload/KMS compromise remains capable
of authorized decryption, requiring pre-production identity, monitoring, rate limits, break-glass,
and compromise procedures. Restricted values and derivatives are excluded from errors, telemetry,
safe events, analytics, URLs, and test evidence outside explicitly synthetic crypto fixtures.

## Validation and revisit triggers

Validate the published HMAC and AES-GCM vectors, every AAD/tampering mutation, wrong/missing keys,
key-purpose separation, randomized production-adapter nonce behavior, dual-alias backfill/retry,
concurrent rotation collisions, new-only cutover, KEK rewrap, grants, and leakage scans. Revisit for a
new normalization profile, authoritative checksum corpus, production KMS/HSM selection, approved
retention/erasure policy, cryptographic deprecation, or compromise.

## References

- [Phase 1 Plan](../phases/phase-01-accounts-identity/PLAN.md)
- [ADR-006](ADR-006-configuration-and-secrets.md)
- [ADR-009](ADR-009-observability-redaction-and-audit.md)
