# ADR-0006: Server-authoritative execution; no signing on devices

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 Decision 12, option A (decision record 0001)
- **Supersedes:** none

## Context

- Operators use browsers on shared kiosks, panel PCs and cleanroom tablets; QA and authors use office PCs. Any client may run modified code or report a false device, time or user.
- Every guard depends on current system-of-record data: material status and retest date, equipment cleanliness and calibration, room status, qualifications, APS status, and the trusted database clock.
- Signing on a device while offline would evaluate those guards on stale data, take time from an untrusted clock, and need credential verifiers cached on the device.
- Networks and servers fail. The floor needs a defined continuity path that never produces a silent pass or an unattributed entry (DI-28, DI-43).
- On shared devices, a session left open must not let one person's entries be attributed to another (DI-14).

## Decision

1. **The server decides.** Every command is validated and executed on the server in one database transaction with the relevant rows locked. The UI never decides whether a step may start, a value is within limits or a signature is valid; browsers run the shared packages only to preview the server's decision (ADR-0003).
2. **A record exists only once the server has committed it.** Every mutating request carries an idempotency key, so retries and double clicks are harmless.
3. **No signing on devices** in v1. Signatures use the server-side challenge, authentication event and signing function (ADR-0012).
4. **Terminal link loss:** the unsent entry stays on screen under a blocking "not saved" banner (it is not a record) and is re-sent with the same idempotency key. It stays bound to the person and authentication event that produced it; if the terminal changes user it is discarded and listed in a local notice for the incident record.
5. **Instrument data** is buffered by the site gateway with source timestamps and stored as `occurred_at` with a trust level beside the server's `recorded_at`.
6. **Site continuity:** a site server per installation (on premise by default) keeps the floor running through WAN or cloud outages, with synchronous standby and an alarmed fallback to asynchronous replication.
7. **Server down:** at issue and at every stage start the server pre-generates a numbered contingency pack (PDF with hash) per active batch on a local print server or edge cache; aseptic filling has an immediate pre-staged fallback. Form numbers are allocated in the register and reconciled before batch closure. Back-entry records three identities: the performer who signed the paper, the transcriber and the verifier. Every guard is re-evaluated against the historical state; a failing guard becomes an exception and a deviation, never a silent pass or a block on back-entry. The signed paper stays the original record unless replaced by a verified true copy.
8. **Attribution on shared devices:** every GMP command from a SHARED or GRADE_A_B device carries a fresh authentication event of the person it is attributed to (a badge tap within N seconds, default 60, or a badge-present session). Device ID, class and room come from enrolled device keys or mTLS certificates, never from what the browser reports.

## Consequences

### Positive

- One authority for every GMP decision; guards read fresh system-of-record data and the database clock.
- No credential verifiers or signing keys on terminals; a stolen or tampered device cannot create signed records.
- Validation covers one decision path instead of a client path, a server path and a synchronisation step.

### Negative

- The floor depends on the site server: HA, restore drills (ADR-0007) and a pre-staged paper fallback are mandatory.
- Paper back-entry is laborious and creates hybrid records that must be declared in the DI-01 register and reconciled.
- In the private-cloud topology the site depends on its WAN link and must keep contingency packs pre-staged.
- Latency affects usability: p95 command latency under 300 ms on the site LAN is a design target.
- Poorly connected sites get no offline terminal mode in v1 (extra 12 deferred; revisit with pilot sites).

## Alternatives considered

- **Offline terminal mode with device signing and later synchronisation (Decision 12 B).** Rejected for v1: stale guards, untrusted clocks, cached credentials and conflict resolution after sync.
- **Client-side guard evaluation confirmed by the server.** Rejected: two authorities that can disagree; an operator could see a pass that the server later refuses.
- **One company-wide installation for many sites (Decision 12 C).** Rejected for v1: every floor action would depend on the WAN; revisited with the v1.1 hub.

## Related controls and invariants

- Controls: DI-14 (unique personal accounts), DI-20 (device checks), DI-27 (trusted time), DI-28 (contemporaneous capture, offline buffering), DI-29 (complete data), DI-30 (accuracy check of manual entries), DI-38 (session rules), DI-41 (true copies), DI-43 (paper in the loop and contingency), PR-11 (contemporaneous recording and paper fallback).
- Invariants: INV-16, INV-26, INV-27, INV-38, INV-40.

## References

- Build outline v0.2: sections 4.1, 4.2 (Network loss, Paper fallback, HA and restore), 4.7 (Device identity), 5.5 (Attribution on shared devices), 5.6, 5.7, 5.9 item 12, 13 Decision 12.
- Architecture research: 2.4, 5.6.
