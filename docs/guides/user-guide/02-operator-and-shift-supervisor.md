# Operator and shift supervisor

This page is for the people on the shop floor: the production operator, the designated dispenser, the verifier, the
shift supervisor, the person responsible for a stage, the head of production and QA operations on the floor. It covers
the GMP batches. The same screens run test runs in the sandbox, under the TEST, NOT GMP band.

Read [Getting started](01-getting-started.md) first: badge and PIN, Lock and Switch user, and how a signature works.

## Finding your work

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| See the GMP batches and open one | `/runs` (home tile **Shop floor**) | `RECORD.READ` | none |
| See the batch overview, its stages and steps | `/runs/$runId` | `RECORD.READ` | none |
| Open the step to work on | `/runs/$runId/steps/$stepKey` | `STEP.EXECUTE` | none |
| See equipment, rooms and their cleaning state | `/status-board`, `/rooms` | `RECORD.READ` | none |

A step screen shows what the step asks for, the limits, the equipment and room it needs and who may do each act. The
buttons you see are the acts your role may do now; the server checks again when you press one.

## Doing a step

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Record the clearance of a line or room before a stage | `/runs/$runId/steps/$stepKey` | `STEP.SIGN_PERFORMED` | `LINE_CLEARANCE_PERFORMED` |
| Verify that clearance (a second person) | `/runs/$runId/steps/$stepKey` | `STEP.VERIFY` | `LINE_CLEARANCE_VERIFIED` |
| Enter values, scan materials and equipment, capture a balance reading | `/runs/$runId/steps/$stepKey` | `STEP.EXECUTE` | none (each entry is attributed to you by your badge tap) |
| Dispense a material against the batch | `/runs/$runId/steps/$stepKey` | `DISPENSE.EXECUTE` | `PERFORMED` |
| Check a dispensed container (a second person) | `/runs/$runId/steps/$stepKey` | `STEP.VERIFY` | `CONTAINER_CHECKED` |
| Verify a charge into the equipment | `/runs/$runId/steps/$stepKey` | `STEP.VERIFY` | `CHARGE_IN_VERIFIED` |
| Record an in-process control (weight, hardness) | `/runs/$runId/steps/$stepKey` | `STEP.SIGN_PERFORMED` | `IPC_PERFORMED` |
| Verify an in-process control | `/runs/$runId/steps/$stepKey` | `STEP.VERIFY` | `IPC_VERIFIED` |
| Sign the step as performed | `/runs/$runId/steps/$stepKey` | `STEP.SIGN_PERFORMED` | `PERFORMED` |
| Verify an entry or step done by someone else | `/runs/$runId/steps/$stepKey` | `STEP.VERIFY` | `VERIFIED` |
| Witness an act as it happens | `/runs/$runId/steps/$stepKey` | `STEP.WITNESS` | `WITNESSED` |
| Verify a yield | `/runs/$runId/steps/$stepKey` | `STEP.VERIFY` | `YIELD_VERIFIED` |
| Open, close, sort or reject an output container (a second person verifies the net weight at the close) | `/review/$batchId/containers` | `STEP.EXECUTE` | none |

**At a kiosk, each entry is yours.** On a shared kiosk every entry asks for a fresh badge tap (and the PIN where the
terminal needs it), so an entry is never recorded under the person who signed in earlier. If someone else's badge is
tapped, the screen offers **Switch to** that person.

**Balances and devices.** A weighing takes the reading from the balance, never a typed value, unless the step allows a
manual entry with a second-person check. A balance whose check is not done, or a device that is not bound to the step,
is refused.

**A value out of limits** is refused or raises an exception, as the master batch record says. You never edit a recorded
value: a correction is a new entry with a reason (`CORRECTED`), and may need an approval.

## Exceptions and deviations

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Raise a deviation | `/quality/deviations` | `DEVIATION.RAISE` | none |
| Approve an in-line exception of a class you are designated for | `/runs/$runId/steps/$stepKey` | `DEVIATION.APPROVE_INLINE` | `DEVIATION_AUTHORISED` |
| Approve a critical exception on the floor in real time (QA operations) | `/runs/$runId/steps/$stepKey` | `QA.FLOOR_APPROVE` | `DEVIATION_AUTHORISED` |
| Release or keep a hold point (QA operations) | `/runs/$runId/steps/$stepKey` | `QA.FLOOR_APPROVE` | `HOLD_POINT_RELEASED`, `HOLD_POINT_NOT_RELEASED` |
| Release a held output container (QA operations) | `/review/$batchId/containers` | `QA.FLOOR_APPROVE` | `OUTPUT_CONTAINER_RELEASED` |
| Acknowledge a process alarm with the action taken | `/alarms` | `ALARM.ACKNOWLEDGE` | none |

## Supervising

The step screen offers the supervisor's acts on the step or the batch when they apply: a hold of the batch and its
release, the disposition of an exception or a hold point, a void of an attempt, a correction, and the stage sign-off.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Directly supervise an act | `/runs/$runId/steps/$stepKey` | `STEP.SUPERVISE` | `SUPERVISED` |
| Authorise a void of an attempt | `/runs/$runId/steps/$stepKey` | `STEP.SUPERVISE` | `VOID_AUTHORISED` |
| Sign off a stage | `/runs/$runId/steps/$stepKey` | `STEP.SUPERVISE` | `STAGE_SIGNED_OFF` |
| Hold the batch, or release the hold | `/runs/$runId/steps/$stepKey` | `STEP.SUPERVISE` | none |

Other signatures a supervisor may be asked for, when the master batch record and the batch's state call for them:
`LATE_ENTRY_APPROVED`, `SKIP_APPROVED`, `NOT_APPLICABLE_APPROVED`, `HANDOVER_APPROVED`, `REPRINT_AUTHORISED` and
`BATCH_CANCELLED` (all need `STEP.SUPERVISE`; QA operations may sign some of them with `QA.FLOOR_APPROVE`, as
[the meanings list](../reference/permissions.md#signature-meanings) shows).

**Contingency (paper) forms.** When the system cannot be used, the shift supervisor or QA issues a pack of numbered
paper forms for the batch (`CONTINGENCY.ISSUE`): **Archive and retention**, the batch (`/archive/batches/$batchId`),
**Contingency paper forms**, **Issue the pack**. Afterwards the entries are reconciled there, with a reason for each
void or missing form (`CONTINGENCY.RECONCILE`; **Sign the reconciliation of the paper forms**, signature
`FORMS_RECONCILED`). The batch review shows whether the forms of a batch are reconciled; a batch with a form not
reconciled cannot complete.

## Approving the production record

When execution is complete, the person responsible for the stage and the head of production approve the record before
QA reviews it.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Approve the completed processing record | `/review/$batchId` | `RECORD.PRODUCTION_APPROVE` | `PRODUCTION_APPROVED` |
| Approve the completed packaging record | `/review/$batchId` | `RECORD.PRODUCTION_APPROVE` | `PACKAGING_RECORD_APPROVED` |
| Approve aborting a batch (with QA) | `/review/$batchId` | `RECORD.PRODUCTION_APPROVE` | `BATCH_ABORT_APPROVED` |

## Packaging

Packaging orders are planned on `/planning/packaging` and issued against a bulk batch (`/planning/packaging/$batchId`).
On the floor, packaging steps run on the same step screen: line clearance, printed materials issued from the label store
(`/labels/store`, `LABELLING.ISSUE`), coding and label specimens, the reconciliation of printed foil and cartons, and
the packaging yield. Serialised orders show their serial pools on `/serialisation/batches/$batchId`.
