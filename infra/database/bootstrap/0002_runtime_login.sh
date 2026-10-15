#!/bin/sh
set -eu

if [ -z "${TRAYVI_DB_RUNTIME_PASSWORD:-}" ]; then
  echo 'TRAYVI_DB_RUNTIME_PASSWORD is required for the local runtime login.' >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=runtime_password="$TRAYVI_DB_RUNTIME_PASSWORD" <<-'SQL'
SELECT format(
  'CREATE ROLE trayvi_runtime_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'runtime_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_runtime_login')
\gexec

GRANT trayvi_runtime TO trayvi_runtime_login;
SQL
