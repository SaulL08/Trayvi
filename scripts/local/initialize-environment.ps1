[CmdletBinding()]
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$trayviProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$targets = @('.env.local', '.env.api', '.env.worker') | ForEach-Object {
  Join-Path $trayviProjectRoot $_
}

if (-not $Force) {
  $existing = $targets | Where-Object { Test-Path -LiteralPath $_ }
  if ($existing.Count -gt 0) {
    throw "Local environment already exists. Use -Force only if rotation is intended."
  }
}

$adminRandomBytes = New-Object byte[] 24
$runtimeRandomBytes = New-Object byte[] 24
$randomNumberGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $randomNumberGenerator.GetBytes($adminRandomBytes)
  $randomNumberGenerator.GetBytes($runtimeRandomBytes)
}
finally {
  $randomNumberGenerator.Dispose()
}
$adminPassword = ([BitConverter]::ToString($adminRandomBytes) -replace '-', '').ToLowerInvariant()
$runtimePassword = ([BitConverter]::ToString($runtimeRandomBytes) -replace '-', '').ToLowerInvariant()
$migrationDatabaseUrl = "postgresql://trayvi_local_admin:$adminPassword@127.0.0.1:54329/trayvi_local"
$runtimeDatabaseUrl = "postgresql://trayvi_runtime_login:$runtimePassword@127.0.0.1:54329/trayvi_local"

$localLines = @(
  'TRAYVI_DB_NAME=trayvi_local',
  'TRAYVI_DB_ADMIN_USER=trayvi_local_admin',
  "TRAYVI_DB_ADMIN_PASSWORD=$adminPassword",
  "TRAYVI_DB_RUNTIME_PASSWORD=$runtimePassword"
)

$commonLines = @(
  'NODE_ENV=development',
  'SERVICE_VERSION=dev',
  'HOST=127.0.0.1',
  'PORT=3000',
  "DATABASE_URL=$runtimeDatabaseUrl",
  "MIGRATION_DATABASE_URL=$migrationDatabaseUrl",
  'DATABASE_TLS_MODE=disable',
  'DATABASE_TLS_CA=',
  'DATABASE_READY_TIMEOUT_MS=1000',
  'CORS_ALLOWED_ORIGINS=',
  'LOG_LEVEL=info',
  'LOG_FORMAT=json',
  'OTEL_ENABLED=false',
  'OTEL_EXPORTER_OTLP_ENDPOINT=',
  'OTEL_EXPORTER_TIMEOUT_MS=2000',
  'METRICS_ENABLED=true',
  'HTTP_BODY_LIMIT_BYTES=1048576',
  'HTTP_MAX_URL_LENGTH=2048',
  'HTTP_MAX_HEADER_SIZE_BYTES=16384',
  'HTTP_REQUEST_TIMEOUT_MS=15000',
  'HTTP_CONNECTION_TIMEOUT_MS=10000',
  'HTTP_KEEP_ALIVE_TIMEOUT_MS=5000',
  'SHUTDOWN_TIMEOUT_MS=10000'
)

$utf8NoBom = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllLines($targets[0], $localLines, $utf8NoBom)
[IO.File]::WriteAllLines($targets[1], @('SERVICE_NAME=api') + $commonLines, $utf8NoBom)
[IO.File]::WriteAllLines($targets[2], @('SERVICE_NAME=worker') + $commonLines, $utf8NoBom)

Write-Output 'Created ignored local-only environment files with a random database password.'
