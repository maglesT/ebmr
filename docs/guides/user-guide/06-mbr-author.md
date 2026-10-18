# MBR author

This page is for the people who make master batch records (MBRs): the author (`MBR_AUTHOR`), the independent checker
(`MBR_CHECKER`), the QA approver (`QA_MBR_APPROVER`) and the regulatory-conformity signer (`REGULATORY_SIGNER`). An MBR
is the approved recipe every batch follows: its steps, parameters, limits and the signatures each step asks for.

## The life of an MBR version

1. The author designs a draft in the **designer**, starting from a template or from a copy.
2. The system validates the draft as it is edited; a finding must be fixed, a warning may be accepted with a written
   justification.
3. The author starts verification and sends the draft to a **sandbox test run**: it runs on the sandbox's shop-floor
   screens under the TEST, NOT GMP band.
4. The author signs it as *Prepared*, a checker who is not the author signs it as *Independently checked*, the
   regulatory signer confirms the registration references and the QA approver signs it as *Quality-unit approved*.
   The system refuses an approval before the check, and an approval by the author.
5. Approval alone does not let the MBR be used: it is made effective for each market, site, line and batch size.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| See the MBR families and versions | `/mbr` (home tile **Master records**) | `RECORD.READ` | none |
| Start a new MBR from a template | `/mbr/new` | `MBR.AUTHOR` | none |
| Edit a draft, see its findings, step properties and the simulation | `/mbr/versions/$versionId` | `MBR.AUTHOR` | none |
| Justify a warning | `/mbr/versions/$versionId` (**Justify a warning**) | `MBR.AUTHOR` | none |
| Start verification | `/mbr/versions/$versionId` (**Start verification**) | `MBR.AUTHOR` | none |
| Send the draft to a sandbox test run | `/mbr/versions/$versionId` (**Send to a sandbox test run**) | `MBR.AUTHOR` | none |
| Import the test package and issue a TEST- batch (sandbox) | `/packages`, `/packages/$packageId/issue` | `BATCH.ISSUE` | `ISSUED` |
| Run the test batch and read its record and replay (sandbox) | `/runs`, `/runs/$runId` | `STEP.EXECUTE` | `PERFORMED` |
| Sign the version as prepared | the MBR signing interface (no screen in v1.0) | `MBR.SIGN_PREPARED` | `PREPARED` |
| Sign it as independently checked | the MBR signing interface (no screen in v1.0) | `MBR.CHECK` | `CHECKED` |
| Confirm the registration references per market | the MBR signing interface (no screen in v1.0) | `MBR.REGULATORY_CONFIRM` | `REGULATORY_CONFIRMED` |
| Approve it for the quality unit | the MBR signing interface (no screen in v1.0) | `MBR.APPROVE` | `APPROVED` |
| Authorise it for a market | the MBR signing interface (no screen in v1.0) | `MBR.APPROVE` | `MBR_MARKET_AUTHORISED` |
| Approve a labelling specimen | the MBR signing interface (no screen in v1.0) | `MBR.APPROVE` | `SPECIMEN_APPROVED` |

The signing of an MBR's life cycle and its market authorisation have no screen in v1.0; they go through the server's
signing routes (listed in the administrator guide's [known issues](../admin-guide/12-known-issues.md)).

## Test runs in the sandbox

The sandbox is where an MBR is tried before it is approved. Everything there carries TEST, NOT GMP. A test batch
number starts with `TEST-`. The sandbox can never write into the GMP installation, and the GMP installation never takes
a sandbox record as evidence.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| See the work queue of the room of this terminal | `/cockpit` (sandbox) | `RECORD.READ` | none |
| Check a balance and capture a reading in a test run | `/devices/scales` (sandbox) | `STEP.EXECUTE` | none |
| Practise with the training exercises | `/training` (sandbox) | `RECORD.READ` | none |
