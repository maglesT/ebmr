/** Command infrastructure: idempotency keys, the transactional outbox, error codes. See README.md. */
export { withIdempotentCommand, type IdempotentOutcome } from './idempotency.ts';
export {
  consumeOnce,
  drainOutbox,
  enqueue,
  relayOutboxBatch,
  type OutboxHandler,
  type OutboxMessage,
  type RelayBatchResult,
  type RelayOptions,
} from './outbox.ts';
export { canonicalJson, requestHash, type JsonPrimitive, type JsonValue } from './json.ts';
export { asKernelError, errorCode, KernelError } from './errors.ts';
