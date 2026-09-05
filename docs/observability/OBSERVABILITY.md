# Observability Baseline

Pino emits structured logs with timestamp, level, service, environment, version, event, outcome, and
duration where applicable. Async request context adds effective request/correlation IDs and active
trace ID. HTTP bodies, headers, and query values are not logged; health successes are suppressed to
avoid noise while failures remain observable.

Every supplied context crosses a recursive sanitizer. It treats keys case-insensitively and strips
separators before matching password/passcode/PIN/OTP, authorization/cookies, tokens, secrets/API keys,
identity documents, payment/card/bank credentials, biometrics, and precise location. It also sanitizes
errors/causes, arrays, circular/deep/large structures, control characters, bearer/JWT-like strings,
PostgreSQL URLs, and URL query values.

Foundation metrics are held behind a narrow low-cardinality registry: HTTP method/status class and
duration totals, DB probe outcome/duration, and worker lifecycle. Phase 0 exposes no public metrics
endpoint. A production collector/storage policy is deferred.

OpenTelemetry tracing is optional. The OTLP endpoint and export timeout are validated. Bounded queues,
flush, and shutdown isolate exporter failure from readiness and avoid logging exported payloads.
Telemetry content must remain safe even when the downstream provider is unavailable.
