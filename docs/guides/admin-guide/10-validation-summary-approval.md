# The validation summary approval

Before a release is used for GMP work, the customer's quality unit approves its validation summary (DI-03). The
database knows which release it runs, so the approval is bound to that release and cannot be carried over to another.

## What is built (7-0)

- **The release identity.** `platform.schema_release()` is the SHA-256 over the database's migration ledger (each
  migration's namespace, name and checksum, in byte order), so a database upgraded step by step and a fresh one give the
  same value.
- **The approval.** QA approves the validation summary of the running release with a signature bound to both the
  release identity and the SHA-256 of the summary document (meaning *Validation summary approved*). Only the running
  release's summary can be approved (EBMR-VAL-003 to -006). The approval is kept insert-only.

| Task | Function | Right | Signature meaning |
|---|---|---|---|
| Approve the validation summary of the running release (QA reviewer or QA MBR approver) | `platform.approve_validation_summary` | `VALIDATION.APPROVE_SUMMARY` | `VALIDATION_SUMMARY_APPROVED` |
| Read the running release's identity | `platform.schema_release` | none (a read) | none |

## As planned; checked at 7f

- **The interlock (slice 7c).** On a GMP installation a batch issue is refused while the running release has no
  approved validation summary (EBMR-VAL-001). The sandbox and training are not gated.
- **The approval screens.** The summary document comes from the validation pack (slice 7c); the screen on which QA reads
  it and signs is part of that slice.
- **The pack.** The URS, risk assessment, specifications, trace matrix, IQ and OQ records and the summary template are
  generated from the evidence bundle (slice 7c); the customer's QA writes the conclusion.
