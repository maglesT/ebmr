/**
 * Phase 7 slice 7u (owner report #20): the entry sentences the Tablets blocks share (recipe-core blocks/summary.ts has
 * the contract and the helpers). Each block names its own kinds' sentences next to its entry schemas
 * (BlockVersion.entrySummaries); the kinds several blocks share (G-06's process entries, the run events of a press or a
 * packing machine, the in-process tests of TB-11 to TB-15, the device challenges of G-21) take theirs from here, as
 * they take their schemas from one place.
 */
import { blocks } from '@ebmr/recipe-core/pure';

export const S = blocks.summaries;
type Summaries = Readonly<Record<string, blocks.EntrySummary>>;
type Data = Readonly<Record<string, unknown>>;

const g06 = blocks.G06.entrySummaries ?? {};
const g21 = blocks.G21.entrySummaries ?? {};

/** G-06's process entries (SETPOINT_READBACK, ACTUAL, ALARM, ALARM_ACK, INTERFACE_LOSS, RECIPE_CHECK). */
export const PROCESS_SUMMARIES: Summaries = g06;

/** A G-21 device challenge (TB-23, TB-24 take G-21's CHALLENGE entry). */
export const CHALLENGE_SUMMARY = g21['CHALLENGE'] as blocks.EntrySummary;

const counter = (d: Data): string => (S.str(d['counter']) !== '' ? ` at counter ${S.str(d['counter'])}` : '');
const manual = (d: Data): string => (d['capture'] === 'MANUAL' ? ', keyed by hand' : '');
const on = (d: Data): string => (S.str(d['instrument']) !== '' ? ` on ${S.str(d['instrument'])}` : '');
const result = (d: Data): string => (S.str(d['result']) !== '' ? `: ${S.verdict(d['result'])}` : '');
const missed = (d: Data): string => (S.list(d['missed']).length > 0 ? ', a check was missed' : '');

/** The run events of a press, compactor, blister or bottle line (TB-06, TB-11, TB-16, TB-21, TB-22). */
export const RUN_SUMMARIES = {
  RUN_START: (d: Data) => `Run started${S.str(d['press'] ?? d['machine']) !== '' ? ` on ${S.str(d['press'] ?? d['machine'])}` : ''}${counter(d)}`,
  RUN_END: (d: Data) => `Run ended${counter(d)}${missed(d)}`,
  STOPPAGE_START: () => 'Stoppage started',
  STOPPAGE_END: (d: Data) => `Stoppage ended after ${S.val(d['seconds'])} s${d['long'] === true ? ', a long stoppage' : ''}`,
  CHANGE: (d: Data) => `${S.cap(S.words(d['change']))} changed`,
  STATION_SWEEP: (d: Data) => `Station sweep of ${S.count(S.list(d['stations']).length, 'station')}${on(d)}${manual(d)}${result(d)}`,
} satisfies Summaries;

/** The weight checks of TB-11, TB-12 and TB-16. */
export const WEIGHT_SUMMARIES: Summaries = {
  WEIGHT_CHECK: (d) => {
    const ws = S.list(d['weights']);
    const what = ws.length > 0 ? `${S.count(ws.length, 'tablet')} weighed` : `group weight ${S.amount(d['groupWeight'], 'mg')}`;
    const mean = S.str(S.rec(d['evaluation'])['mean']);
    const assay = S.str(d['assay']) !== '' ? `, assay ${S.str(d['assay'])} % of label claim` : '';
    return `Weight check${on(d)}: ${what}${mean !== '' ? `, mean ${mean} mg` : ''}${assay}${manual(d)}${result(d)}`;
  },
  WEIGHT_SECOND_STAGE: (d) => `Second stage of the weight check: ${S.count(S.list(d['weights']).length, 'tablet')} weighed${on(d)}${manual(d)}${result(d)}`,
};

/** The physical check of TB-11, TB-13 and TB-16. */
export const PHYSICAL_SUMMARIES: Summaries = {
  PHYSICAL_CHECK: (d) => {
    const defects = S.list(d['defects']).map(S.words);
    return `Physical check of ${S.count(S.list(d['tablets']).length, 'tablet')}${on(d)}: ${defects.length > 0 ? `defects ${defects.join(', ')}` : 'no defects'}${manual(d)}${result(d)}`;
  },
};

/** The friability run of TB-11, TB-14 and TB-16. */
export const FRIABILITY_SUMMARIES: Summaries = {
  FRIABILITY_RUN: (d) =>
    `Friability run${S.str(d['run']) !== '' ? ` ${S.str(d['run'])}` : ''}: ${S.count(d['tablets'], 'tablet')}, ${S.val(d['initialMass'])} g before and ${S.val(d['finalMass'])} g after${S.str(d['loss']) !== '' ? `, loss ${S.str(d['loss'])} %` : ''}${d['broken'] === true ? ', broken tablets' : ''}${d['doubtful'] === true ? ', doubtful' : ''}${manual(d)}${result(d)}`,
};

/** The disintegration test of TB-11, TB-15 and TB-16. */
export const DT_SUMMARIES: Summaries = {
  DT_START: (d) => `Disintegration (${S.words(d['stage'] ?? 'MAIN')} stage) started${on(d)}, bath at ${S.amount(d['bathTemperature'], 'Cel')}${S.str(d['retestOf']) !== '' ? ', a retest' : ''}`,
  DT_END: (d) => {
    const units = S.list(d['units']);
    const done = units.filter((u) => S.rec(u)['disintegrated'] === true).length;
    return `Disintegration (${S.words(d['stage'] ?? 'MAIN')} stage) ended${S.str(d['elapsedSeconds']) !== '' ? ` after ${S.str(d['elapsedSeconds'])} s` : ''}: ${String(done)} of ${S.count(units.length, 'unit')} disintegrated${manual(d)}${result(d)}`;
  },
};

/** A check of a bottle or pack line with its result (TB-23, TB-24). */
export function checkSentence(what: string, d: Data): string {
  return `${what}${result(d)}${missed(d)}`;
}
