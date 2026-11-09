# SPEC-004 — Local development console — Design

Status: Approved (see requirements §7)  
Requirements: [requirements.md](requirements.md)

## 1. Approach

The console is a separate single-page app in `apps/dev-console`, built with Vite,
React, and TypeScript. It imports nothing from `modules/*` or `packages/*`: it
knows the API only through HTTP and the frozen request and response shapes in
SPEC-001 and SPEC-002 design §2.3. That keeps it a client like any future app,
and it cannot reach domain code or key material.

The Vite dev server listens on `127.0.0.1:5173` and proxies `/api`, `/health`, and
`/dev` to `DEV_CONSOLE_API_ORIGIN` (default `http://127.0.0.1:3000`). The browser
sees one origin, so the API keeps its current CORS policy.

The API gains two development routes, registered directly on Fastify like the
SPEC-001 provider callbacks, and only when `AuthConfig.devConsole.routesEnabled`
is true:

- `GET /dev/v1/synthetic-deliveries` reads `SyntheticDeliveryTransport.messages()`,
  the in-memory list the integration tests already read.
- `GET /dev/v1/routes` lists the routes Fastify registered, so panels can tell
  whether their API exists (R-12).

Because they are Fastify routes, the Nest `APP_GUARD` from SPEC-002 does not run
on them. The routes check the client address themselves (R-03). SPEC-002's route
inventory test (R-25) runs with them disabled, which is the default.

Relies on ADR-009 (HTTP/Problem Details), ADR-020 (spec process), SPEC-001 and
SPEC-002 contracts, and `docs/design` provisional tokens. No new ADR: the console
is a development tool with no production footprint. If the owner wants it to
become the seed of the Phase 11 admin web, that needs an ADR first.

## 2. Contracts frozen before streams start

### 2.1 Types and ports

```ts
// packages/config — AuthConfig addition
export interface AuthDevConsoleConfig {
  /** DEV_CONSOLE_ROUTES_ENABLED. Only `development`/`test` with synthetic keys. */
  readonly routesEnabled: boolean;
}
// AuthConfig gains: readonly devConsole: AuthDevConsoleConfig;

// modules/auth/src/infrastructure/delivery/synthetic-delivery.ts — addition
export interface SyntheticMessage {
  readonly providerMessageId: string;
  readonly request: DeliveryRequest;
  readonly sentAt: Date; // new: from the transport's clock
}

// apps/api/src/http/route-registry.ts — filled by the existing onRoute hook
export interface RegisteredRoute {
  readonly method: string; // upper case; HEAD omitted
  readonly path: string; // Fastify template, e.g. /api/v1/verification-challenges/:challengeId/verify
}
export interface RouteRegistry {
  list(): readonly RegisteredRoute[]; // sorted by path, then method
}

// apps/api/src/dev/index.ts — implemented by ws-a; the scaffold calls it
export function registerDevConsoleRoutes(
  server: FastifyInstance,
  dependencies: {
    readonly enabled: boolean;
    readonly transport: SyntheticDeliveryTransport;
    readonly routes: RouteRegistry;
    readonly clock: Clock;
    readonly logger: Logger;
  },
): void;
```

```ts
// apps/dev-console/src/contracts.ts — the console's own frozen contracts
import type { ReactElement } from 'react';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly errors?: readonly { readonly field: string; readonly code: string }[];
  readonly [extra: string]: unknown; // e.g. requiredAssurance, maxAgeSeconds
}

export interface ApiCall {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string; // must start with /api/, /health/, or /dev/
  readonly body?: unknown;
  readonly auth?: 'none' | 'access'; // 'access' adds Authorization: Bearer <access token>
  readonly idempotencyKey?: boolean; // adds a fresh Idempotency-Key UUID
}

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly status: number;
      readonly problem: ProblemDetails | undefined; // undefined when the body is not Problem Details
      readonly durationMs: number;
    };

export interface ConsoleApi {
  call<T>(call: ApiCall): Promise<ApiResult<T>>;
}

/** Tab-scoped memory. Never persisted (R-08). */
export interface ConsoleState {
  readonly installationId: string; // UUID, created once per tab (R-11)
  readonly proof?: {
    readonly token: string;
    readonly phoneNumber: string;
    readonly expiresAt: string;
  };
  readonly session?: {
    readonly accessToken: string;
    readonly accessTokenExpiresAt: string;
    readonly refreshToken: string;
    readonly refreshTokenExpiresAt: string;
  };
}

export interface ConsoleStore {
  get(): ConsoleState;
  update(change: (state: ConsoleState) => ConsoleState): void;
  subscribe(listener: () => void): () => void;
}

export interface RouteRequirement {
  readonly method: string;
  readonly path: string; // PLAN template with {name}; matched like isPublicRoute
}

export interface PanelProps {
  readonly api: ConsoleApi;
  readonly store: ConsoleStore;
}

export interface PanelDefinition {
  readonly id: string;
  readonly title: string;
  readonly requires: readonly RouteRequirement[];
  readonly Component: (props: PanelProps) => ReactElement;
}

/** Masks tva_/tvr_/tvp_ tokens, passwords, and codes to prefix + last four (R-09). */
export type Masker = (value: unknown) => unknown;
```

### 2.2 Persistence

None. No migration, table, or browser storage.

### 2.3 Events and API

No outbox events.

Development routes (registered only when enabled; loopback clients only; any
other client or a disabled flag gets the Foundation `404` envelope):

| Route                              | Success                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dev/v1/synthetic-deliveries` | `200 { items: [{ providerMessageId, reference, template, locale, destinationLast4, code?, sentAt }] }`, at most 50, last 15 min, newest first |
| `GET /dev/v1/routes`               | `200 { items: [{ method, path }] }`                                                                                                           |

`destinationLast4` is the last four digits of the canonical number; the rest of
the number is never returned. `code` appears only for `OTP_CODE` messages.
Responses carry `cache-control: no-store`.

The console calls only routes in SPEC-001 and SPEC-002 design §2.3, plus the two
above and `GET /health/ready`.

Panel route requirements:

| Panel          | Requires                                                                                                                       | Stream |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `status`       | `GET /health/ready`                                                                                                            | ws-b   |
| `inbox`        | `GET /dev/v1/synthetic-deliveries`                                                                                             | ws-b   |
| `verification` | the three `verification-challenges` routes                                                                                     | ws-b   |
| `registration` | `POST /api/v1/account-registrations`, `POST /api/v1/account-registrations/{id}/identity`                                       | ws-c   |
| `sign-in`      | `POST /api/v1/sessions`, `POST /api/v1/sessions/refresh`, `DELETE /api/v1/sessions/current`                                    | ws-c   |
| `account`      | `GET /api/v1/accounts/me`, `GET /api/v1/sessions`, `DELETE /api/v1/sessions/{familyId}`, `POST /api/v1/sessions/revoke-others` | ws-c   |
| `step-up`      | both `step-up` routes, `PUT /api/v1/credentials/password`                                                                      | ws-c   |

A panel whose routes are missing renders a "not built yet" notice that names the
missing routes. It never renders disabled form controls that pretend to work.

### 2.4 Layout and visual rules

- One page: a left column lists panels (with an availability marker that uses
  text and an icon, not color alone), the main area shows the selected panel, and
  a bottom drawer shows the request log.
- A permanent header band reads "Development console — synthetic data only".
- Colors come from `docs/design/DESIGN_TOKENS.md` semantic mappings, exposed as
  CSS custom properties in `src/shell/tokens.css`
  (`--color-background-primary`, `--color-surface-primary`, `--color-text-primary`,
  `--color-action-primary-background`, `--color-action-primary-foreground`,
  `--color-brand-secondary`). Teal is never used for text on white (2.33:1).
- Spacing, type, and radius use browser defaults plus a small local scale in
  `tokens.css` marked as console-only, so no production scale is invented.
- Error states show the Problem Details `code` verbatim beside a plain-language
  hint.

## 3. Stream decomposition

| Stream | Responsibility                                               | Owns                                                                                                                                                                                 | Depends on | Consumes contract                                           | Provides contract                      |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------- | -------------------------------------- |
| ws-a   | Development API routes                                       | `apps/api/src/dev/`, `apps/api/test/dev/`                                                                                                                                            | —          | `AuthDevConsoleConfig`, `RouteRegistry`, `SyntheticMessage` | the §2.3 development routes            |
| ws-b   | Console core: API client, masking, log, status, verification | `apps/dev-console/src/api/`, `apps/dev-console/src/panels/status/`, `apps/dev-console/src/panels/inbox/`, `apps/dev-console/src/panels/verification/`, `apps/dev-console/test/core/` | —          | console contracts, development routes                       | `ConsoleApi`, `ConsoleStore`, `Masker` |
| ws-c   | Registration and session panels                              | `apps/dev-console/src/panels/registration/`, `apps/dev-console/src/panels/sessions/`, `apps/dev-console/test/sessions/`                                                              | —          | console contracts, SPEC-002 routes                          | panels only                            |

All streams build against frozen contracts and test with fakes, so all three run
in wave 1. End-to-end use of the ws-c panels needs SPEC-002's ws-c and ws-e merged
into the base branch; until then those panels correctly show "not built yet".

## 4. Integration scaffold

On `spec/004-dev-console/integration`, based on
`spec/002-sign-in-and-sessions/integration`:

1. `apps/dev-console`: `package.json` (dev dependencies only), `tsconfig.json`,
   `vite.config.ts` (host `127.0.0.1`, port `5173`, `strictPort`, proxy from
   `DEV_CONSOLE_API_ORIGIN`), `index.html`, `src/main.tsx`, `src/contracts.ts`
   (§2.1), `src/shell/` (layout, panel list, request-log drawer frame,
   `tokens.css`), and one `index.ts` per panel directory exporting a placeholder
   `PanelDefinition` that each stream replaces.
2. Root: workspace entry, lockfile, `vitest.config.ts` project `dev-console`
   (jsdom), ESLint rules for `.tsx`, TypeScript references, license-policy
   approvals, and a `dev:console` script.
3. `scripts/architecture`: `apps/dev-console` may import nothing from
   `modules/*`, `packages/*`, or `apps/api`.
4. `packages/config`: `AuthConfig.devConsole` with the R-01 rule and tests.
5. `modules/auth`: `SyntheticMessage.sentAt`, with the transport taking an
   optional `Clock`.
6. `apps/api`: `RouteRegistry` filled by the existing `onRoute` hook, and
   `AuthHttpLifecycle.onModuleInit` calling `registerDevConsoleRoutes` (a no-op
   placeholder until ws-a merges).
7. Production images: confirm `apps/dev-console` is not copied into any
   Dockerfile stage; add a test that fails if it is.

## 5. Failure behavior and rollback

- Invalid development configuration fails API startup with a `ConfigValidationError`
  naming `DEV_CONSOLE_ROUTES_ENABLED` and never the value of any secret.
- If the API is down, panels show "API unreachable" and the log records the
  network error. The console never retries a non-idempotent call by itself.
- A `401 AUTHENTICATION_REQUIRED` or `REAUTHENTICATION_REQUIRED` clears the
  session from memory and says so; a `403 STEP_UP_REQUIRED` offers the step-up
  panel with the required assurance and age.
- Rollback is deleting the workspace and the `apps/api/src/dev/` directory; there
  is no data to migrate.

## 6. Test strategy

| Requirement | Test                                                                                                                      | Stream     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| R-01        | `packages/config/test/auth-config.unit.test.ts` — every runtime × key source combination                                  | scaffold   |
| R-02, R-03  | `apps/api/test/dev/dev-routes.integration.test.ts` — disabled `404`; enabled with a non-loopback `remoteAddress` `404`    | ws-a       |
| R-04        | `apps/api/test/dev/dev-routes.integration.test.ts` — window, cap, order, masking, `no-store`                              | ws-a       |
| R-05, R-06  | `apps/api/test/dev/dev-routes-leak.integration.test.ts` — canary capture with the routes enabled; one startup warning     | ws-a       |
| R-07        | `apps/dev-console/test/core/vite-config.unit.test.ts`                                                                     | ws-b       |
| R-08, R-09  | `apps/dev-console/test/core/api-client.unit.test.ts` — storage spies stay empty; masking vectors                          | ws-b       |
| R-10, R-11  | `apps/dev-console/test/core/api-client.unit.test.ts`                                                                      | ws-b       |
| R-12, R-13  | `apps/dev-console/test/core/panels.unit.test.tsx` — fake API; availability; verification flow                             | ws-b       |
| R-14, R-15  | `apps/dev-console/test/sessions/panels.unit.test.tsx` — fake API; each flow and each Problem Details code                 | ws-c       |
| R-16        | `apps/dev-console/test/core/a11y.unit.test.tsx` and `test/sessions/a11y.unit.test.tsx` — roles, names, keyboard, contrast | ws-b, ws-c |
