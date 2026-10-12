/**
 * DEMO-ONLY: the content of a small packaging master of the golden product GB-T-01 (Phase 4 slice 2c; set-up CLI
 * `--gmp-packaging`), for the packaging-order planning and bulk-issue demo and its e2e spec. It is the dc-mini template
 * re-keyed as a PACKAGING record of GB-T-01 with the pack type ALU-PVC-BLISTER, whose first preparation runs, in
 * parallel branches, the printed materials (G-21), the secondary packaging (TB-24, the step a packaging master needs
 * before an order can be planned on it, recipe-core 0761) and the witnessed destruction of coded surplus (G-23). Invented
 * data (decision 0006 part 3); never a real master.
 */
import { flow } from '@ebmr/recipe-core/pure';
import { TEMPLATES } from '../features/designer/templates/index.ts';
import { GBT01_PRODUCT } from '../features/execution/seed-gb-t-01.ts';

type Json = Record<string, unknown>;

export const PACK_TYPE = 'ALU-PVC-BLISTER';
export const PACK_SIZE_ID = 'BS-100K';
/** The packaging line's process unit and its printer (DEMO-ONLY codes; the demo plant lists them when it runs the line). */
const LINE_UNIT = 'DEMO-LINE-PK1';
const CARTONER = 'DEMO-LINE-CTN1';
const PRINTER = 'DEMO-PRN-1';

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phase(id: string, name: string, type: string, config: Json, signatures: Json = SIGNATURES): Json {
  return { kind: 'phase', id, name, block: { type, version: '1' }, config, records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures, significant: true, riskClass: 'HIGH' };
}

/** The packaging master's content: family `familyCode`, GB-T-01's product, IN only. */
export function packagingMasterContent(familyCode: string): flow.MbrContent {
  const base = TEMPLATES.get('dc-mini')?.content;
  if (!base) throw new Error('the dc-mini template is missing');
  const m = JSON.parse(JSON.stringify(base)) as Json;
  const header = m['header'] as Json;
  header['family'] = familyCode;
  header['title'] = 'Exemplazine tablets 250 mg: Alu-PVC blister 10 x 10, packaging order (DEMO-ONLY, invented)';
  header['recordKind'] = 'PACKAGING';
  header['packType'] = PACK_TYPE;
  header['product'] = { code: GBT01_PRODUCT.productCode, name: 'Exemplazine tablets', strength: GBT01_PRODUCT.strength, dosageForm: 'Film-coated tablet, blister pack' };
  header['marketSet'] = ['IN'];
  const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
  const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
  const g21: Json = {
    items: [{ id: 'CARTON', material: 'DEMO-MAT-CTN', artwork: { IN: 'ART-GBT01-1' }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' }, coded: true }],
    destructionStep: 'p-destroy',
    devices: [{ id: 'CODER', kind: 'PRINTER', serial: PRINTER }, { id: 'CAM', kind: 'VISION', serial: PRINTER, every: { value: '30', unit: 'min' } }],
    unit: LINE_UNIT,
    firstPrintRole: 'PRODUCTION_OPERATOR',
    shelfLifeMonths: 24,
  };
  const tb24 = {
    unit: CARTONER, devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' },
    cartonsPerShipper: '20', ssccPrefix: '089012345', printedStep: 'p-g21',
  };
  // After the stage's line clearance (each stage starts with it, PR-03).
  const [clearance, ...rest] = prep['children'] as Json[];
  prep['children'] = [
    clearance,
    {
      kind: 'parallel', id: 'par-pack',
      branches: [
        { id: 'br-g21', name: 'Printed materials', body: phase('p-g21', 'Printed cartons: issue, coding and reconciliation', 'G-21', g21) },
        { id: 'br-tb24', name: 'Secondary packaging', body: phase('p-tb24', 'Cartoning, finished-pack examination and shippers', 'TB-24', tb24) },
        { id: 'br-destroy', name: 'Coded surplus', body: phase('p-destroy', 'Witnessed destruction of coded surplus', 'G-23', {}, { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } }) },
      ],
    },
    ...rest,
  ];
  // G-09 and G-10 version 1 run only in the sandbox; the GMP master takes their version 2 (as GB-T-01 does).
  const toV2 = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(toV2);
    else if (n && typeof n === 'object') {
      const o = n as Json;
      const b = o['block'] as Json | undefined;
      if (o['kind'] === 'phase' && b && (b['type'] === 'G-09' || b['type'] === 'G-10') && b['version'] === '1') o['block'] = { ...b, version: '2' };
      Object.values(o).forEach(toV2);
    }
  };
  toV2(m['procedure']);
  const parsed = flow.parseMbr(m);
  if (!parsed.ok) throw new Error(`the DEMO-ONLY packaging master does not parse: ${parsed.problems.slice(0, 3).map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return parsed.mbr;
}
