# Commands: idempotency and the transactional outbox (kernel module B5, part 2)

Build outline 5.7 (idempotency) and 4.6 (outbox); ADR 0006 decision 2, ADR 0012. Schema `platform`,
migrations `0510` (outbox) and `0540` (idempotency). Tests: `test/platform/{idempotency,outbox}.test.ts`.

## Idempotent commands

`withIdempotentCommand(pool, ctx, key, requestHash, work)` wraps `withCommand` (src/db/command.ts).

- **First request.** In one transaction it claims `key` (`platform.claim_idempotency_key`), runs `work`,
  and stores the JSON result (`platform.complete_idempotency_key`). A deferred constraint trigger
  refuses a commit that claimed a key without storing a result.
- **Retry.** The same key and the same `requestHash` return `{ result, replayed: true }` without running
  `work` again.
- **Refusals.** The same key with a different hash is refused (EBMR-PLAT-041). So is a key used by
  another person or account (EBMR-PLAT-042).
- **Concurrent duplicates.** A duplicate waits on the key row. It replays the result if the first
  commits, and runs the work itself if the first rolls back.
- **Hashing.** `requestHash(json)` is the SHA-256 of the canonical JSON (sorted keys). Put decimals in
  requests and results as strings.
- **Access.** The `platform.idempotency_key` table has no application privileges; keys are reached only
  through the two functions.

## Outbox

- **Writing.** `enqueue(client, topic, 'type:id', payload)` (SQL `platform.enqueue`) writes to the
  insert-only `platform.outbox` in the caller's command. The row carries the command's correlation
  ID. A rollback leaves no message.
- **Reserved topics.** Topics starting with `state.`, `incident.` or `platform.` state kernel facts.
  Only owner-level kernel functions write them, through `platform.enqueue_message`; from the
  application they are refused (EBMR-PLAT-057).
- **Relaying.**
  - `relayOutboxBatch(pool, { relayId, handler, batchSize })` claims rows with `platform.outbox_claim`
    (FOR UPDATE SKIP LOCKED) and calls the handler.
  - It records every attempt in `platform.outbox_attempt` and marks the message delivered, or failed
    with exponential back-off (2 s doubling, capped at 1 h).
  - `drainOutbox` loops until nothing is claimable.
  - A message is not claimed while an earlier message of the same aggregate is pending, so each
    aggregate's messages are delivered in order.
  - A transaction can mark only messages it claimed itself (EBMR-PLAT-055).
- **At least once.** A relay that dies before commit leaves its messages pending. Handlers must be
  idempotent on `messageId`. Consumers inside this database call `consumeOnce(client, consumer,
  messageId)` (`platform.consume_once`) in the same transaction as their effect.
- **Topics written by the kernel today:**
  - `incident.requested` (time faults);
  - `state.created` and `state.transitioned` (state-machine engine).

## Errors

`errorCode(error)` extracts `EBMR-<AREA>-<NNN>`. `KernelError` carries the code; the TS wrappers
convert database errors to it.

## Invariants and known limits

- The relay runs under the application role, so a compromised application role could mark messages
  delivered without delivering them. Outbox rows are insert-only and every attempt is recorded, so
  such suppression is detectable by reconciliation (for example alarms against incidents). A
  dedicated relay role is proposed to the lead.
- The relay keeps its transaction open while handlers run. Keep handlers short and batches small.

Handbook: [modules/kernel.md](../../../../docs/handbook/modules/kernel.md)
