/**
 * R3.2 (hosted-demo trials, October 2026): after Save an entry form showed itself again, empty, and a presenter could not
 * tell whether the entry was in the record. Now a saved form closes and shows the saved entry; "Add another" is offered
 * only for the kinds a step expects several of (containers weighed, checks, readings, additions). The database decides
 * either way: a second entry of a single kind is refused in its own words (e.g. G10-TWICE).
 */

/** Entry kinds a step records once (a start, an end, a set-up, a reconciliation, a clearance). */
const SINGLE: ReadonlySet<string> = new Set([
  'AREA_OCCUPANCY',
  'CLEARANCE_CHECK',
  'PREVIOUS_BATCH',
  'ACKNOWLEDGE',
  'POTENCY_CALCULATION',
  'RECONCILIATION',
  'SERIAL_RECONCILIATION',
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
  'FIRST_OFF',
  'ROOM_CHECK',
  'PAN_LOAD',
  'SPRAY_START',
  'SPRAY_END',
  'PRINT_SETUP',
  'INSPECTION_START',
  'INSPECTION_END',
  'AQL_RESULT',
  'LINE_SETUP',
  'GOOD_OUTPUT',
  'PACKS_MADE',
]);

/** Whether a step expects several entries of `kind` (so a saved form offers "Add another"). */
export function expectsSeveral(kind: string): boolean {
  return !SINGLE.has(kind);
}
