# Secure Development Checklist

- Keep changes inside the approved phase and package boundary.
- Never use real identity, document, location, payment, credential, or production data in fixtures.
- Add configuration through the typed composition boundary; keep secret values out of diagnostics.
- Pass new log/error/telemetry fields through central sanitization and add adversarial canaries.
- Keep request bodies, full URLs/query values, cookies, and authorization headers out of logs.
- Add reviewed paired SQL; analyze locks, rollback, grants, concurrency, and failure behavior.
- Use parameterized SQL for values and validated/quoted identifiers where parameters cannot apply.
- Pin direct dependencies, lock transitive integrity, and review all lifecycle-script approvals.
- Pin CI actions and images immutably; run dependency, secret, filesystem, and image scans.
- Run `corepack pnpm verify:full` for database/security-sensitive work.
- Record residual risk; do not self-accept Critical/High findings.
