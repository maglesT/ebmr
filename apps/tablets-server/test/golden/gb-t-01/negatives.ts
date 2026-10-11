/**
 * The sample BMR's data problems as tests (outline 9.1; Phase 3 slice 6d), on the master record, through the designer's
 * validate route as the MBR author sees them: the GB-T-01 content with one change each.
 */
import { routes, type FindingView } from '@ebmr/api-contract';
import type { GoldenWorld } from './world.ts';
import { ok } from './driver.ts';

type Json = Record<string, unknown>;

export interface MasterNegatives {
  /** Hardness in the controlled legacy alias "kg/cm² (as kgf/kp)": the DATA-UNITS findings of the parameter. */
  hardnessAlias: FindingView[];
  /** Hardness in kg/cm2 (a mass per area: a pressure), and in kPa. */
  hardnessPressure: FindingView[];
  hardnessKpa: FindingView[];
  /** The active's form labelled a trihydrate with the anhydrous molar mass. */
  trihydrate: FindingView[];
  /** The addition step without its declared case. */
  additionWithoutCase: FindingView[];
}

const findPhase = (n: unknown, id: string): Json | undefined => {
  if (Array.isArray(n)) {
    for (const x of n) {
      const f = findPhase(x, id);
      if (f) return f;
    }
    return undefined;
  }
  if (!n || typeof n !== 'object') return undefined;
  const o = n as Json;
  if (o['kind'] === 'phase' && o['id'] === id) return o;
  for (const v of Object.values(o)) {
    const f = findPhase(v, id);
    if (f) return f;
  }
  return undefined;
};

export async function masterNegatives(w: GoldenWorld): Promise<MasterNegatives> {
  const author = await w.server.asPersona('author');
  const base = ok(await author.call(routes.designer.version, { params: { versionId: w.versionId } }), 'the master').content as Json;
  const validate = async (edit: (c: Json) => void): Promise<FindingView[]> => {
    const c = JSON.parse(JSON.stringify(base)) as Json;
    edit(c);
    return ok(await author.call(routes.designer.validate, { body: { content: c as never } }), 'the validation').findings;
  };
  const hardness = (unit: string) => (c: Json) => {
    (c['parameters'] as Json[]).push({
      id: 'hardnessReg', name: 'Breaking force (registered unit of the dossier)', valueType: 'DECIMAL', unit, semanticTag: 'breaking_force', precision: { kind: 'DECIMALS', digits: 1 },
      role: 'IPC', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON',
    });
  };
  const of = (fs: FindingView[], rule: string, subject?: string) => fs.filter((f) => f.rule === rule && (subject === undefined || f.message.includes(subject)));
  const hardnessAlias = of(await validate(hardness('kg/cm² (as kgf/kp)')), 'DATA-UNITS', 'hardnessReg');
  const hardnessPressure = of(await validate(hardness('kg/cm2')), 'DATA-UNITS', 'hardnessReg');
  const hardnessKpa = of(await validate(hardness('kPa')), 'DATA-UNITS', 'hardnessReg');
  const trihydrate = (
    await validate((c) => {
      const p = findPhase(c['procedure'], 'p-disp-api');
      const form = ((p?.['config'] as Json)['active'] as Json)['form'] as Json;
      form['name'] = 'exemplazine sodium trihydrate';
      form['hydrateWaters'] = 3;
    })
  ).filter((f) => f.message.includes('TB01-HYDRATE'));
  const additionWithoutCase = (
    await validate((c) => {
      const p = findPhase(c['procedure'], 'p-rework');
      if (p) delete p['reprocessing'];
    })
  ).filter((f) => f.severity === 'ERROR' && f.nodeId === 'p-rework');
  return { hardnessAlias, hardnessPressure, hardnessKpa, trihydrate, additionWithoutCase };
}
