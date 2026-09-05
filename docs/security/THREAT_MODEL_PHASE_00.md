# Phase 0 Threat Model

## Scope and assets

This model covers repository/CI integrity, dependencies, configuration secrets, database credentials,
technical outbox data, logs, traces, metrics, and build/test artifacts. Phase 0 has no user identity,
authorization, or product data flow.

## Actors and trust boundaries

Actors are developers, CI, runtime/migration database principals, package/image publishers, external
callers, telemetry infrastructure, and a compromised workstation or dependency. Boundaries are
inbound HTTP to API, configuration to process, runtime to PostgreSQL/telemetry, registries to CI, and
repository changes to executable artifacts.

## Principal threats and controls

| Threat                       | Baseline control                                                                               | Residual risk                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Secret committed or logged   | ignore policy, repository/history scan, blank examples, recursive final-boundary redaction     | provider-specific detectors and hosted scan evidence remain CI/audit work |
| Dependency/action compromise | exact dependency lock, restricted lifecycle scripts, action SHA pins, dependency/Trivy scans   | registry compromise and unsigned local artifacts remain                   |
| Log/header injection         | UUID normalization, control-character removal, structured fields, no body/query/header logging | future adapters require the same boundary                                 |
| Unsafe CORS/errors           | explicit allowlist, no credentials, fixed Problem Details                                      | infrastructure WAF/rate limits are not selected                           |
| Migration race/corruption    | checksums, transactions, advisory lock, real-DB failure/concurrency tests                      | production DBA/extension provisioning is unresolved                       |
| Excess runtime privilege     | separate roles, reviewed grants, automated DDL denial                                          | cloud IAM/network policy is unresolved                                    |
| Unbounded traffic/shutdown   | body/header/URL/time limits, readiness timeout, bounded shutdown                               | production capacity and DDoS controls are unresolved                      |
| Telemetry exfiltration       | allowlisted metadata, central redaction, bounded exporter                                      | vendor, retention, tenancy, and access policy are unresolved              |

## Production blockers

Hosting, IAM/KMS, managed secret storage, TLS/network topology, WAF/DDoS, artifact signing, backups and
restore tests, RPO/RTO, telemetry retention/access, incident ownership, repository protection, and
legal/regulatory review are intentionally not claimed.
