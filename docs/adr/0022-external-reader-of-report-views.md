# 0022. An external Deviations and CAPA system reads batch data through the report views

Status: Accepted (2026-10-31, slice S16, decisions D-S16-1 to D-S16-6; owner-approved plan of the Deviations system)

## Context

The owner's separate Deviations and CAPA system investigates events on Batchwright batches. It must read the batch data
without writing anything, and it must not use Batchwright's own deviation and CAPA module (`site.deviation*`,
`site.capa*`, `report.deviation_fact_v1`). Batchwright already has a read-only reporting path (Phase 6 slice 6g, kernel
1210): the login role `ebmr_report`, member of nothing, CONNECT on GMP databases only, SELECT on the `report` views and
EXECUTE on their non-volatile row functions, checked by `sandbox.segregation_problems()`. The views the investigation
needs existed (`batch_fact_v1`, `step_use_v1`, `cpp_value_v1`, `exception_v1`, `alarm_v1`) except the procedures: block
instructions carry no SOP link (`sop: null`); the SOPs a batch ran under are the master record's `references`, and the
documents themselves live in `tab.reference_document` (the DMS stand-in).

## Decision

1. **D-S16-1.** The Deviations system reads Batchwright through `ebmr_report` and the `report.*_v1` views only, on the GMP
   database or a streaming replica. It gets no other role, grant or schema; Batchwright gets no code of the reader.
2. **D-S16-2.** The eleven views the reader uses are a contract: their columns (name, order, type) are pinned by
   `apps/tablets-server/test/contract/report-views-deviations.test.ts`. A `_v1` view is never changed in place; a change
   of columns is a new `_v2` view, and the `_v1` view stays until the reader stops using it.
3. **D-S16-3.** Every S16 view reads GMP batch records only (installation GMP, purpose GMP_BATCH), filtered in its own
   function as `batch_fact_v1` is, so the reader sees exactly the batches `batch_fact_v1` lists.
4. **D-S16-4.** No names on the reporting path: a person appears only as the pseudonymous person id (uuid as text), as
   `step_use_v1`'s `person_ids` do; `exception_detail_v1.disposed_by` is that id, null when no person disposed of it.
   Resolving an id to a person is the site's business, outside the reporting role.
5. **D-S16-5.** The four investigation views behind 1801 also have `report.<name>_v1_for(batch_numbers text[])` with the same
   columns, reading only the batches named: a view over a definer function cannot push a reader's `where batch_number`
   into its jsonb work. EXECUTE on these to `ebmr_report` only. Measured on the demo set with every sample loaded, scaled to
   847 batch records (22,385 entries) by copying records in a throwaway database: one batch through the view took
   1.0 s (ipc_result), 0.11 s (process_actual), 0.10 s (equipment_use) and 4 to 6.6 s (exception_detail); through the
   `_for` functions 8, 2, 3 and 18 to 26 ms.
6. **D-S16-6.** Tablets 1800 adds the document views, built as the 6g and 6A ones (a STABLE SECURITY DEFINER row function
   per view, `read_at` and `data_as_of` on every row, SELECT to `ebmr_app` and `ebmr_report`, in `report.view_registry`):
   - `report.reference_document_v1`: every recorded reference document version (kind, code, version, title,
     effective_from); retired and withdrawn versions stay listed.
   - `report.batch_reference_v1`: per GMP batch record, the documents its master record cites: the `references` of the
     master content the batch runs (its control recipe's snapshot of the pinned version, `recipe.batch_mbr_content`), with
     the registered document's title, else the record's own. A batch planned but not yet issued has no record and no rows.
   They are a Tablets migration because `tab.reference_document` is a Tablets table (recipe-core never names `tab`).
   Tablets 1801 adds the views an investigation needs and the existing ones do not give (checked on the hosted demo's
   failing batch: `cpp_value_v1` holds only critical MBR parameters and calculations, `step_use_v1` finds a unit only
   through `plant.step_equipment`, `exception_v1` has no step, text or disposition):
   - `report.equipment_use_v1`: each use of a unit (`plant.equipment_use` with its end) or instrument (`plant.instrument_use`,
     no recorded end) by a batch record, once per step that names it: a binding's step key, or for a binding by phase the
     one instance of the phase started when it was bound (matched by key or phase as `step_use_v1`), and each step whose
     EQUIPMENT_USE entry names the use;
   - `report.ipc_result_v1`: each value of an in-process check entry: PHYSICAL_CHECK readings, means and appearance;
     TB-11 STATION_SWEEP values per station (reading = station number) against the sweep's individual limits;
     WEIGHT_CHECK weights and group total or mean; one row for any other test entry. With the instrument, the step's
     action and alert limits from the record's master and `result` as Batchwright stored it: PASS, ALERT or FAIL (PENDING
     or SECOND_STAGE for a weight check awaiting its second stage). The blocks store one verdict per parameter of an
     entry: a PHYSICAL_CHECK's combines its individual and mean limits and is on its reading rows and its mean row alike;
     a sweep's is its individual limits'; a weight check's is the entry's. Breaking force read in kp is given in N;
   - `report.process_actual_v1`: each ACTUAL entry with the step's acceptance limits for its tag and the stored
     withinLimits flag;
   - `report.exception_detail_v1`: each register exception with its step key and step title, its text, and the engine
     disposition in the record (status, outcome, person id, time).
   They evaluate nothing themselves.
7. The reader's connection is an operations matter (`docs/operations/report-reader.md`, `ops/postgres/pg_hba.conf.template`):
   TLS with SCRAM from the reader's host only, read-only transactions, the role's connection limit of 4.

## Consequences

- No new privilege: the segregation check accepts the new views unchanged, and the contract test proves it stays clean.
- The reader sees what `batch_fact_v1` sees: issued GMP batch records, never sandbox test runs.
- Times are `timestamptz` (the reader renders them in the site zone, Asia/Kolkata for the demo site); values stay the
  source's exact decimal text with the unit the record holds.
- Any later change to these eleven views must go through the contract test, which names the reader.

## Alternatives considered

- **A dedicated role for the Deviations system.** Rejected: `ebmr_report` already is the read-only role with a
  segregation check; a second one doubles the checks for no new right.
- **Reading `site.deviation*` for the investigation.** Rejected by the owner: the Deviations system keeps its own records.
- **SOP links per step.** Not available: block instructions carry `sop: null`; the master's references are the source.

## Related controls and invariants

- Controls: DI-17 (segregation of the roles), DI-05 (no access to a sandbox), DI-04 (the cited document versions are the
  pinned, hashed ones).

## References

- Kernel 1210 (reporting role), recipe-core 1070 (report views), 1115 (analytics input views), tablets 1800 and 1801.
- ADR 0020 (the analytics runner's read-only role, the same pattern).
