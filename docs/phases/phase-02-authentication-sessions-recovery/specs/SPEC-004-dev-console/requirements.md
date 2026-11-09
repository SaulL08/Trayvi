# SPEC-004 — Local development console — Requirements

Status: Draft  
Phase: `phase-02-authentication-sessions-recovery` ([PLAN.md](../../PLAN.md))  
Owners: Auth, Developer Experience  
Last updated: 2026-11-09

## 1. Purpose

Phase 2 builds authentication with no user interface: the customer and driver
apps arrive in Phases 14–15 and the admin web in Phase 11 (PLAN §2.2). Today the
only way to see the work is through automated tests. This spec delivers a
**local development console**: a small web app that runs on a developer's
machine and drives the real Phase 2 API end to end. With it, a person can verify a
phone number, register, sign in, and manage sessions by hand.

The console is a development tool, not a product surface. It is never deployed,
and it follows the anti-fake-product rule in
[`docs/design/README.md`](../../../../design/README.md): it shows a flow only when
the API it calls exists. It adds no Phase 2 capability and does not widen PLAN
scope. It makes the capabilities that SPEC-001 and SPEC-002 deliver observable.

The synthetic delivery adapter keeps OTP codes in server memory only, so the
console needs a development-only API route to read them. That route, plus a
development-only list of registered routes, are the only API changes in this spec.
The inbox is the main risk this spec controls (§4).

## 2. Scope

### 2.1 In scope

- A new workspace `apps/dev-console` (Vite, React, TypeScript) that runs only on
  `127.0.0.1` and reaches the API through a development proxy.
- Two development-only API routes in `apps/api` (the synthetic delivery inbox and
  the registered-route list), off by default and refused at startup outside
  `development` and `test`.
- Panels for flows whose API exists: API status, phone verification (SPEC-001),
  registration and identity submission, sign-in, refresh, own account, session
  list and revocation, sign-out, step-up, and password set (SPEC-002).
- A request log that shows every call the console makes, with secrets masked.
- Trayvi provisional design tokens for color, applied as semantic tokens.

### 2.2 Out of scope

- Any deployed or production web surface: admin web (Phase 11).
- Customer and driver apps: Phases 14–15.
- Recovery and contact-change panels: added by an amendment when SPEC-003 is
  implemented.
- Browser cookies, CSRF, and production CORS for the API: Phase 11.
- A design-system package or production token scales (`docs/design` §6 forbids
  inventing them).
- Real SMS delivery: the inbox reads only the synthetic adapter.

## 3. Requirements

| Id   | Requirement                                                                                                                                                                                                                 | Traces to            | Verified by |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------- |
| R-01 | The API configuration shall reject `DEV_CONSOLE_ROUTES_ENABLED=true` at startup unless the runtime is `development` or `test` and the Auth key source is `synthetic`.                                                       | P2-AC-013, P2-AC-033 | ws-a        |
| R-02 | While the development routes are disabled, the API shall register neither of them, so a request to either returns the Foundation `404`.                                                                                     | P2-AC-033            | ws-a        |
| R-03 | When the development routes are enabled and a request arrives from a non-loopback address, the API shall answer `404`, as if they did not exist.                                                                            | P2-AC-033            | ws-a        |
| R-04 | When the inbox is enabled, `GET /dev/v1/synthetic-deliveries` shall return at most the 50 most recent synthetic messages from the last 15 minutes, newest first, with the fields in design §2.3 and the destination masked. | P2-AC-013            | ws-a        |
| R-05 | The inbox shall not log, trace, meter, or emit an event containing a code or destination, and enabling it shall leave the SPEC-001 and SPEC-002 canary tests passing with the inbox off.                                    | P2-AC-033            | ws-a        |
| R-06 | The API shall log one `dev_console.routes.enabled` warning at startup while the development routes are enabled.                                                                                                             | P2-AC-033            | ws-a        |
| R-07 | The console dev server shall listen only on `127.0.0.1` and shall forward `/api`, `/health`, and `/dev` to the configured API origin, so the API needs no CORS change.                                                      | P2-AC-001            | ws-b        |
| R-08 | The console shall keep access tokens, refresh tokens, contact proofs, and passwords in memory only, never in `localStorage`, `sessionStorage`, cookies, IndexedDB, or URLs.                                                 | P2-AC-017, P2-AC-033 | ws-b        |
| R-09 | The request log shall show method, path, status, duration, and the response body, with every `tva_`, `tvr_`, and `tvp_` token, password, and OTP code masked to its prefix and last four characters.                        | P2-AC-033            | ws-b        |
| R-10 | When the API answers with Problem Details, the console shall show `code`, `title`, `status`, `requestId`, and any field errors, and shall not hide or reword the code.                                                      | P2-AC-035            | ws-b, ws-c  |
| R-11 | The console shall create one installation ID per browser tab and send it as `X-Trayvi-Installation` on every challenge and session request.                                                                                 | P2-AC-009            | ws-b        |
| R-12 | When the console starts and every 10 seconds after, it shall read `GET /dev/v1/routes` and show a panel as available only when the API registers every route the panel needs.                                               | P2-AC-001            | ws-b        |
| R-13 | The phone verification panel shall start, resend, and verify a `CONTACT_PROOF` challenge, show the inbox code for that challenge, and keep the resulting proof for the next step.                                           | P2-AC-009            | ws-b        |
| R-14 | The registration panel shall start registration with the kept proof and submit synthetic identity data, showing Phase 1's envelopes unchanged.                                                                              | P2-AC-025            | ws-c        |
| R-15 | The session panels shall sign in, refresh, read the own account, list and revoke families, revoke others, sign out, run a step-up challenge, and set a password, using only the SPEC-002 routes.                            | P2-AC-015, P2-AC-021 | ws-c        |
| R-16 | Interactive elements shall have accessible names, a visible focus indicator, keyboard operation, and text contrast of at least 4.5:1, using the `docs/design` semantic color mappings.                                      | P2-AC-001            | ws-b, ws-c  |

## 4. Security, privacy, and abuse requirements

The inbox route intentionally returns OTP codes, which every other Phase 2
surface must never do (P2-AC-013, P2-AC-033). It is safe only because:

- configuration refuses the development routes outside `development` and `test`
  and with any non-synthetic key source (R-01);
- it does not exist unless enabled (R-02) and answers only loopback clients (R-03);
- it reads the synthetic adapter's existing in-memory list and adds no storage,
  logging, or events (R-04, R-05);
- enabling it is loud (R-06).

Threats addressed: OTP disclosure through a development route left enabled in a
shared environment (R-01–R-03, R-06), and token leakage through browser storage or
logs (R-08, R-09).

Data classes touched: OTP code and phone number from the synthetic adapter (in
memory only); access tokens, refresh tokens, contact proofs, and passwords in the
browser tab's memory.

## 5. Non-functional requirements

- No new production dependency in `apps/api`. Console dependencies are dev-only
  and must pass the license and dependency-audit gates.
- The console builds with `corepack pnpm --filter @trayvi/dev-console build` and is
  excluded from production images.
- The console works in current Chrome, Safari, and Firefox. Mobile layouts are not
  required.
- Panel availability costs one `GET /dev/v1/routes` request every 10 seconds.

## 6. Open questions

| Question                                                                                                                                                                                                  | Owner        | Blocks approval |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------- |
| Does P2-AC-001 ("changes are limited to Auth, approved seams, composition, migrations, tests, and docs") admit a development-only workspace and route? If not, record a PLAN amendment or move this spec. | Owner        | Yes             |
| Approve the console's dev dependencies (Vite, React, `@vitejs/plugin-react`, Testing Library, jsdom) under the license policy.                                                                            | Architecture | Yes             |
| Should the console also run against a shared staging API later? This spec says no, and R-01 enforces that.                                                                                                | Owner        | No              |
