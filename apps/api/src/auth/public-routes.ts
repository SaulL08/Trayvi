/**
 * SPEC-002 design §4 item 4: the frozen public-route allowlist from PLAN §9.4. Every other route
 * requires a principal. ws-d reads this file; no stream edits it. Paths use PLAN §15 templates;
 * `{name}` matches one path segment whatever the parameter is called in the controller.
 */
export interface PublicRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

export const PUBLIC_ROUTES: readonly PublicRoute[] = Object.freeze([
  // Foundation health probes.
  { method: 'GET', path: '/health/live' },
  { method: 'GET', path: '/health/ready' },
  // SPEC-001 challenges and provider callbacks.
  { method: 'POST', path: '/api/v1/verification-challenges' },
  { method: 'POST', path: '/api/v1/verification-challenges/{id}/resend' },
  { method: 'POST', path: '/api/v1/verification-challenges/{id}/verify' },
  { method: 'POST', path: '/api/v1/provider-callbacks/{providerAlias}/{kind}' },
  // SPEC-002 registration, session creation, and refresh.
  { method: 'POST', path: '/api/v1/account-registrations' },
  { method: 'POST', path: '/api/v1/account-registrations/{id}/identity' },
  { method: 'POST', path: '/api/v1/sessions' },
  { method: 'POST', path: '/api/v1/sessions/refresh' },
  // SPEC-003 recovery start and cancel (case-handle routes authenticate by `tvc_` instead).
  { method: 'POST', path: '/api/v1/recovery-cases' },
  { method: 'POST', path: '/api/v1/recovery-cases/cancel-challenges' },
  { method: 'POST', path: '/api/v1/recovery-cases/cancel' },
] satisfies PublicRoute[]);

function shape(path: string): string {
  return path
    .replace(/\/+$/u, '')
    .split('/')
    .map((segment) => (/^\{[^}]+\}$/u.test(segment) || /^:[^/]+$/u.test(segment) ? '{}' : segment))
    .join('/');
}

const PUBLIC_SHAPES = new Set(PUBLIC_ROUTES.map((route) => `${route.method} ${shape(route.path)}`));

/**
 * True when a registered route template is public. Accepts PLAN `{name}` and Fastify `:name`
 * parameters. HEAD is treated as GET, because Fastify answers HEAD with the GET handler.
 */
export function isPublicRoute(method: string, routeTemplate: string | undefined): boolean {
  if (routeTemplate === undefined) return false;
  const normalizedMethod = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return PUBLIC_SHAPES.has(`${normalizedMethod} ${shape(routeTemplate)}`);
}
