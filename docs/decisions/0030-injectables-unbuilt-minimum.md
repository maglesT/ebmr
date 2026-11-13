# Decision record 0030: behaviours the injectables minimum leaves out (no binding clause, or beyond it)

- **Date:** 12 November 2026
- **Decided by:** the lead (session_01PybpFvEFaQZ3LEfnNdjBCE), as a ruling under the owner's standing minimum-compliance
  rule (only binding clauses, cited and checked against the official text; no clause, no requirement). Reported to the
  owner, who may veto it. Prepared by build session 14 (I-6, the injectables edition exit).
- **Concerns:** controls ST-02, ST-06, ST-11, ST-12, ST-17, ST-20, ST-22, ST-67, ST-71, ST-72, ST-75, ST-76 and IN-45; their catalog-test clauses marked `not_required` cite this
  record (the register's rule: a quote of at least two whole words from the control's own paragraph below).

## Context

The 89 injectables MODIFY decisions (`docs/build-plan/injectables/control-decisions.md`, approved by the owner on
5 November 2026) keep the binding minimum of each control. Mapping each catalog test clause by clause for the I-6 trace
gate left kept clauses whose behaviour is not built. Each was checked against the extracted texts in
`docs/regulatory/sources-extracted/` (EU GMP Annex 1 of 2022, 21 CFR 211, revised Schedule M). Those with a binding clause
are built in their minimum form (ST-01, ST-06's assessment, ST-12, ST-18, ST-19, ST-20's action limit, ST-23, ST-28, ST-29,
ST-33, ST-34, ST-52, IN-48). Those below have none, or ask for more than their clause does, and are left out here. Clause
references are paraphrased.

## Decision

ST-02: no binding clause found for refusing approval of an aseptic master that carries no route justification. Annex 1
and 21 CFR 211.113(b) ask for validated sterilisation and aseptic processes; neither asks for a route-justification record
on the master. The choice of route stays the formulation's choice of blocks, as the MODIFY decision says.

ST-22: the per-operator flag (every operator on the roster must have a glove sample) is beyond the clause. Annex 1 9.25
leaves the locations, type and frequency of personnel monitoring to a risk assessment and names monitoring after critical
interventions and at each exit; the per-operator rule comes from the FDA aseptic processing guidance, which is not
binding. Glove sampling after critical interventions is built under ST-34.

ST-75: the impact-window listing (the batches made since the last passing glove test) is beyond the clause. Annex 1 4.21
asks for glove integrity testing and replacement; a failed test raises a deviation, whose investigation decides the impact.

ST-76: no binding clause found for blocking settle-plate exposure before the end of vapour-decontamination aeration.
Annex 1 4.36 asks only that the effectiveness of fumigation or vapour disinfection be understood and validated, and 4.22
covers decontamination methods; neither sets when environmental sampling may start.

IN-45: the automatic listing of all batches since the previous passing process simulation is beyond the clause. For EU
markets Annex 1 9.46(iv) requires a prompt review of the records of aseptic production since the last successful
simulation, with a risk assessment of the batches made since then; it requires the review, not a system listing. The
review is recorded in the investigation of the failed simulation's deviation. Schedule M Part II 5.5 asks for an
investigation that considers a repeat media fill.

ST-06: blocking release while a typed alarm is unassessed is beyond the clause. Annex 1 5.2 asks that process and
equipment alarms be acknowledged and evaluated, critical ones immediately; the minimum built is an assessment required on
the alarm event itself. Release then follows the existing gate and record review.

ST-11: no binding clause found for a separate glove-change record with an impact assessment after a torn glove. Annex 1
4.21 asks for glove integrity testing and a defined replacement frequency, and 7.16 for gloves disinfected during work; a
breach is recorded as an event and, where it matters, a deviation.

ST-12: peak headcount on the timeline: display only; no binding clause; the recorded people-present value with its limit
is the control. Annex 1 7.2 asks that only the minimum number of people be present in cleanrooms and that their maximum
be set, documented and considered in qualification and the process simulation; it does not ask for a timeline display.
The filling step records the most people present at once against the maximum qualified in the simulation, and more is an
exception that stops the step (added by the lead in B1, 13 November 2026; the owner may veto it).

ST-17: the restoration record after a pressure-difference dip is beyond the clause. Annex 1 4.16 asks for indicators and
alarms that warn of a reduction below set limits; a dip typed below its limit already raises an exception, which the
existing gate holds until it is dispositioned.

ST-20: no binding clause found for leaving out the alert level of Grade A viable monitoring. Annex 1 9.10 sets alert
levels for Grade A on total particles only and does not forbid a viable alert; the binding action limits are enforced.

ST-67: no binding clause found for an inconclusive sterility outcome that offers only rejection. Neither Annex 1 nor
21 CFR 211.165 and 211.167 define an inconclusive state; a failing result is an exception and a deviation.

ST-71: listing an open deviation and a yield outside its limits as two separate items on the release screen is beyond
the clause. 21 CFR 211.192 and Schedule M ask that any discrepancy, a yield outside its limits included, be investigated
and the investigation recorded before release; release stays refused while either is open, which the gate already shows.

ST-72: naming each unreviewed sterilisation cycle on the release screen is beyond the clause. Annex 1 and 21 CFR 211.192
ask for the records to be reviewed before release; the gate already shows the record incomplete until the cycle block is
checked by a second person.

## Consequences

- The clauses above are `not_required` in their controls, citing this record; the trace shows them as NOT_REQUIRED.
- Nothing in this record weakens what the MODIFY decisions keep; each control still needs a passing test of its minimum.
- Equipment and rooms carry one due date (injectables plan 4.1). The site sets it to the earliest of the unit's
  calibration, requalification (Annex 1 4.32; Schedule M Part II 4.5) and, for a steriliser, leak test (Annex 1 8.60), so
  a unit refused past that date shows which of the three lapsed in its own records.
- The owner may veto any item; a vetoed item is then built in its minimum form and its clause tested.
