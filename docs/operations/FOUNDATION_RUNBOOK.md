# Foundation Operations Runbook

## Health

- `GET /health/live`: process responsiveness only; never queries PostgreSQL.
- `GET /health/ready`: returns only `ready/not_ready` and `database: up/down`; DB/PostGIS probe is
  timeout-bounded and returns HTTP 503 on loss or during drain.

Do not expose a generic config, environment, debug, database-console, or public metrics endpoint.

## Startup

Configuration validation must finish before API bind or worker initialization. Migrations are a
separate controlled command. A configuration failure exits non-zero and prints field constraints,
never values. API startup logs its bind host/port; these are operational fields, not returned by
health responses.

The worker's `worker.started` event reports application-context initialization;
`worker.process.ready` confirms the entrypoint has installed signal handlers. An explicit idle timer
keeps this no-queue foundation process alive until shutdown; it performs no polling or product work.

## Shutdown

SIGTERM/SIGINT makes the API unready, stops new/idle connections through Fastify close behavior,
closes Nest/database resources, flushes/shuts telemetry, and flushes logs. Worker shutdown closes its
application context and telemetry. Repeated close requests share one promise. The process exits with
failure if the configured deadline is exceeded.

## Incidents

For DB loss, confirm liveness separately from readiness, restore connectivity, and verify readiness
recovery. For telemetry loss, preserve application availability and inspect sanitized warning events.
For migration failure, do not mark the version manually: retain the failed command output, repair with
a new reviewed change or the documented local rollback, then rerun the full matrix.

## Known limits

No production hosting, autoscaling/capacity target, network/WAF, backup/restore, secrets provider,
telemetry backend/retention, on-call ownership, or deployment/rollback automation is defined in Phase 0. Local health timing is diagnostic only and is not a production SLO.
