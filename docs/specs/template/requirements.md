# SPEC-NNN — Title — Requirements

Status: Draft  
Phase: `phase-NN-name` ([PLAN.md](../../PLAN.md))  
Owners:  
Last updated: YYYY-MM-DD

## 1. Purpose

One paragraph: the capability this spec delivers and why it belongs to the owning phase. Link the
`PLAN.md` sections it refines. A spec refines a plan; it never widens the phase scope.

## 2. Scope

### 2.1 In scope

-

### 2.2 Out of scope

- Name anything a reader could reasonably expect here, and the phase or spec that owns it.

## 3. Requirements

Write each requirement in EARS form. Give it a stable `R-NN` id and trace it to at least one
acceptance criterion of the phase plan. Requirements are testable statements, not tasks.

| Pattern    | Template                                                           |
| ---------- | ------------------------------------------------------------------ |
| Ubiquitous | The `<system>` shall `<response>`.                                 |
| Event      | When `<trigger>`, the `<system>` shall `<response>`.               |
| State      | While `<state>`, the `<system>` shall `<response>`.                |
| Unwanted   | If `<unwanted condition>`, then the `<system>` shall `<response>`. |
| Optional   | Where `<feature is present>`, the `<system>` shall `<response>`.   |

| Id   | Requirement | Traces to   | Verified by |
| ---- | ----------- | ----------- | ----------- |
| R-01 |             | `PN-AC-NNN` |             |

## 4. Security, privacy, and abuse requirements

List the threats from the phase threat model that this spec must close, and the data classes it
touches. Every item is a requirement with an `R-NN` id in section 3.

## 5. Non-functional requirements

Concurrency, idempotency, latency, retention, observability, and migration safety, as applicable.

## 6. Open questions

Each question has an owner. A spec cannot move to `approved` with an open question that changes a
contract in `design.md`.
