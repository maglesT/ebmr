/**
 * R3.2 (hosted-demo trials, October 2026): after Save an entry form showed itself again, empty, and a presenter could not
 * tell whether the entry was in the record. Now a saved form closes and shows the saved entry; "Add another" is offered
 * only for the kinds a step expects several of (containers weighed, checks, readings, additions). The database decides
 * either way: a second entry of a single kind is refused in its own words (e.g. G09-TWICE).
 */

/** Entry kinds a step records once (a start, an end, a set-up, a reconciliation, a clearance check). A clearance
 * step's room occupancy (AREA_OCCUPANCY) is not one: a stage bound to several rooms records one per room (runtime gaps G8). */
const SINGLE: ReadonlySet<string> = new Set([
  'CLEARANCE_CHECK',
  'PREVIOUS_BATCH',
  'ACKNOWLEDGE',
  'POTENCY_CALCULATION',
  'YIELD',
  'MASSING_START',
  'END_POINT',
  'DRYING_START',
  'DRYING_END',
  'BLEND_START',
  'BLEND_END',
  'LUBRICATION_END',
  'RUN_START',
  'RUN_END',
  'PRESS_SETUP',
  'PRE_USE_CHECKLIST',
  'ROOM_CHECK',
  'SPRAY_START',
  'SPRAY_END',
  'PRINT_SETUP',
  'INSPECTION_START',
  'INSPECTION_END',
  'LINE_SETUP',
]);

/** Whether a step expects several entries of `kind` (so a saved form offers "Add another"). */
export function expectsSeveral(kind: string): boolean {
  return !SINGLE.has(kind);
}
