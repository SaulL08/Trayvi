# Configuration Reference

Only `packages/config/src/environment.ts` reads `process.env`. Validation occurs before a process
binds or starts work. Errors name fields and constraints without values. Returned configuration is
deeply immutable.

| Variable                      | Required/default         | Constraint                                                                |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `NODE_ENV`                    | required                 | `development`, `test`, `staging`, `production`                            |
| `SERVICE_NAME`                | required                 | `api` or `worker`, matching the process                                   |
| `SERVICE_VERSION`             | required                 | 1–64 safe identifier characters                                           |
| `HOST` / `PORT`               | `127.0.0.1` / `3000`     | production host must be explicit; port 1–65535                            |
| `DATABASE_URL`                | required, secret         | Dedicated restricted runtime-login PostgreSQL URL                         |
| `MIGRATION_DATABASE_URL`      | migration command        | Distinct PostgreSQL admin/migrator URL; falls back only for local tooling |
| `DATABASE_TLS_MODE`           | `disable`                | `disable` or `verify-full`; staging/production require `verify-full`      |
| `DATABASE_TLS_CA`             | optional, secret         | PEM CA chain used with `verify-full`; omitted to use platform trust       |
| `DATABASE_READY_TIMEOUT_MS`   | `1000`                   | 50–10000 ms                                                               |
| `CORS_ALLOWED_ORIGINS`        | empty outside production | exact comma-separated origins; wildcard prohibited; production HTTPS only |
| `LOG_LEVEL` / `LOG_FORMAT`    | `info` / `json`          | enumerated values                                                         |
| `OTEL_ENABLED`                | `false`                  | boolean; requires endpoint when true                                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional                 | HTTP(S); HTTPS in production                                              |
| `OTEL_EXPORTER_TIMEOUT_MS`    | `2000`                   | 100–10000 ms                                                              |
| `METRICS_ENABLED`             | `true`                   | boolean                                                                   |
| `HTTP_BODY_LIMIT_BYTES`       | `1048576`                | 1024–5242880                                                              |
| `HTTP_MAX_URL_LENGTH`         | `2048`                   | 256–8192                                                                  |
| `HTTP_MAX_HEADER_SIZE_BYTES`  | `16384`                  | 4096–32768                                                                |
| `HTTP_REQUEST_TIMEOUT_MS`     | `15000`                  | 100–120000 ms                                                             |
| `HTTP_CONNECTION_TIMEOUT_MS`  | `10000`                  | 100–120000 ms                                                             |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS`  | `5000`                   | 100–120000 ms                                                             |
| `SHUTDOWN_TIMEOUT_MS`         | `10000`                  | 500–60000 ms                                                              |

`.env.example` contains names and blank secret fields only. Production secrets must eventually come
from the approved hosting secrets service; no provider has been selected in Phase 0.

Database URL query options that select or weaken TLS are rejected. The typed TLS policy is passed to
the PostgreSQL driver for both runtime probes and migration commands with certificate verification
enabled. Local development explicitly uses `disable` on loopback; it is never a staging/production
default.
