export { StructuredLogger, type Logger, type LoggerOptions } from './logger';
export { FoundationMetrics, type MetricsSnapshot } from './metrics';
export {
  createOpaqueId,
  createRequestContext,
  getRequestContext,
  normalizeInboundId,
  runWithRequestContext,
  type RequestContext,
} from './request-context';
export { sanitizeForLogging, sanitizeLogRecord, type SafeLogValue } from './redaction';
export { ShutdownCoordinator, type ShutdownTask } from './shutdown';
export {
  initializeTelemetry,
  shutdownTelemetrySafely,
  type TelemetryHandle,
  type TelemetryOptions,
  type TelemetryProvider,
} from './telemetry';
