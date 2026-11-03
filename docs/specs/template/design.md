# SPEC-NNN — Title — Design

Status: Draft  
Requirements: [requirements.md](requirements.md)

## 1. Approach

How the requirements are met inside the existing modules and layers. Name the ADRs this design
relies on. A new cross-cutting decision needs its own ADR, not a paragraph here.

## 2. Contracts frozen before streams start

Everything that more than one work stream reads or writes is defined here, exactly enough to code
against without talking to the other stream. When the spec is `approved`, this section is frozen.
A change after that point goes back through review and every affected stream rebases.

### 2.1 Types and ports

```ts
// Exact exported TypeScript signatures shared between streams.
```

### 2.2 Persistence

Tables, columns, constraints, grants, and the migration number reserved for each stream in
`streams.json`. Migrations stay ordered and immutable once shared.

### 2.3 Events and API

Outbox event names and payload schemas, HTTP routes, Problem Details codes, and idempotency keys.

## 3. Stream decomposition

| Stream | Responsibility | Owns | Depends on | Consumes contract | Provides contract |
| ------ | -------------- | ---- | ---------- | ----------------- | ----------------- |
| ws-a   |                |      | —          |                   |                   |

Rules:

- Each stream owns disjoint paths. A file that two streams need belongs to the integration
  scaffold (section 4) or is split.
- A stream that needs another stream's code at runtime depends on it; it starts after that stream
  merges into the integration branch. A stream that needs only a frozen contract does not.

## 4. Integration scaffold

Changes made on the integration branch before any stream starts: package manifests, lockfile,
workspace and tool configuration, empty module skeletons, shared contract files, and CI. Streams
never edit these.

## 5. Failure behavior and rollback

What fails closed, what is retried, and how each migration rolls back.

## 6. Test strategy

Map each `R-NN` to unit, integration, concurrency, or security tests, and to the stream that writes
them.
