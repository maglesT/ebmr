/**
 * Injectables edition I-1c1 (docs/build-plan/injectables/plan.md, resume notes I-1c): the acceptance of the injectables
 * library, as the tablets' (library/acceptance.ts, decision 0026 S11a) with no change to the product's code. One spec file
 * per product calls `defineInjectablesAcceptance`, which declares its tests in order:
 *  - the ready-made catalogue loaded and QA's approval of the injectables blocks the product uses;
 *  - the steward enters the materials and the product (dosage form Injection: the Injectables edition), QA confirms them;
 *    the formula is written and approved; the author starts the master from the formula with the required skeleton,
 *    which for an injectable is the dispensing stage alone and QA's release for packing (H-PACK) in a stage of its own
 *    (from-formula dispensingOnly), and adds the product's steps before the reconciliation (its yield closes the
 *    stage) as library blocks, each typed with the product's values; change control; the sandbox test batch, issued at the further size, runs on the kiosks to
 *    Execution complete, every library step through the one generic screen; its result is imported as evidence; four
 *    people sign; QA authorises the IN market.
 * The products are data (`INJECTABLES`): a terminally sterilised small-volume vial and ampoule.
 * I-1c2 P4a, the GMP half (`defineInjectablesGmp`, run after the sandbox half by its own spec file, group library-inj-gmp),
 * as the tablets' GMP 1 to GMP 4 (library/acceptance.ts S11b): the primary components and the printed label, leaflet and
 * carton entered; the specifications, the licence and the manufacturer; the first lots received, tested, their artwork
 * recorded and released; the numbering rules, the GMP plant's units, the ERP order, the batch planned and issued at the
 * authorised size and the lots reserved; the GMP batch on the kiosks (the dispensing skeleton, every library step with the
 * GMP plant's units, the sterilised loads as verified output containers in units) to QA's release for packing (H-PACK).
 * Only a product with GMP data (`gmp`) runs it: the vial now; the ampoule's is enabled by data when wanted.
 * DEMO-ONLY data; every code is unique per run.
 */
import { randomBytes } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';
import { begin, cleanForBatch, closeFloor, closeStage, closeTyped, done, explained, field, floorKiosk, openContainer, releasePlant, statusStep, step, type Floor } from '../phase7/own-product-floor.ts';
import { act, as, completed, entry, performAndCheck, reviewRecord, startStep } from '../phase7/kiosk-batch-support.ts';
import {
  authoriseIn, changeControl, checksPass, confirmMasters, enterMaterials, exportTestResult, fourSignatures, home, importEvidence, issueTestBatch, load, loadProduct,
  registerTestLots as registerArtworkTestLots, saveProduct, saveRevision, selectStep, sendToSandbox, type ProductState,
} from '../phase7/own-product-flow.ts';
import {
  approveManufacturers, approveResults, approveSpecifications, defineNumberingRule, draftSpecification, endorseOnLicence, openLot, planAndIssue, receiveDelivery, recordArtwork, recordIdentity,
  planPackaging, postFinishedLot, pullReserveSample, recordResults, releaseFinishedLot, releaseLot, reserveLots, sendOrder,
} from '../phase7/own-product-gmp-flow.ts';
import { registerTestLots, runSkeletonTestBatch, type OwnMaterial } from '../phase7/own-product-support.ts';
import { addLibraryBlocks, approveBlocks, definePlantClasses, definePlantProduct, investigateAndClose, linkNewDeviation, loadCatalogue, productBlock, registerPlantUnits, runLibraryStep, stepIdOf, type PlantUnit, type ProductBlock } from './library-support.ts';
import { skeletonRun } from './skeleton-floor.ts';


export interface Injectable {
  key: string;
  prefix: string;
  name: string;
  strength: string;
  /** An injectables dosage form (recipe-core flow/dosage-form.ts): the edition follows from it. */
  dosageForm: string;
  /** The dissolved solids per unit (mg): the sum of the per-unit lines; the water for injection is the plant's, not a lot. */
  targetMg: string;
  /** The active first (potency-adjusted), the compensating excipient second; per unit (mg). Tare and gross (kg) of the one
   *  container weighed for a batch at the further size, 50,000 units. */
  materials: readonly { id: string; name: string; mgPerUnit: string; tare: string; gross: string }[];
  /** The sandbox plant's units the product needs (its own data, registered on screen before the batch). */
  plant: readonly PlantUnit[];
  /**
   * The primary components: no formula line and nothing dispensed (lead, 6 November 2026). Each has a released TEST- lot
   * named by the library step that uses it (`field`: its lot field's id).
   */
  components: readonly { id: string; name: string; field: string }[];
  /** The product's library steps, in order, after the dispensing of the other components (before the reconciliation). */
  steps: readonly ProductBlock[];
  /**
   * The GMP half's data (I-1c2 P4a); a product without it runs the sandbox half only. Its presence is the switch: the
   * ampoule's GMP half is enabled by data when wanted.
   */
  gmp?: InjectableGmp;
}

export interface InjectableGmp {
  /** The GMP plant's units of the classes the product's library steps name (registered on its screens in GMP 3). */
  plant: readonly PlantUnit[];
  /**
   * The batch's output (generic, any form): the containers the run's last container-producing step registered and no
   * later step consumed (the sterilised loads, the filled trays of an aseptic fill, the lyophiliser loads). Each is also a
   * physical output container of the batch, opened on the containers screen in the stage `outputStage` and closed with
   * `outputUnits` units (typed, a second person verifies it): the units the inspection accepts from the counts of the
   * run (`VIAL_COUNTS`), the physical bulk the packaging order takes later.
   */
  outputStage: string;
  outputUnits: string;
  /**
   * A value the GMP batch records outside its action limit (`step`: the block code; `values` by section and field, over
   * the product's own), e.g. an EM count after incubation. The step is blocked until the supervisor raises a deviation
   * for the batch and links it (`rationale`); the lot's release checklist then stays red until QA has investigated and
   * closed it (GMP 9).
   */
  breach?: { step: string; values: Readonly<Record<string, Readonly<Record<string, unknown>>>>; rationale: string };
}

/** A process unit of the sandbox plant (each class its own, as the blocks' examples name them), in the dispensing room. */
export const unit = (classCode: string, classDescription: string, code: string, name: string): PlantUnit => ({ classCode, classKind: 'PROCESS', classDescription, code, name, area: 'DISP-1' });

/** The sandbox's balance (tablets-server cli/sandbox-plant.ts): the fill weights are weighed on it. */
const SANDBOX_BALANCE: Readonly<Record<string, string>> = { 'EQC-BAL': 'TEST-BAL-02' };

/**
 * The counts of one nominal vial or ampoule run that add up (INJ-UNIT-ACCOUNT reads the filling, capping or sealing, and
 * inspection counts and finds no unit unaccounted for): 10,000 filled, 20 rejected at the line, 40 at capping or sealing, 9,800 inspected with 80 rejects
 * (9,720 accepted), 120 sampled and 20 documented losses.
 */
export const VIAL_COUNTS = {
  fill: { end: { filled: '10000', rejects: '20' }, tray: { units: '10000' } },
  capping: { round: { rejects: '40' } },
  inspect: { counts: { inspected: '9800', particles: '20', container: '30', fill: '25', closure: '5' } },
  account: { account: { sampled: '120', losses: '20' } },
} as const;

export const INJECTABLES: readonly Injectable[] = [
  {
    // A terminally sterilised small-volume injection in 2 mL glass vials: compounding, bioburden-reducing filtration,
    // filling and stoppering, capping, moist-heat terminal sterilisation per load, 100 % visual inspection and AQL,
    // container closure integrity, the sterility samples and the unit accountability.
    key: 'vial',
    prefix: 'LIV10',
    name: 'Libinj 10 mg/2 mL, solution for injection in vials (library)',
    strength: '10 mg/2 mL',
    dosageForm: 'Injection',
    targetMg: '28',
    materials: [
      { id: 'api', name: 'Libinj active', mgPerUnit: '10', tare: '0.200', gross: '0.700' },
      { id: 'nacl', name: 'Sodium chloride (tonicity)', mgPerUnit: '16', tare: '0.200', gross: '1.000' },
      { id: 'buf', name: 'Sodium citrate dihydrate (buffer)', mgPerUnit: '2', tare: '0.050', gross: '0.150' },
    ],
    plant: [
      unit('ROOM-GRADE-C', 'Clean room, grade C', 'TEST-ROOM-C-01', 'Grade C filling room'),
      unit('VIAL-WASHER', 'Vial washing machine', 'TEST-VIAL-WASHER-01', 'Vial washer'),
      unit('DEPYRO-TUNNEL', 'Depyrogenation tunnel', 'TEST-DEPYRO-01', 'Depyrogenation tunnel'),
      unit('STEAM-STERILISER', 'Steam steriliser (autoclave)', 'TEST-AUTOCLAVE-01', 'Steam steriliser'),
      unit('SS-VESSEL-200L', 'Stainless steel vessel, 200 L', 'TEST-VESSEL-01', 'Compounding and receiving vessel'),
      unit('WFI-POINT-OF-USE', 'Water for injection point of use', 'TEST-WFI-POU-01', 'WFI point of use'),
      unit('FILTER-0_45UM', 'Bioburden-reducing filter assembly, 0.45 micrometre', 'TEST-FILTER-01', 'Filter assembly'),
      unit('VIAL-FILLING-LINE', 'Vial filling and stoppering line', 'TEST-VIAL-LINE-01', 'Vial filling line'),
      unit('VIAL-CAPPER', 'Vial capping machine', 'TEST-CAPPER-01', 'Vial capper'),
      unit('INSPECTION-BOOTH', 'Visual inspection booth', 'TEST-BOOTH-01', 'Inspection booth'),
    ],
    components: [
      { id: 'vial', name: 'Glass vial, 2 mL, type I', field: 'containerLot' },
      { id: 'stopper', name: 'Bromobutyl rubber stopper, 13 mm', field: 'stopperLot' },
      { id: 'seal', name: 'Aluminium flip-off seal, 13 mm', field: 'sealLot' },
    ],
    steps: [
      productBlock('INJ-ROOM-READY', 'ROOM-GRADE-C'),
      productBlock('INJ-WASH', 'VIAL-WASHER'),
      productBlock('INJ-DEPYRO', 'DEPYRO-TUNNEL'),
      productBlock('INJ-PARTS-AUTOCLAVE', 'STEAM-STERILISER'),
      productBlock('INJ-COMPOUND', { vesselClass: 'SS-VESSEL-200L', wfiPointClass: 'WFI-POINT-OF-USE' }),
      productBlock('INJ-BULK-FILTER', { filterClass: 'FILTER-0_45UM', receiverClass: 'SS-VESSEL-200L' }),
      { ...productBlock('INJ-FILL', { lineClass: 'VIAL-FILLING-LINE', roomClass: 'ROOM-GRADE-C', balanceClass: 'EQC-BAL' }), values: VIAL_COUNTS.fill },
      productBlock('IPC-INJ-FILL-WEIGHT', 'EQC-BAL'),
      productBlock('INJ-STERILITY-SAMPLE', {}),
      { ...productBlock('INJ-CAPPING', 'VIAL-CAPPER'), values: VIAL_COUNTS.capping },
      productBlock('INJ-TERMINAL-STERILISE', 'STEAM-STERILISER'),
      { ...productBlock('INJ-VISUAL-INSPECT', 'INSPECTION-BOOTH'), values: VIAL_COUNTS.inspect },
      productBlock('INJ-CCI', {}),
      // Unit accountability judges its own critical "not accounted for" limit, so it needs no master yield checkpoint
      // (GMP-YIELDS, lead ruling I-1c).
      { ...productBlock('INJ-UNIT-ACCOUNT', {}), values: VIAL_COUNTS.account },
    ],
    gmp: {
      plant: [
        unit('ROOM-GRADE-C', 'Clean room, grade C', 'ROOM-C-01', 'Grade C filling room'),
        unit('VIAL-WASHER', 'Vial washing machine', 'VIAL-WASHER-01', 'Vial washer'),
        unit('DEPYRO-TUNNEL', 'Depyrogenation tunnel', 'DEPYRO-01', 'Depyrogenation tunnel'),
        unit('STEAM-STERILISER', 'Steam steriliser (autoclave)', 'AUTOCLAVE-01', 'Steam steriliser'),
        unit('SS-VESSEL-200L', 'Stainless steel vessel, 200 L', 'VESSEL-01', 'Compounding and receiving vessel'),
        unit('WFI-POINT-OF-USE', 'Water for injection point of use', 'WFI-POU-01', 'WFI point of use'),
        unit('FILTER-0_45UM', 'Bioburden-reducing filter assembly, 0.45 micrometre', 'FILTER-01', 'Filter assembly'),
        unit('VIAL-FILLING-LINE', 'Vial filling and stoppering line', 'VIAL-LINE-01', 'Vial filling line'),
        unit('VIAL-CAPPER', 'Vial capping machine', 'CAPPER-01', 'Vial capper'),
        unit('INSPECTION-BOOTH', 'Visual inspection booth', 'BOOTH-01', 'Inspection booth'),
      ],
      // 10,000 filled, less 20 rejected at the line, 40 at capping, 120 sampled, 20 lost and 80 rejected at inspection.
      outputStage: 'STERILISATION',
      outputUnits: '9720',
    },
  },
  {
    // The same solution in 2 mL glass ampoules: no stopper and no seal. The washed and depyrogenated ampoules are filled,
    // then fusion-sealed (INJ-AMPOULE-SEAL, in place of capping); the parts autoclave sterilises the filling machine's
    // parts. Unit accountability reads the units rejected at closing from the sealing step. The integrity test is a
    // sample, as for the vial: 100 % testing of fusion-sealed units (EU GMP Annex 1 8.22) is an EU-market item, and this
    // master is for India.
    key: 'ampoule',
    prefix: 'LIA10',
    name: 'Libinj 10 mg/2 mL, solution for injection in ampoules (library)',
    strength: '10 mg/2 mL',
    dosageForm: 'Injection',
    targetMg: '28',
    materials: [
      { id: 'api', name: 'Libinj active', mgPerUnit: '10', tare: '0.200', gross: '0.700' },
      { id: 'nacl', name: 'Sodium chloride (tonicity)', mgPerUnit: '16', tare: '0.200', gross: '1.000' },
      { id: 'buf', name: 'Sodium citrate dihydrate (buffer)', mgPerUnit: '2', tare: '0.050', gross: '0.150' },
    ],
    plant: [
      unit('ROOM-GRADE-C', 'Clean room, grade C', 'TEST-ROOM-C-01', 'Grade C filling room'),
      unit('AMPOULE-WASHER', 'Ampoule washing machine', 'TEST-AMP-WASHER-01', 'Ampoule washer'),
      unit('DEPYRO-TUNNEL', 'Depyrogenation tunnel', 'TEST-DEPYRO-01', 'Depyrogenation tunnel'),
      unit('STEAM-STERILISER', 'Steam steriliser (autoclave)', 'TEST-AUTOCLAVE-01', 'Steam steriliser'),
      unit('SS-VESSEL-200L', 'Stainless steel vessel, 200 L', 'TEST-VESSEL-01', 'Compounding and receiving vessel'),
      unit('WFI-POINT-OF-USE', 'Water for injection point of use', 'TEST-WFI-POU-01', 'WFI point of use'),
      unit('FILTER-0_45UM', 'Bioburden-reducing filter assembly, 0.45 micrometre', 'TEST-FILTER-01', 'Filter assembly'),
      unit('AMPOULE-FILLING-LINE', 'Ampoule filling line', 'TEST-AMP-LINE-01', 'Ampoule filling line'),
      unit('AMPOULE-SEALER', 'Ampoule sealing station', 'TEST-AMP-SEALER-01', 'Ampoule sealer'),
      unit('INSPECTION-BOOTH', 'Visual inspection booth', 'TEST-BOOTH-01', 'Inspection booth'),
    ],
    components: [{ id: 'ampoule', name: 'Glass ampoule, 2 mL, type I', field: 'containerLot' }],
    steps: [
      productBlock('INJ-ROOM-READY', 'ROOM-GRADE-C'),
      productBlock('INJ-WASH', 'AMPOULE-WASHER'),
      productBlock('INJ-DEPYRO', 'DEPYRO-TUNNEL'),
      { ...productBlock('INJ-PARTS-AUTOCLAVE', 'STEAM-STERILISER'), values: { cycle: { loadPattern: 'Filling machine parts' } } },
      productBlock('INJ-COMPOUND', { vesselClass: 'SS-VESSEL-200L', wfiPointClass: 'WFI-POINT-OF-USE' }),
      productBlock('INJ-BULK-FILTER', { filterClass: 'FILTER-0_45UM', receiverClass: 'SS-VESSEL-200L' }),
      { ...productBlock('INJ-FILL', { lineClass: 'AMPOULE-FILLING-LINE', roomClass: 'ROOM-GRADE-C', balanceClass: 'EQC-BAL' }), values: { ...VIAL_COUNTS.fill, setup: { format: 'Ampoule' } } },
      productBlock('IPC-INJ-FILL-WEIGHT', 'EQC-BAL'),
      productBlock('INJ-STERILITY-SAMPLE', {}),
      { ...productBlock('INJ-AMPOULE-SEAL', 'AMPOULE-SEALER'), values: VIAL_COUNTS.capping },
      productBlock('INJ-TERMINAL-STERILISE', 'STEAM-STERILISER'),
      { ...productBlock('INJ-VISUAL-INSPECT', 'INSPECTION-BOOTH'), values: VIAL_COUNTS.inspect },
      productBlock('INJ-CCI', {}),
      // The units rejected at closing are the sealing step's (GMP-YIELDS: no master yield checkpoint, as the vial's).
      { ...productBlock('INJ-UNIT-ACCOUNT', {}, undefined, { capping: 'INJ-AMPOULE-SEAL' }), values: VIAL_COUNTS.account },
    ],
  },
];

/** What a product's library steps name on the sandbox plant: the unit of each class. */
const unitsOf = (t: Injectable): Record<string, string> => ({ ...SANDBOX_BALANCE, ...Object.fromEntries(t.plant.map((u) => [u.classCode, u.code])) });

export function defineInjectablesAcceptance(product: string | Injectable): void {
  // A product of another slice's file (I-2 aseptic, I-3 lyo) is passed as data; the I-1 products by their key.
  const t = typeof product === 'string' ? INJECTABLES.find((x) => x.key === product) : product;
  if (!t) throw new Error(`no injectable ${typeof product === 'string' ? product : product.key} in the acceptance`);
  const codes = [...new Set(t.steps.map((b) => b.def.code))];
  test.describe.configure({ mode: 'serial' });

  test(`[PR-05][DI-04] the library: the author loads the ready-made catalogue as drafts; QA approves each block ${t.name} uses through the signature ceremony @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(20 * 60_000);
    const a = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(a, persona('GMP', 'author'));
    await evidence.step('The author loads the ready-made catalogue', 'The catalogue\'s blocks are drafts; codes the library holds are left alone', async () => {
      await loadCatalogue(a, e2e.url('GMP'));
      return { loaded: true };
    }, a);
    const q = await officePage('GMP', 'PC-QA-02');
    const qa = persona('GMP', 'approver');
    await signIn.office(q, qa);
    await evidence.step('QA approves the injectables blocks the product uses', 'Each version APPROVED by QA with a signature; none by its author', async () => {
      await approveBlocks(q, e2e.url('GMP'), codes, qa);
      return { approved: codes.join(', ') };
    }, q);
  });

  test(`[DI-17][PR-01][PR-03][IN-13][DI-04][DI-05][INV-25] ${t.name}: set up from the library on screen with no code change; its sandbox batch at the further size runs every library step to Execution complete; approved and authorised @office`, async ({ e2e, officePage, kioskPage, persona, evidence, browser }, testInfo) => {
    test.setTimeout(60 * 60_000);
    const steward = persona('GMP', 'steward');
    const qa = persona('GMP', 'approver');
    const author = persona('GMP', 'author');
    const checker = persona('GMP', 'checker');
    const regulatory = persona('GMP', 'regulatory');
    const tag = `R${testInfo.parallelIndex + 1}${randomBytes(3).toString('hex').toUpperCase()}`;
    const product = { code: `${t.prefix}-${tag}`, strength: t.strength, name: t.name };
    const materials: OwnMaterial[] = t.materials.map((m, i) => ({ code: `${t.prefix}-${m.id.toUpperCase()}-${tag}`, name: m.name, tare: m.tare, gross: m.gross, group: i === 0 ? 'act' : 'exc' }));

    const s = await officePage('GMP', 'PC-QA-01');
    await signIn.office(s, steward);
    await evidence.step('The steward enters the materials and the product on screen', 'Each version waits for QA\'s confirmation', async () => {
      await home(s, /^Master data/);
      await s.getByRole('link', { name: 'Products and materials' }).click();
      const m = s.getByRole('form', { name: 'Enter a material' });
      for (const [i, mat] of materials.entries()) {
        await m.getByRole('textbox', { name: 'Material code' }).fill(mat.code);
        await m.getByRole('textbox', { name: 'Material name' }).fill(mat.name);
        await choose(m.getByRole('radio', { name: i === 0 ? 'API' : 'EXCIPIENT', exact: true }));
        await m.getByRole('textbox', { name: 'Stock unit' }).fill('kg');
        await m.getByRole('textbox', { name: 'Grade' }).fill(i === 0 ? 'Sterile grade' : 'Parenteral grade');
        await choose(m.getByRole('radio', { name: i === 0 ? 'IP' : 'BP', exact: true }));
        await m.getByRole('textbox', { name: 'Maximum retest interval (months)' }).fill('24');
        await m.getByRole('textbox', { name: 'Reason for the entry' }).fill('New in-house product; the ERP item is not created yet');
        await m.getByRole('button', { name: 'Enter the material' }).click();
        await expect(s.getByTestId('masters-waiting')).toContainText(mat.code);
        await expect(m.getByRole('textbox', { name: 'Material code' })).toHaveValue('');
      }
      const p = s.getByRole('form', { name: 'Enter a product' });
      await p.getByRole('textbox', { name: 'Product code' }).fill(product.code);
      await p.getByRole('textbox', { name: 'Strength' }).fill(product.strength);
      await p.getByRole('textbox', { name: 'Product name' }).fill(product.name);
      await p.getByRole('textbox', { name: 'Dosage form' }).fill(t.dosageForm);
      await p.getByRole('textbox', { name: 'Shelf life (months)' }).fill('24');
      await choose(p.getByRole('radiogroup', { name: /^Beta-lactam/ }).getByRole('radio', { name: 'No', exact: true }));
      await p.getByRole('textbox', { name: 'Reason for the entry' }).fill('New in-house product; the ERP item is not created yet');
      await p.getByRole('button', { name: 'Enter the product' }).click();
      await expect(s.getByTestId('masters-waiting')).toContainText(product.code);
      return { materials: materials.map((x) => x.code).join(', '), product: product.code };
    }, s);

    let q = await officePage('GMP', 'PC-QA-02');
    await signIn.office(q, qa);
    await evidence.step('QA confirms each master version entered on screen', 'ERP_MASTER_CONFIRMED by QA; the versions are in effect', async () => {
      await home(q, /^Quality/);
      await q.getByRole('link', { name: 'ERP import status' }).click();
      for (const key of [...materials.map((x) => x.code), `${product.code} ${product.strength}`]) {
        await q.getByRole('button', { name: `Confirm ${key}` }).click();
        await officeSign(q, /^Confirm the ERP (material|product) master/, qa);
        await expect(q.getByRole('button', { name: `Confirm ${key}` })).toHaveCount(0);
      }
      return { confirmed: materials.length + 1 };
    }, q);

    await evidence.step('The steward records the formula and writes its version with the solids per unit', `A DRAFT version: per-unit lines, the potency adjustment with its compensating excipient, ${t.targetMg} mg per unit, 50000 as a further size`, async () => {
      await home(s, /^Master data/);
      await s.getByRole('link', { name: 'Formulas' }).click();
      const f = s.getByRole('form', { name: 'Record a formula' });
      await f.getByRole('textbox', { name: 'Product code' }).fill(product.code);
      await f.getByRole('textbox', { name: 'Strength' }).fill(product.strength);
      await f.getByRole('textbox', { name: 'Batch size (units)' }).fill('100000');
      await f.getByRole('button', { name: 'Record the formula' }).click();
      await s.getByTestId(`formula-${product.code}-${product.strength}`).getByRole('link').click();
      const v = s.getByTestId('new-formula-version');
      for (const [i, m] of t.materials.entries()) {
        if (i > 0) await v.getByRole('button', { name: 'Add a line' }).click();
        const g = v.getByRole('group', { name: `Line ${i + 1}` });
        await g.getByRole('textbox', { name: 'Line id' }).fill(m.id);
        await g.getByRole('textbox', { name: 'Material code' }).fill((materials[i] as OwnMaterial).code);
        await choose(g.getByRole('radio', { name: i === 0 ? 'ACTIVE' : 'EXCIPIENT', exact: true }));
        await choose(g.getByRole('radio', { name: 'PER_UNIT', exact: true }));
        await g.getByRole('textbox', { name: 'Quantity' }).fill(m.mgPerUnit);
        await choose(g.getByRole('radiogroup', { name: /^Potency adjusted/ }).getByRole('radio', { name: i === 0 ? 'Yes' : 'No', exact: true }));
        await choose(g.getByRole('radiogroup', { name: /^Compensating excipient/ }).getByRole('radio', { name: i === 1 ? 'Yes' : 'No', exact: true }));
      }
      await v.getByRole('textbox', { name: 'Target unit weight (mg)' }).fill(t.targetMg);
      await v.getByRole('textbox', { name: 'Further batch sizes (units)' }).fill('50000');
      await v.getByRole('textbox', { name: 'Reason for the new version' }).fill('First version: the development formula');
      await v.getByRole('button', { name: 'Write the draft version' }).click();
      await expect(v.getByText('Draft version written.')).toBeVisible();
      await expect(s.getByTestId('formula-version-1')).toContainText('DRAFT');
      await expect(s.getByTestId('formula-target')).toContainText(`${t.targetMg} mg`);
      return { version: 1 };
    }, s);

    await evidence.step('QA approves the formula version', 'FORMULA_APPROVED by a second person; the version is APPROVED', async () => {
      await home(q, /^Master data/);
      await q.getByRole('link', { name: 'Formulas' }).click();
      await q.getByTestId(`formula-${product.code}-${product.strength}`).getByRole('link').click();
      await q.getByRole('button', { name: 'Approve version 1' }).click();
      await officeSign(q, /^Approve formula version 1/, qa);
      await expect(q.getByTestId('formula-version-1')).toContainText('APPROVED');
      return { state: 'APPROVED' };
    }, q);

    let a = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(a, author);
    let versionId = '';
    await evidence.step('The author starts a master from the formula with the required skeleton', 'An Injectables DRAFT whose header, batch sizes and bill of materials are the formula\'s; the dispensing stage and the release for packing; the validator passes', async () => {
      await home(a, /^Master records/);
      await a.getByRole('link', { name: 'New master record (from a template or a formula)' }).click();
      await a.getByRole('radio', { name: /^From the formula, with the required skeleton/ }).check();
      const c = a.getByTestId('choose-product');
      await c.getByRole('textbox', { name: 'Formula product' }).fill(product.code);
      await c.getByRole('textbox', { name: 'Formula strength' }).fill(product.strength);
      await c.getByRole('textbox', { name: 'Formula batch size (units)' }).fill('100000');
      await c.getByRole('button', { name: 'Choose this product' }).click();
      await expect(c.getByTestId('formula-bom')).toContainText(`${t.targetMg} mg`);
      await a.getByRole('textbox', { name: 'Family code' }).fill(`FAM-${tag}`);
      await a.getByRole('button', { name: 'Create the family and its draft' }).click();
      await expect(a.getByRole('toolbar', { name: 'Designer' }).getByText('Passed: no errors, no warnings')).toBeVisible();
      // The header names the edition by the master's dosage form (Capsules C2's mechanism, injectables plan I-1c).
      await expect(a.getByTestId('header-brand')).toContainText('Batchwright Injectables');
      versionId = /\/mbr\/versions\/([0-9a-f-]{36})/.exec(a.url())?.[1] ?? '';
      expect(versionId).not.toBe('');
      // I-1c2: the GMP half takes the product from here.
      saveProduct(e2e, `library-inj-${t.key}`, { tag, product, versionId, familyCode: `FAM-${tag}` });
      await expect(a.getByText('Release for packing').first()).toBeVisible();
      await expect(a.getByText('Blending and lubrication')).toHaveCount(0);
      return { versionId };
    }, a);

    // D-6: the classes the product's library blocks name are on the GMP plant before the master names them (the designer
    // offers the plant's classes); the units and their qualification come later, as before.
    const named = [...t.plant];
    if (named.length > 0) {
      await evidence.step('The steward defines on the GMP plant the equipment classes the product\'s library blocks name', 'Each class listed on Plant definitions', async () => {
        await definePlantClasses(s, e2e.url('GMP'), named);
        return { classes: [...new Set(named.map((u) => u.classCode))].join(', ') };
      }, s);
    }

    await evidence.step('The author adds the product\'s library blocks after the dispensing of the other components with the product\'s values; the checks pass', 'Each block pinned with its version and content hash; the values form shows no problem; the revision saved', async () => {
      await addLibraryBlocks(a, 'p-disp-exc', t.steps);
      await saveRevision(a, `${product.name}: its library blocks and values`);
      await checksPass(a);
      return { blocks: codes.join(', ') };
    }, a);

    const changeRecord = `CC-${tag}`;
    const risk = `RA-${tag}`;
    await evidence.step('QA raises the change record and records the risk assessment; the author links them and sets the draft attributes', 'Change record and assessment recorded and linked', async () => {
      await changeControl(q, a, e2e.url('GMP'), versionId, { changeRecord, risk, title: `New product ${product.code}`, tag });
      return { changeRecord, risk };
    }, a);

    let packageHash = '';
    await evidence.step('The author sends the version to a sandbox test run', 'A test package with the GMP stamp in the sandbox inbox', async () => {
      packageHash = await sendToSandbox(a, e2e.url('GMP'), versionId);
      return { packageHash };
    }, a);

    await a.context().close();
    await q.context().close();
    await s.context().close();
    const lots = materials.map((m, i) => ({ lotCode: `TEST-L26-${tag}-${String(i + 1)}`, material: m }));
    // The components' lots: registered and released as the formula's are, never dispensed (no tare or gross is used). Their
    // material is no line of the master, so a sandbox entry may name it only by a TEST- code (DI-05, EBMR-EXE-147).
    const componentLots = t.components.map((c, i) => ({
      field: c.field,
      lotCode: `TEST-L26-${tag}-${String(materials.length + i + 1)}`,
      material: { code: `TEST-${c.id.toUpperCase()}-${tag}`, name: c.name, tare: '0', gross: '0', group: 'exc' } satisfies OwnMaterial,
    }));
    const stepLots = Object.fromEntries(componentLots.map((c) => [c.field, c.lotCode]));
    let batchNumber = '';
    await evidence.step('Sandbox: the steward registers TEST- lots of the new materials and the product\'s units; the test batch, issued at the further size, runs the dispensing, every library step and the release for packing on the kiosk to Execution complete; its result is exported for GMP', 'The run passed; its result is in to-gmp with the sandbox stamp', async () => {
      await registerTestLots({ officePage, kioskPage, persona }, [...lots, ...componentLots]);
      const sp = await officePage('SANDBOX', 'TEST-PC-01');
      await signIn.office(sp, persona('SANDBOX', 'steward'));
      await definePlantProduct(sp, e2e.url('SANDBOX'), product);
      await registerPlantUnits(sp, e2e.url('SANDBOX'), t.plant);
      await sp.context().close();
      const units = unitsOf(t);
      // The containers the run's steps hand on: filling's trays, consumed into sterilisation's loads.
      const pool: string[] = [];
      const run = await runSkeletonTestBatch(e2e, { officePage, kioskPage, persona, browser }, packageHash, lots, { tare: '0', gross: '0' }, {
        // S10: the batch is issued at the further size (not the reference size); every quantity is scaled to it.
        sizeIndex: 1,
        sizeUnits: '50000',
        dispensingOnly: true,
        afterDispensing: async (page, ctx) => {
          for (const b of t.steps) await runLibraryStep(page, ctx, b, units, stepLots, 1, 'TEST-', pool);
        },
      });
      batchNumber = run.batchNumber;
      return run;
    });

    a = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(a, author);
    await evidence.step('The author starts the verification and imports the sandbox run\'s result', 'IN VERIFICATION; the evidence is complete for this content', async () => {
      await importEvidence(a, e2e.url('GMP'), versionId, batchNumber);
      return { evidence: 'complete' };
    }, a);

    q = await officePage('GMP', 'PC-QA-02');
    await signIn.office(q, qa);
    await evidence.step('Prepared by the author, Checked by the checker, the registration references confirmed, Approved by QA', 'Four people; the version is APPROVED', async () => {
      const c = await officePage('GMP', 'PC-DESIGN-01');
      await signIn.office(c, checker);
      const r = await officePage('GMP', 'PC-QA-02');
      await signIn.office(r, regulatory);
      await fourSignatures({ author: a, checker: c, regulatory: r, qa: q }, { author, checker, regulatory, qa }, e2e.url('GMP'), versionId);
      return { state: 'APPROVED' };
    }, q);

    await evidence.step('QA proposes the IN market authorisation, the regulatory signer confirms it and QA authorises it', 'The authorisation is ACTIVE', async () => {
      const r = await officePage('GMP', 'PC-QA-02');
      await signIn.office(r, regulatory);
      await authoriseIn(q, r, e2e.url('GMP'), versionId, { site: 'SITE-1', line: 'L1', sizeId: 'BS-100000U' }, qa, regulatory, `IN: registration on file (${tag})`);
      return { state: 'ACTIVE' };
    }, q);
  });
}

// ---------------------------------------------------------------------------------------------
// I-1c2 P4a: the GMP half (as the tablets' GMP 1 to GMP 4, library/acceptance.ts S11b)

/** The GMP demo plant's balance (tablets-server cli/release-path.ts): the fill weights are weighed on it, as the tablets' IPCs. */
const GMP_BALANCE: Readonly<Record<string, string>> = { 'EQC-BAL': 'BAL-COMP-01' };

/** The GMP batch's size: the master's reference size, the one the ERP order names and the IN authorisation covers. */
const GMP_UNITS_PER_BATCH = '100000';

/** "0.200", "0.700" as exact thousandths, and back (kg, three decimals). */
const milli = (x: string): bigint => {
  const [i = '0', f = ''] = x.split('.');
  return BigInt(i) * 1000n + BigInt(f.padEnd(3, '0').slice(0, 3));
};
const kg = (m: bigint): string => `${(m / 1000n).toString()}.${(m % 1000n).toString().padStart(3, '0')}`;

interface GmpMaterial {
  id: string;
  code: string;
  name: string;
  active: boolean;
  /** Tare and gross of the one container weighed at 1,00,000 units (twice the sandbox's net, on its tare). */
  tare: string;
  gross: string;
  /** What stores reserve for the batch and the quantity of the first delivery (kg). */
  reserve: string;
  delivery: string;
}

/** The formula's materials as the GMP batch weighs them (the codes the sandbox half entered with this run's tag). */
function gmpMaterials(t: Injectable, tag: string): GmpMaterial[] {
  return t.materials.map((m, i) => {
    const net = (milli(m.gross) - milli(m.tare)) * 2n;
    return {
      id: m.id, code: `${t.prefix}-${m.id.toUpperCase()}-${tag}`, name: m.name, active: i === 0,
      tare: m.tare, gross: kg(milli(m.tare) + net), reserve: kg(net + 1000n), delivery: kg(net * 2n + 10_000n),
    };
  });
}

/**
 * Declares the GMP half of the injectable `productKey` (GMP 1 to GMP 4), after `defineInjectablesAcceptance` in the same
 * serial file: it takes the product, its approved master and its IN authorisation from the sandbox half's state. A
 * product without GMP data (`gmp`) declares nothing.
 */
/** One printed item of an injectables packaging run: its material, TEST- or GMP lot, artwork, and the counts. */
interface PackItem {
  item: 'LABEL' | 'LEAFLET' | 'CARTON';
  material: string;
  lot: string;
  artwork: string;
  issued: string;
  used: string;
  returned: string;
}

/**
 * An injectables packaging order on the packaging line's kiosk (I-1c2 P4b), the master from the P3 skeleton plus the
 * library's cartoning and finished-pack examination:
 *  - the line clearance before use, recorded with no second person (211.130(e); lead ruling A5), then the step;
 *  - the equipment status;
 *  - G-21: each printed lot scanned from the register and issued, its specimen attached, then reconciled;
 *  - PACK-CARTON and INJ-PACK-EXAM through the generic library screen;
 *  - the counts typed by hand and witnessed (GMP-WITNESS); the packaging yield.
 */
async function injPackagingRun(
  f: Floor,
  p: { line: string; cartoner: string; items: readonly PackItem[]; received: string; packed: string; cartoning: ProductBlock; exam: ProductBlock; idPrefix: string; bulk?: readonly string[] },
): Promise<void> {
  const base = f.e2e.url(f.inst);
  const op = f.persona('operator2');
  const verifier = f.persona('verifier1');
  const ctx = { base, runId: f.batchId, operator: op, verifier };
  await cleanForBatch(f);
  const page = await floorKiosk(f, p.line, op);
  if (p.bulk && p.bulk.length > 0) {
    // The bulk: the sterilised loads released for packing (H-PACK), each a verified output container in units.
    await load(page, `${base}/planning/packaging/${f.batchId}`);
    for (const c of p.bulk) await page.getByTestId(`bulk-container-${c}`).getByRole('checkbox').check();
    await act(page, page.getByRole('button', { name: p.bulk.length === 1 ? 'Issue 1 container' : `Issue ${String(p.bulk.length)} containers` }), op);
    await expect(page.getByText('Bulk issued.')).toBeVisible();
  }
  if (!(await done(f, page, 'p-pk-clear@'))) {
    // The clearance on the plant screen, performed only: the step names no checker (211.130(e), lead ruling A5).
    await as(page, op);
    await load(page, `${base}/plant`);
    const box = page.getByTestId('clearance');
    await choose(box.getByRole('radio', { name: new RegExp(`^${f.batchNumber.replace('/', '\\/')} \\(`) }));
    await box.getByRole('textbox', { name: 'Area or line' }).fill(p.line);
    await choose(box.getByRole('radio', { name: 'PACKAGING_ORDER', exact: true }));
    await choose(box.getByRole('radio', { name: 'PASSED', exact: true }));
    await box.getByRole('textbox', { name: /^Packaging order/ }).fill(f.batchNumber);
    // The artwork set the line start must match (at most 64 characters): each artwork code names its item already.
    await box.getByRole('textbox', { name: /^Artwork set/ }).fill(p.items.map((i) => i.artwork).join(','));
    await act(page, box.getByRole('button', { name: 'Record the clearance' }), op);
    await explained(expect(page.getByTestId(`pending-CLEARANCE-${p.line}`).first()).toBeVisible(), box);
    await step(f, page, 'p-pk-clear@');
    await startStep(page, op);
    const plant = page.getByTestId('plant-area');
    await act(page, plant.getByRole('button', { name: new RegExp(`^Start using (room|line) ${p.line} and record it in this step$`) }), op);
    await expect(plant.getByTestId(`occupancy-${p.line}`).getByText('Recorded in this step.')).toBeVisible();
    await performAndCheck(page, op, null, op);
    await completed(page);
  }
  // The equipment status: the cartoner the stage binds, its use booked for the order (G-09@2, PR-23).
  if (!(await done(f, page, 'p-pk-status@'))) await statusStep(f, page, 'p-pk-status@', [{ ref: 'CARTONER', code: p.cartoner, instrument: false }], op);
  await step(f, page, 'p-pk-printed@');
  await begin(page, op);
  for (const i of p.items) {
    const panel = page.getByTestId('printed-lot');
    await panel.getByRole('textbox', { name: 'Scan the printed packaging lot' }).fill(i.lot);
    await panel.getByRole('button', { name: 'Take the lot from the register' }).click();
    await explained(expect(panel.getByTestId('printed-lot-facts')).toContainText(i.lot), panel);
    await entry(page, 'ISSUE', op, { Item: i.item, 'Scanned artwork': i.artwork, Quantity: { Value: i.issued, Unit: '1' } });
  }
  await load(page, `${base}/labels/packaging/${f.batchId}`);
  const specimens = page.getByTestId('packaging-step-p-pk-printed@');
  for (const i of p.items) {
    await act(page, specimens.getByRole('button', { name: `Attach the ${i.item} specimen` }), op);
    await expect(specimens.getByTestId(`label-specimen-${i.item}`)).toContainText('attached by');
  }
  // Cartoning names the carton and leaflet lots the printed-items step issued.
  const lotOf = (item: string): string => p.items.find((i) => i.item === item)?.lot ?? '';
  await runLibraryStep(page, ctx, p.cartoning, { 'EQC-CARTONER': p.cartoner }, { cartonLot: lotOf('CARTON'), leafletLot: lotOf('LEAFLET') }, 1, p.idPrefix);
  await step(f, page, 'p-pk-printed@');
  for (const i of p.items) {
    await entry(page, 'RECONCILIATION', op, { Item: i.item, Used: i.used, 'Setup waste': '0', Damaged: '0', 'Coded destroyed': '0', 'Uncoded returned': i.returned, Specimens: '0' });
  }
  await explained(performAndCheck(page, op, verifier, op), page.locator('main'));
  await completed(page);
  // The line after use, once G-21 is done: no printed material, product or documents left, the line clean; a second
  // person verifies it before the order can complete (EBMR-LBL-061, PR-34), as on the tablets packaging line.
  await load(page, `${base}/labels/packaging/${f.batchId}`);
  const postUse = page.getByTestId('post-use-inspection');
  const postUseForm = postUse.getByTestId('post-use-form');
  await expect(postUseForm.getByRole('radiogroup')).toHaveCount(4);
  for (const group of await postUseForm.getByRole('radiogroup').all()) await choose(group.getByRole('radio', { name: 'Yes', exact: true }));
  await act(page, postUseForm.getByRole('button', { name: 'Record the post-use inspection' }), op);
  await expect(postUse.getByText('not verified yet')).toBeVisible();
  await as(page, verifier);
  await load(page, `${base}/labels/packaging/${f.batchId}`);
  await act(page, page.getByTestId('post-use-inspection').getByRole('button', { name: 'Verify the inspection' }), verifier);
  await expect(page.getByTestId('post-use-inspection').getByText(`verified by ${verifier.legalName}`)).toBeVisible();
  await as(page, op);
  await step(f, page, 'p-pk-count@');
  await begin(page, op);
  await field(page, 'unitsReceived', p.received, op);
  await field(page, 'unitsPacked', p.packed, op);
  await performAndCheck(page, op, verifier, op, 'Witness');
  await completed(page);
  await runLibraryStep(page, ctx, p.exam, {}, {}, 1, p.idPrefix);
  await step(f, page, 'p-pk-yield@');
  await begin(page, op);
  await explained(performAndCheck(page, op, verifier, op), page.locator('main'));
  await completed(page);
  await closeStage(f, page, 'p-pk-yield@', op);
  await releasePlant(f, page, { status: 'p-pk-status@', units: [['CARTONER', p.cartoner]], clear: 'p-pk-clear@', area: p.line }, op);
  await load(page, `${base}/runs/${f.batchId}`);
  await expect(page.getByText('Execution complete').first()).toBeVisible();
  await page.context().close();
}

export function defineInjectablesGmp(product: string | Injectable): void {
  const t = typeof product === 'string' ? INJECTABLES.find((x) => x.key === product) : product;
  if (!t) throw new Error(`no injectable ${typeof product === 'string' ? product : product.key} in the acceptance`);
  const gmp = t.gmp;
  if (!gmp) return;
  // Serial already: `defineInjectablesAcceptance` configures the file (Playwright allows one mode per scope).

  const PC_STEWARD = 'PC-QA-01';
  const PC_QA = 'PC-QA-02';
  const PC_QC = 'PC-QC-01';
  const PC_PLAN = 'PC-PLAN-04';
  const PC_QA2 = 'PC-QA-09';
  const key = `library-inj-${t.key}`;
  const mats = (s: ProductState): GmpMaterial[] => gmpMaterials(t, s.tag);
  /** The primary components on the GMP site: materials of their own (no formula line), named by the library steps' lot fields. */
  const components = (s: ProductState) => t.components.map((c) => ({ ...c, code: `${t.prefix}-${c.id.toUpperCase()}-${s.tag}` }));
  const printedOf = (s: ProductState) => [
    // No product prefix in what a later sandbox entry names: the sandbox refuses a word shaped like a real batch or lot
    // number (DI-05); the run's tag keeps each unique.
    { role: 'label', material: `LBL-${s.tag}`, name: `Printed vial label, ${t.strength} (invented)`, artwork: `ART-LBL-${s.tag}-1`, delivery: '20000' },
    { role: 'leaflet', material: `LFT-${s.tag}`, name: `Printed package leaflet, ${t.strength} (invented)`, artwork: `ART-LFT-${s.tag}-1`, delivery: '20000' },
    { role: 'carton', material: `CTN-${s.tag}`, name: `Printed carton, ${t.strength}, 10 vials (invented)`, artwork: `ART-CTN-${s.tag}-1`, delivery: '5000' },
  ];
  const manufacturer = (s: ProductState) => ({ code: `MFR-${t.prefix}-${s.tag}`, name: `${t.prefix} Parenteral Supplies Pvt Ltd (invented)` });
  /** Every material outside the formula that the site specifies, receives and releases: the components, the printed items. */
  const others = (s: ProductState) => [
    ...components(s).map((c) => ({ role: c.id, material: c.code, test: 'DEFECTS', identity: 'VIS-PC-01', delivery: '20000' })),
    ...printedOf(s).map((p) => ({ role: p.role, material: p.material, test: 'TEXT_CHECK', identity: 'VIS-PM-01', delivery: p.delivery })),
  ];

  test(`[IN-33][PR-17][DI-17][IN-30] ${t.name}, GMP 1: the primary components and the printed label, leaflet and carton entered and confirmed; the specifications of the materials, the components, the printed materials and the product approved by the head of QC; the licence endorsing the product; the manufacturer approved by QA @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(25 * 60_000);
    const s = loadProduct(e2e, key);
    const pr = printedOf(s);
    const comps = components(s);
    const st = await officePage('GMP', PC_STEWARD);
    await signIn.office(st, persona('GMP', 'steward'));
    await evidence.step('The steward enters the primary components and the printed label, leaflet and carton', 'Each waits for QA\'s confirmation', async () => {
      await enterMaterials(st, [
        ...comps.map((c) => ({ code: c.code, name: c.name, kind: 'PRIMARY_PACKAGING' as const, unit: '1', grade: 'Parenteral', pharmacopoeia: 'NONE' as const })),
        ...pr.map((p) => ({ code: p.material, name: p.name, kind: 'PRINTED_PACKAGING' as const, unit: '1', grade: 'Printed', pharmacopoeia: 'NONE' as const })),
      ]);
      return { materials: [...comps.map((c) => c.code), ...pr.map((p) => p.material)].join(', ') };
    }, st);
    const q = await officePage('GMP', PC_QA);
    await signIn.office(q, persona('GMP', 'approver'));
    await evidence.step('QA confirms the components and the printed materials', 'ERP_MASTER_CONFIRMED by a second person', async () => {
      await confirmMasters(q, [...comps.map((c) => c.code), ...pr.map((p) => p.material)], persona('GMP', 'approver'));
    }, q);
    const qc = await officePage('GMP', PC_QC);
    await signIn.office(qc, persona('GMP', 'qcAnalyst'));
    await evidence.step('QC drafts the specifications: the active (assay, water), each excipient (water), each component (defects), the printed label, leaflet and carton (text check) and the product (release tests)', 'A DRAFT specification of each', async () => {
      // DEMO-ONLY: every test, method, limit and sample below is invented for the demonstration, not a real product's
      // or a pharmacopoeia's specification (the materials', the components', the printed items' and the product's).
      for (const m of mats(s)) {
        await draftSpecification(qc, {
          material: m.code, title: m.name, monograph: `In-house specification STP-${m.code}, version 1`,
          tests: m.active
            ? [{ code: 'ASSAY', method: `STP-${t.prefix}-AS-01`, unit: '%', lower: '98.0', upper: '102.0' }, { code: 'WATER', method: 'STP-KF-01', unit: '%', upper: '1.5' }]
            : [{ code: 'WATER', method: 'STP-KF-01', unit: '%', upper: '5.0' }],
        });
      }
      for (const c of comps) {
        await draftSpecification(qc, { material: c.code, title: c.name, monograph: `In-house specification of primary components, version 1 (${s.tag})`, tests: [{ code: 'DEFECTS', method: 'STP-PC-VIS-01', unit: '1', upper: '0' }] });
      }
      for (const p of pr) {
        await draftSpecification(qc, { material: p.material, title: p.name, monograph: `In-house specification of printed materials, version 1 (${s.tag})`, tests: [{ code: 'TEXT_CHECK', method: 'STP-PM-TXT-01', unit: '1', upper: '0' }] });
      }
      // DEMO-ONLY: the finished product's tests, methods, limits and samples are invented values, not a pharmacopoeia's.
      // STERILITY: each batch purporting to be sterile is tested (211.167(a)); the limit is the count of containers with
      // growth. PARTICULATE MATTER: the compendial test for injections (211.160(b)), here particles of 10 µm and above per
      // container. Their results are QC's, recorded on the lot (D-S11-R1).
      await draftSpecification(qc, { material: s.product.code, title: s.product.name, monograph: `In-house finished-product specification STP-${t.prefix}-FP, version 1 (${s.tag})`, tests: [
        { code: 'ASSAY', method: `STP-${t.prefix}-AS-02`, unit: '%', lower: '95.0', upper: '105.0', sample: { quantity: '1', unit: 'packs' } },
        { code: 'BACTERIAL_ENDOTOXINS', method: `STP-${t.prefix}-BET-01`, unit: 'EU/mL', upper: '17.5', sample: { quantity: '1', unit: 'packs' } },
        { code: 'STERILITY', method: `STP-${t.prefix}-STE-01`, unit: '1', upper: '0', sample: { quantity: '20', unit: 'packs' } },
        { code: 'PARTICULATE_MATTER', method: `STP-${t.prefix}-PM-01`, unit: '1', upper: '6000', sample: { quantity: '10', unit: 'packs' } },
      ] });
    }, qc);
    const hq = await officePage('GMP', PC_QC);
    await signIn.office(hq, persona('GMP', 'qcApprover'));
    await evidence.step('The head of QC approves the specifications', 'Each APPROVED and in effect', async () => {
      await approveSpecifications(hq, [...mats(s).map((m) => m.code), ...comps.map((c) => c.code), ...pr.map((p) => p.material), s.product.code], persona('GMP', 'qcApprover'));
    }, hq);
    const rg = await officePage('GMP', PC_QA);
    await signIn.office(rg, persona('GMP', 'regulatory'));
    await evidence.step('The regulatory signer records the site\'s manufacturing licence endorsing the product; QA approves it', 'The issue gate says the product may be issued (IN-30)', async () => {
      await endorseOnLicence(rg, q, { number: `MH/26/${t.prefix}-${s.tag}`, product: s.product.code, strength: s.product.strength }, persona('GMP', 'approver'));
    }, q);
    const qa = await officePage('GMP', PC_QA2);
    await signIn.office(qa, persona('GMP', 'qaInvestigator'));
    await evidence.step('QA proposes and approves the manufacturer of each material, component and printed material', 'APPROVED entries of the register (PR-17)', async () => {
      await approveManufacturers(qa, [...mats(s).map((m) => m.code), ...comps.map((c) => c.code), ...pr.map((p) => p.material)], manufacturer(s), persona('GMP', 'qaInvestigator'));
    }, qa);
  });

  test(`[PR-17][IN-24][IN-33][PR-32] ${t.name}, GMP 2: the first lots of the materials, the components and the printed materials received and examined by stores, tested by QC and approved by the head of QC, the printed lots' artwork recorded, released by QA @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(30 * 60_000);
    const s = loadProduct(e2e, key);
    const pr = printedOf(s);
    const sp = await officePage('GMP', PC_PLAN);
    await signIn.office(sp, persona('GMP', 'stores'));
    const deliveries: (readonly [string, string, string, string])[] = [
      ...mats(s).map((m) => [m.id, m.code, 'kg', m.delivery] as const),
      ...others(s).map((o) => [o.role, o.material, '1', o.delivery] as const),
    ];
    await evidence.step('Stores receive a delivery of each material, component and printed material and examine its container', 'Each lot in quarantine with its receipt record and examination', async () => {
      s.lots ??= {};
      for (const [role, material, unit, quantity] of deliveries) {
        if (s.lots[role]) continue;
        const lot = await receiveDelivery(sp, { delivery: `GRN-${t.prefix}-${s.tag}-${role.toUpperCase()}`, material, unit, supplierLot: `SB-${t.prefix}-${s.tag}-${role.toUpperCase()}`, manufacturer: manufacturer(s).code, quantity, expiry: '2029-06-30' });
        s.lots[role] = lot.lotCode;
        saveProduct(e2e, key, s);
      }
      return { lots: Object.values(s.lots).join(', ') };
    }, sp);
    const lots = s.lots ?? {};
    const qc = await officePage('GMP', PC_QC);
    await signIn.office(qc, persona('GMP', 'qcAnalyst'));
    await evidence.step('QC records each lot\'s results and its identity', 'Every result PASS against the approved specification; identity PASS', async () => {
      for (const m of mats(s)) {
        await openLot(qc, lots[m.id] ?? '');
        // DEMO-ONLY: invented results against the invented specifications.
        await recordResults(qc, m.active ? [['ASSAY', '99.20'], ['WATER', '0.80']] : [['WATER', '2.10']]);
        await recordIdentity(qc, lots[m.id] ?? '', `IR-${t.prefix}-${m.id.toUpperCase()}`);
      }
      for (const o of others(s)) {
        await openLot(qc, lots[o.role] ?? '');
        await recordResults(qc, [[o.test, '0']]);
        await recordIdentity(qc, lots[o.role] ?? '', o.identity);
      }
    }, qc);
    const hq = await officePage('GMP', PC_QC);
    await signIn.office(hq, persona('GMP', 'qcApprover'));
    await evidence.step('The head of QC approves the results', 'Each result APPROVED by a second person', async () => {
      for (const m of mats(s)) {
        await openLot(hq, lots[m.id] ?? '');
        await approveResults(hq, m.active ? ['ASSAY', 'WATER'] : ['WATER'], persona('GMP', 'qcApprover'));
      }
      for (const o of others(s)) {
        await openLot(hq, lots[o.role] ?? '');
        await approveResults(hq, [o.test], persona('GMP', 'qcApprover'));
      }
    }, hq);
    await evidence.step('QC records the artwork version of each printed lot (label, leaflet, carton)', 'The artwork versions G-21 checks', async () => {
      for (const p of pr) {
        await openLot(qc, lots[p.role] ?? '');
        await recordArtwork(qc, lots[p.role] ?? '', p.artwork);
      }
      return { artwork: pr.map((p) => p.artwork).join(', ') };
    }, qc);
    const qa = await officePage('GMP', PC_QA2);
    await signIn.office(qa, persona('GMP', 'qaInvestigator'));
    await evidence.step('QA releases every lot (identity tested)', 'Each lot RELEASED', async () => {
      for (const [role] of deliveries) {
        await openLot(qa, lots[role] ?? '');
        await releaseLot(qa, lots[role] ?? '', persona('GMP', 'qaInvestigator'));
      }
    }, qa);
  });

  test(`[INV-01][PR-04][PR-18][IN-18] ${t.name}, GMP 3: the numbering rules; the GMP plant's units of the product; the ERP simulator sends the processing order; the batch planned and issued at the authorised size; stores reserve the lots @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(20 * 60_000);
    const s = loadProduct(e2e, key);
    const base = e2e.url('GMP');
    const st = await officePage('GMP', PC_STEWARD);
    await signIn.office(st, persona('GMP', 'steward'));
    await evidence.step('The steward defines the product\'s numbering rules at SITE-1 (processing and packaging, IN-18)', 'Both rules listed on Batch numbers', async () => {
      await home(st, /^Batch numbers/);
      await defineNumberingRule(st, { ruleCode: `${t.prefix}-PROC-${s.tag}`, kind: 'PROCESSING', format: `V${s.tag}{SEQ:3}`, product: s.product.code });
      await defineNumberingRule(st, { ruleCode: `${t.prefix}-PACK-${s.tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}', product: s.product.code });
    }, st);
    await evidence.step('The steward lists the product in the GMP plant\'s product list (a room\'s clearance names it)', 'The product is listed on Plant definitions', async () => {
      await definePlantProduct(st, base, s.product);
    }, st);
    await evidence.step('The steward registers the GMP plant\'s units of the classes the product\'s library steps name', 'Each unit defined and QUALIFIED in its logbook', async () => {
      await registerPlantUnits(st, base, gmp.plant);
      return { units: gmp.plant.map((u) => u.code).join(', ') };
    }, st);
    await st.context().close();
    const op = await officePage('GMP', PC_PLAN);
    await signIn.office(op, e2e.seeds.GMP.bootstrap.admin as unknown as Parameters<typeof signIn.office>[1]);
    await evidence.step('The ERP simulator sends a processing order of the product (its master approved and authorised)', 'A new order number; it waits on the planning screen', async () => {
      s.processingOrder = await sendOrder(op, s.product.name, 'processing');
      saveProduct(e2e, key, s);
      return { order: s.processingOrder };
    }, op);
    await op.context().close();
    const issuer = persona('GMP', 'issuer');
    const ip = await officePage('GMP', PC_PLAN);
    await signIn.office(ip, issuer);
    await evidence.step('The batch issuer plans the batch on SITE-1 line L1 and issues it at the authorised size, 1,00,000 units', 'The batch takes its number from the register and is ISSUED', async () => {
      const b = await planAndIssue(ip, base, s.processingOrder ?? '', new RegExp(`MBR ${s.familyCode ?? ''}`), GMP_UNITS_PER_BATCH, issuer);
      s.batchNumber = b.batchNumber;
      s.batchId = b.batchId;
      saveProduct(e2e, key, s);
      return b;
    }, ip);
    await ip.context().close();
    const sp = await officePage('GMP', PC_PLAN);
    await signIn.office(sp, persona('GMP', 'stores'));
    await evidence.step('Stores reserve each lot of the formula\'s materials for the batch', 'Each lot lists the open reservation', async () => {
      await reserveLots(sp, s.batchNumber ?? '', mats(s).map((m) => [s.lots?.[m.id] ?? '', m.reserve] as const));
    }, sp);
  });

  test(`[DI-30][INV-40][PR-20][INV-27][PR-14][PR-19] ${t.name}, GMP 4: the GMP batch on the kiosks: the skeleton's dispensing and every library step with the GMP plant's units; the sterilised loads as verified output containers in units; QA's release for packing (H-PACK) @office`, async ({ e2e, officePage, persona, evidence, browser }) => {
    test.setTimeout(90 * 60_000);
    const s = loadProduct(e2e, key);
    const floor: Floor = {
      e2e, browser, inst: 'GMP', batchId: s.batchId ?? '', batchNumber: s.batchNumber ?? '',
      persona: (k) => persona('GMP', k), containers: (s.gmpContainers ??= {}), save: () => saveProduct(e2e, key, s),
    };
    const units = { ...GMP_BALANCE, ...Object.fromEntries(gmp.plant.map((u) => [u.classCode, u.code])) };
    const stepLots = Object.fromEntries(t.components.map((c) => [c.field, s.lots?.[c.id] ?? '']));
    await evidence.step('GMP floor: the plant cleaned for the batch; dispensing, the product\'s library steps, the sterilised loads into output containers (units, the net verified), the reconciliation, QA\'s release for packing; each person by the Tap button of the demo reader', 'Both stages signed off; H-PACK approved by QA; the run is Execution complete', async () => {
      const lots = mats(s).map((m) => ({ lotCode: s.lots?.[m.id] ?? '', material: { code: m.code, name: m.name, tare: m.tare, gross: m.gross, group: m.active ? ('act' as const) : ('exc' as const) } }));
      // The containers the run's steps hand on: filling's trays, consumed into sterilisation's loads.
      const pool: string[] = [];
      const loads: string[] = [];
      const lotsShown: string[] = [];
      try {
        await skeletonRun(floor, {
          lots, discharge: { tare: '0', gross: '0' }, lubricantKg: '0', dispensingOnly: true,
          afterDispensing: async (page, ctx) => {
            for (const b of t.steps) {
              const breach = gmp.breach?.step === b.def.code ? gmp.breach : undefined;
              const recorded = breach ? { ...b, values: { ...b.values, ...breach.values } } : b;
              await runLibraryStep(page, ctx, recorded, units, stepLots, 1, 'GMP-', pool, breach ? async (p) => {
                const office = await officePage('GMP', PC_PLAN);
                await signIn.office(office, floor.persona('supervisor1'));
                const ref = await linkNewDeviation(office, { base: e2e.url('GMP'), runId: floor.batchId, stepKey: `${stepIdOf(b.def.code)}@` }, { classification: 'Major', rationale: breach.rationale });
                await office.context().close();
                await expect(p.getByTestId('step-card')).toBeVisible();
                (s.marks ??= []).push(`deviation ${ref}`);
                floor.save();
              } : undefined);
              // 211.184(a), 211.188(b)(3): the record names the lot of each container and closure used. The step's
              // completed entry on the kiosk shows the released GMP lot its MATERIAL_LOT field named (the containers at
              // INJ-WASH, the stoppers at INJ-PARTS-AUTOCLAVE, the seals at INJ-CAPPING).
              for (const f of b.def.sections.flatMap((x) => x.fields)) {
                const lot = stepLots[f.id];
                if (f.type !== 'MATERIAL_LOT' || !lot) continue;
                await expect(page.getByRole('region', { name: 'Entries so far' })).toContainText(`${f.label}: ${lot}`);
                lotsShown.push(`${b.def.code}.${f.id}=${lot}`);
              }
            }
            // A library CONTAINER field is a reference only: each container the run's steps left unconsumed in `pool` (the
            // sterilised loads here; filled trays or lyophiliser loads in other forms) is also a physical output container of
            // the batch (units), opened on the containers screen and closed with its typed net, which a second person
            // verifies. The packaging order takes these after H-PACK (injectables resume notes, learnt in P2).
            for (let i = 0; i < pool.length; i += 1) {
              const c = await openContainer(floor, page, gmp.outputStage, ctx.operator, 'units');
              await closeTyped(floor, page, c, gmp.outputUnits, ctx.operator, ctx.verifier);
              loads.push(c);
            }
          },
        });
        loads.forEach((c, i) => { floor.containers[`output-${String(i + 1)}`] = c; });
        floor.save();
      } finally {
        await closeFloor();
      }
      expect(loads.length).toBeGreaterThan(0);
      // Every component's lot (vial, stopper, seal) was shown as used, once each.
      expect(lotsShown.map((x) => x.split('=')[1]).sort()).toEqual(Object.values(stepLots).sort());
      return { loads: loads.join(', '), componentLots: lotsShown.join(', ') };
    });
  });
  /** The packing library steps an injectables packaging master adds to the skeleton (lead P3 ruling; PACK-SHIPPER is
   *  optional and left out: the skeleton's bill of materials has no shipper line). */
  const cartoning = productBlock('PACK-CARTON', 'EQC-CARTONER', { cartonLine: 'BOM-CARTON', leafletLine: 'BOM-LEAFLET' });
  const packExam = productBlock('INJ-PACK-EXAM', {});

  test(`[PR-01][PR-03][PR-31][PR-32][PR-39][IN-14] ${t.name}, GMP 5: the specimens of the label, leaflet and carton recorded and approved by QA; the packaging master from the formula with the firm's allowance, reconciliation limits and specimens; cartoning and the finished-pack examination from the library; the packaging yield range; change control; the test package @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(30 * 60_000);
    const s = loadProduct(e2e, key);
    const base = e2e.url('GMP');
    const pr = printedOf(s);
    const specimen = (role: string): string => `SPC-${role.toUpperCase()}-${s.tag}`;
    const report = `VR-PK-${s.tag}`;
    const st = await officePage('GMP', PC_STEWARD);
    await signIn.office(st, persona('GMP', 'steward'));
    await evidence.step('The steward records the specimen of each printed item and the packaging validation report (the document-management stand-in)', 'Each document version EFFECTIVE on the reference documents', async () => {
      await st.goto(`${base}/mbr`);
      // DEMO-ONLY: the documents are invented stand-ins for the firm's approved specimens (211.188(b)(8)) and its
      // packaging validation report (the source of the yield range).
      const docs = [
        ...pr.map((p) => ({ kind: 'SPECIMEN', code: specimen(p.role), title: `Specimen of the ${p.role}, ${p.artwork}` })),
        { kind: 'VALIDATION_REPORT', code: report, title: `Packaging line validation, ${t.strength} vials` },
      ];
      for (const d of docs) {
        const form = st.getByRole('form', { name: 'Record a reference document version' });
        await choose(form.getByRole('radio', { name: d.kind, exact: true }));
        await form.getByRole('textbox', { name: 'Code', exact: true }).fill(d.code);
        await form.getByRole('textbox', { name: 'Version', exact: true }).fill('1');
        await form.getByRole('textbox', { name: 'Title', exact: true }).fill(d.title);
        await form.getByRole('textbox', { name: 'Effective from (YYYY-MM-DD)', exact: true }).fill('2026-01-01');
        await form.getByRole('textbox', { name: 'Summary', exact: true }).fill('DEMO-ONLY stand-in, invented for the demonstration.');
        await form.getByRole('button', { name: 'Record the document version' }).click();
        await expect(st.getByRole('table', { name: 'Reference documents with version and hash' }).getByRole('row').filter({ hasText: d.code })).toContainText('EFFECTIVE');
      }
      return { documents: docs.map((d) => d.code).join(', ') };
    }, st);
    const q = await officePage('GMP', PC_QA);
    const qa = persona('GMP', 'approver');
    await signIn.office(q, qa);
    await evidence.step('QA approves each specimen (never the person who recorded it) and the packing library blocks', 'Each specimen APPROVED; PACK-CARTON and INJ-PACK-EXAM APPROVED', async () => {
      for (const p of pr) {
        await q.goto(`${base}/mbr/specimens`);
        const item = q.getByTestId(`specimen-${specimen(p.role)}-1`);
        await item.getByRole('button', { name: `Approve specimen ${specimen(p.role)} version 1` }).click();
        await officeSign(q, new RegExp(`^Approve labelling specimen ${specimen(p.role)}`), qa);
        await expect(item).toHaveAttribute('data-state', 'APPROVED');
      }
      await approveBlocks(q, base, [cartoning.def.code, packExam.def.code], qa);
      return { specimens: pr.map((p) => specimen(p.role)).join(', ') };
    }, q);
    const a = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(a, persona('GMP', 'author'));
    await evidence.step('The author starts the injectables packaging master from the formula with the firm\'s values for each printed item', 'An Injectables PACKAGING draft: line clearance, equipment status, the printed items, the counts and the yield', async () => {
      s.packFamilyCode = `FAM-PK-${s.tag}`;
      await home(a, /^Master records/);
      await a.getByRole('link', { name: 'New master record (from a template or a formula)' }).click();
      await a.getByRole('radio', { name: /^From the formula, an injectables packaging master/ }).check();
      const c = a.getByTestId('choose-product');
      await c.getByRole('textbox', { name: 'Formula product' }).fill(s.product.code);
      await c.getByRole('textbox', { name: 'Formula strength' }).fill(s.product.strength);
      await c.getByRole('textbox', { name: 'Formula batch size (units)' }).fill(GMP_UNITS_PER_BATCH);
      await c.getByRole('button', { name: 'Choose this product' }).click();
      await expect(c.getByTestId('formula-bom')).toBeVisible();
      // DEMO-ONLY: the allowance and the reconciliation limits are invented; a firm types its own (211.125(c)).
      for (const p of pr) {
        const item = p.role.toUpperCase();
        const box = a.getByTestId(`printed-${item}`);
        await box.getByRole('textbox', { name: `Printed material for ${item}` }).fill(p.material);
        await box.getByRole('textbox', { name: `Artwork version for ${item}` }).fill(p.artwork);
        await box.getByRole('textbox', { name: `Issue allowance for ${item}` }).fill('2');
        await box.getByRole('textbox', { name: `Largest unexplained difference for ${item}`, exact: true }).fill('0');
        await box.getByRole('textbox', { name: `Approved specimen (document code) for ${item}` }).fill(specimen(p.role));
      }
      await a.getByRole('textbox', { name: 'Family code' }).fill(s.packFamilyCode);
      await a.getByRole('button', { name: 'Create the family and its draft' }).click();
      await expect(a.getByTestId('header-brand')).toContainText('Batchwright Injectables');
      s.packVersionId = /\/mbr\/versions\/([0-9a-f-]{36})/.exec(a.url())?.[1] ?? '';
      expect(s.packVersionId).toMatch(/^[0-9a-f-]{36}$/);
      saveProduct(e2e, key, s);
      return { versionId: s.packVersionId };
    }, a);
    await evidence.step('The author adds cartoning and the finished-pack examination, and sets the packaging yield range from the validation report; the checks pass', 'Both blocks pinned; the yield range with its source; no error, no warning', async () => {
      // The skeleton's packing branch runs beside G-21, which stays open from the issue to the reconciliation. Cartoning
      // is added in that branch (after the counts, the only step there) and moved up before them.
      // Cartoning names the carton and leaflet lots; G-21 alone consumes them (issued and reconciled there).
      await addLibraryBlocks(a, 'p-pk-count', [cartoning], { consumeLines: false });
      const cartonRow = a.locator('tr[data-step-row][data-node="p-pack-carton"]');
      await cartonRow.getByRole('button', { name: /^Actions for step / }).click();
      await a.getByRole('menuitem', { name: 'Move up' }).click();
      await expect.poll(async () => {
        const order = await a.locator('tr[data-step-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-node')));
        return order.indexOf('p-pk-count') - order.indexOf('p-pack-carton');
      }).toBe(1);
      // The examination goes after the counts and before the yield, which closes the stage's processing (GMP-STAGE-YIELD).
      await addLibraryBlocks(a, 'p-pk-count', [packExam]);
      // DEMO-ONLY: the range is invented; the firm's comes from its validated packaging line (211.103, 211.192).
      // The yield checkpoint's own limits (its calculation, also named Packaging yield, has an editor of its own).
      const y = a.locator('#mbr-item-Y-PACK');
      await y.getByRole('combobox', { name: 'Tier of the new range of Packaging yield' }).selectOption('VALIDATED');
      await y.getByRole('combobox', { name: 'Source of the new range of Packaging yield' }).selectOption(report);
      await y.getByRole('button', { name: 'Add limits to Packaging yield' }).click();
      for (const [side, value] of [['lower', '98.0'], ['upper', '100.0']] as const) {
        const box = y.getByRole('textbox', { name: new RegExp(`^Packaging yield, .*, ${side} limit$`) });
        await box.fill(value);
        await box.press('Tab');
      }
      // The skeleton binds no room: the author names the packaging line the stage runs on, where its line clearance and
      // its start are recorded (211.130(e)).
      const rooms = a.getByTestId('stage-editor-S-PACK').getByRole('textbox', { name: /^Rooms of .* \(comma separated\)$/ });
      await rooms.fill('PL-2');
      await rooms.press('Tab');
      await expect(a.locator('div[data-node="S-PACK"]')).toContainText('Rooms: PL-2');
      // The skeleton binds no equipment, so its equipment-status step has no unit to check (G-09@2 needs one): the author
      // binds the cartoner to the stage and the status step checks it (211.67, 211.182; PR-23).
      const adder = a.getByTestId('stage-equipment-add-S-PACK');
      const cls = adder.getByRole('combobox', { name: 'Equipment class for Labelling and packing', exact: true });
      await cls.selectOption((await cls.locator('option', { hasText: '(EQC-CARTONER v' }).first().getAttribute('value')) ?? '');
      await adder.getByRole('textbox', { name: 'Equipment reference for Labelling and packing' }).fill('CARTONER');
      await adder.getByRole('combobox', { name: 'Equipment kind for Labelling and packing' }).selectOption('PROCESS');
      await adder.getByRole('button', { name: 'Add the equipment to Labelling and packing' }).click();
      await expect(a.locator('div[data-node="S-PACK"]')).toContainText('CARTONER');
      await selectStep(a, /Packaging line: equipment status/);
      await a.getByRole('group', { name: 'Stage equipment' }).getByRole('checkbox', { name: 'checks its status' }).check();
      await saveRevision(a, `${s.product.name}: packing steps, the packaging line, its cartoner and the packaging yield range`);
      await checksPass(a);
      return { blocks: `${cartoning.def.code}, ${packExam.def.code}` };
    }, a);
    await evidence.step('Change control; the test package is written', 'A test package with the GMP stamp in the sandbox inbox', async () => {
      await changeControl(q, a, base, s.packVersionId ?? '', { changeRecord: `CC-PK-${s.tag}`, risk: `RA-PK-${s.tag}`, title: `New pack of ${s.product.code}, 10 vials per carton`, tag: `PK-${s.tag}` });
      s.packPackageHash = await sendToSandbox(a, base, s.packVersionId ?? '');
      saveProduct(e2e, key, s);
      return { packageHash: s.packPackageHash };
    }, a);
  });
  test(`[DI-04][DI-05][INV-18][PR-03][PR-32][PR-39][IN-38] ${t.name}, GMP 6: the packaging master's sandbox test run on the packaging kiosk with TEST- printed lots; its result imported as evidence; the four signatures and the IN authorisation @office`, async ({ e2e, officePage, persona, evidence, browser }) => {
    test.setTimeout(60 * 60_000);
    const s = loadProduct(e2e, key);
    const sbx = e2e.url('SANDBOX');
    const pr = printedOf(s);
    // Within 27 characters, so the lot number stays whole when read with a second TEST- (32, kernel 1030): a longer one
    // is split and a part reads as a real lot number (EBMR-EXE-147, seen with TEST-L26-<tag>-PK-LEAFLET).
    const lotCode = (role: string): string => `TEST-L26-${s.tag}-${role.toUpperCase()}`;
    const st = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(st, persona('SANDBOX', 'steward'));
    await evidence.step('Sandbox: TEST- lots of the product\'s label, leaflet and carton, with their artwork', 'TEST- lots RELEASED (sandbox database only)', async () => {
      await registerArtworkTestLots(st, pr.map((p) => ({ lotCode: lotCode(p.role), material: p.material, name: p.name, artwork: p.artwork })));
    }, st);
    const iss = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(iss, persona('SANDBOX', 'issuer'));
    await evidence.step('Sandbox: the issuer imports the packaging test package and issues a test packaging order', 'A TEST- batch number', async () => {
      const run = await issueTestBatch(iss, s.packPackageHash ?? '', GMP_UNITS_PER_BATCH);
      s.sandboxPackRunId = run.runId;
      s.sandboxPackBatchNumber = run.batchNumber;
      saveProduct(e2e, key, s);
      return run;
    }, iss);
    const floor: Floor = {
      e2e, browser, inst: 'SANDBOX', batchId: s.sandboxPackRunId ?? '', batchNumber: s.sandboxPackBatchNumber ?? '',
      persona: (k) => persona('SANDBOX', k), containers: (s.sandboxPackContainers ??= {}), save: () => saveProduct(e2e, key, s),
    };
    await evidence.step('Sandbox floor: the vial packaging on the packaging kiosk', 'Execution complete; every screen with the TEST, NOT GMP band', async () => {
      try {
        await injPackagingRun(floor, {
          line: 'PL-2', cartoner: 'TEST-CTN-03', cartoning, exam: packExam, idPrefix: 'TEST-', received: '1000', packed: '990',
          items: pr.map((p) => ({ item: p.role.toUpperCase() as PackItem['item'], material: p.material, lot: lotCode(p.role), artwork: p.artwork, issued: p.role === 'carton' ? '110' : '1010', used: p.role === 'carton' ? '99' : '990', returned: p.role === 'carton' ? '11' : '20' })),
        });
      } finally {
        await closeFloor();
      }
    });
    const iss2 = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(iss2, persona('SANDBOX', 'issuer'));
    await evidence.step('Sandbox: the issuer exports the test-run result for GMP', 'It passed; the result is in to-gmp with the sandbox stamp', async () => ({ resultFile: await exportTestResult(iss2, sbx, s.sandboxPackRunId ?? '') }), iss2);
    const base = e2e.url('GMP');
    const a = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(a, persona('GMP', 'author'));
    await evidence.step('The author starts the verification and imports the sandbox run\'s result', 'The evidence is complete for this content', async () => {
      await importEvidence(a, base, s.packVersionId ?? '', s.sandboxPackBatchNumber ?? '');
    }, a);
    const c = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(c, persona('GMP', 'checker'));
    const r = await officePage('GMP', PC_QA);
    await signIn.office(r, persona('GMP', 'regulatory'));
    const q = await officePage('GMP', PC_QA);
    await signIn.office(q, persona('GMP', 'approver'));
    await evidence.step('The four signatures and the IN authorisation of the packaging master', 'APPROVED; the IN authorisation ACTIVE', async () => {
      await fourSignatures({ author: a, checker: c, regulatory: r, qa: q }, { author: persona('GMP', 'author'), checker: persona('GMP', 'checker'), regulatory: persona('GMP', 'regulatory'), qa: persona('GMP', 'approver') }, base, s.packVersionId ?? '');
      await authoriseIn(q, r, base, s.packVersionId ?? '', { site: 'SITE-1', line: 'L1', sizeId: 'BS-100000U' }, persona('GMP', 'approver'), persona('GMP', 'regulatory'), `IN: registration of the pack on file (${s.tag})`);
    }, q);
  });

  /**
   * The packaging order's counts. The bulk is GMP 4's sterilised loads, each a verified output container of
   * `gmp.outputUnits`. DEMO-ONLY: 20 vials of each load kept back at the line; one label and one leaflet per vial, ten
   * vials per carton; what is not used goes back, so each item reconciles with no unexplained difference (211.125(c)).
   */
  const packCounts = (s: ProductState) => {
    const loads = Object.entries(s.gmpContainers ?? {}).filter(([k]) => k.startsWith('output-')).map(([, c]) => c);
    const received = BigInt(gmp.outputUnits) * BigInt(loads.length);
    const packed = received - 20n * BigInt(loads.length);
    return { loads, received: received.toString(), packed: packed.toString(), cartons: (packed / 10n).toString() };
  };

  test(`[IN-38][PR-37][PR-33][PR-34][PR-32][PR-39][INV-27][DI-30] ${t.name}, GMP 7: the packaging order sent, planned from the batch released for packing (H-PACK) and issued; the sterilised loads issued as its bulk; the order run on the packaging kiosk with the product's printed lots @office`, async ({ e2e, officePage, persona, evidence, browser }) => {
    test.setTimeout(60 * 60_000);
    const s = loadProduct(e2e, key);
    const base = e2e.url('GMP');
    const pr = printedOf(s);
    const op = await officePage('GMP', PC_PLAN);
    await signIn.office(op, e2e.seeds.GMP.bootstrap.admin as unknown as Parameters<typeof signIn.office>[1]);
    await evidence.step('The ERP simulator sends a packaging order of the product', 'A new order number; it waits on the planning screen', async () => {
      s.packagingOrder = await sendOrder(op, s.product.name, 'packaging');
      saveProduct(e2e, key, s);
      return { order: s.packagingOrder };
    }, op);
    await op.context().close();
    const issuer = persona('GMP', 'issuer');
    const ip = await officePage('GMP', PC_PLAN);
    await signIn.office(ip, issuer);
    await evidence.step('The batch issuer plans the packaging order of the batch released for packing and issues it', 'The order takes the packaging number of the batch and is ISSUED', async () => {
      const o = await planPackaging(ip, base, s.packagingOrder ?? '', s.batchNumber ?? '', issuer);
      s.orderNumber = o.orderNumber;
      s.orderId = o.orderId;
      saveProduct(e2e, key, s);
      return o;
    }, ip);
    await ip.context().close();
    const { loads, received, packed, cartons } = packCounts(s);
    expect(loads.length).toBeGreaterThan(0);
    const floor: Floor = {
      e2e, browser, inst: 'GMP', batchId: s.orderId ?? '', batchNumber: s.orderNumber ?? '',
      persona: (k) => persona('GMP', k), containers: (s.packContainers ??= {}), save: () => saveProduct(e2e, key, s),
    };
    await evidence.step('GMP floor: the sterilised loads issued to the order; the vial packaging on the packaging kiosk with the product\'s printed lots', 'The packaging stage is signed off and the order is Execution complete', async () => {
      const issued = (role: string): bigint => (role === 'carton' ? BigInt(cartons) + 30n : BigInt(packed) + 200n);
      const used = (role: string): bigint => (role === 'carton' ? BigInt(cartons) : BigInt(packed));
      try {
        await injPackagingRun(floor, {
          line: 'PL-2', cartoner: 'CTN-03', cartoning, exam: packExam, idPrefix: 'GMP-', received, packed, bulk: loads,
          items: pr.map((p) => ({
            item: p.role.toUpperCase() as PackItem['item'], material: p.material, lot: s.lots?.[p.role] ?? '', artwork: p.artwork,
            issued: issued(p.role).toString(), used: used(p.role).toString(), returned: (issued(p.role) - used(p.role)).toString(),
          })),
        });
      } finally {
        await closeFloor();
      }
      return { bulk: loads.join(', '), received, packed, cartons };
    });
  });

  test(`[IN-05][PR-45][DI-35][IN-33] ${t.name}, GMP 8: the finished lot posted in quarantine; QC records its results against the product's specification, sterility and particulate matter included, and pulls the reserve sample; the head of QC approves them @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(15 * 60_000);
    const s = loadProduct(e2e, key);
    const base = e2e.url('GMP');
    const sp = await officePage('GMP', PC_PLAN);
    await signIn.office(sp, persona('GMP', 'stores'));
    await evidence.step('Stores post the finished cartons of the order as its lot, in quarantine', 'The lot of the order is listed', async () => {
      s.lotId = await postFinishedLot(sp, base, s.orderId ?? '', s.orderNumber ?? '', packCounts(s).cartons);
      s.lotCode = s.orderNumber ?? '';
      saveProduct(e2e, key, s);
      return { lot: s.lotCode, packs: packCounts(s).cartons };
    }, sp);
    // DEMO-ONLY results, invented; each within the product's specification (GMP 1). Sterility (211.167(a)) and particulate
    // matter (211.160(b)) are QC results on the lot, as every release test (D-S11-R1).
    const results = [['ASSAY', '99.6'], ['BACTERIAL_ENDOTOXINS', '2.5'], ['STERILITY', '0'], ['PARTICULATE_MATTER', '850']] as const;
    const qc = await officePage('GMP', PC_QC);
    await signIn.office(qc, persona('GMP', 'qcAnalyst'));
    await evidence.step('QC records the release results of the lot and pulls its reserve samples', 'Each result PASS against the product\'s specification; the reserve sample is listed', async () => {
      await openLot(qc, s.lotCode ?? '');
      await recordResults(qc, results);
      // At least twice the quantity the full test plan needs (211.170(b); G3.SAMPLES, PR-44, IN-32): 64 packs with the
      // sterility test's units (DEMO-ONLY plan quantities from the product's specification).
      await pullReserveSample(qc, s.lotCode ?? '', '64');
    }, qc);
    const hq = await officePage('GMP', PC_QC);
    await signIn.office(hq, persona('GMP', 'qcApprover'));
    await evidence.step('The head of QC approves the results', 'Each result APPROVED by a second person', async () => {
      await openLot(hq, s.lotCode ?? '');
      await approveResults(hq, results.map(([c]) => c), persona('GMP', 'qcApprover'));
    }, hq);
  });

  // I-2b: a product whose GMP batch recorded a value above its action limit (`gmp.breach`, an EM count after incubation):
  // the lot's release checklist is red on the batch's open deviation until QA has investigated and closed it.
  if (gmp.breach) {
    test(`[ST-21][IN-42][IN-49] ${t.name}, GMP 8b: the EM count above the action limit holds the lot: its release checklist is red on the batch's open deviation until QA investigates, concludes and closes it @office`, async ({ e2e, officePage, persona, evidence }) => {
      test.setTimeout(30 * 60_000);
      const s = loadProduct(e2e, key);
      const refs = (s.marks ?? []).filter((m) => m.startsWith('deviation ')).map((m) => m.slice('deviation '.length));
      expect(refs).toHaveLength(1);
      const cockpit = await officePage('GMP', PC_QA2);
      await signIn.office(cockpit, persona('GMP', 'qcuAuthoriser'));
      const item = cockpit.getByTestId('grel-checklist').getByTestId('grel-item-G2.DEVIATIONS');
      let href = '';
      await evidence.step('The lot cannot be released: its checklist is red on the batch\'s open deviation', 'G2.DEVIATIONS RED, naming the deviation; the lot is not ready', async () => {
        await home(cockpit, /^Release cockpit/);
        const row = cockpit.getByTestId(`release-lot-${s.lotCode ?? ''}`);
        await expect(row).not.toContainText('Ready');
        await row.getByRole('link', { name: s.lotCode ?? '' }).click();
        await expect(item).toHaveAttribute('data-status', 'RED');
        const link = item.locator('a[href*="/deviations/"]').first();
        href = (await link.getAttribute('href')) ?? '';
        expect(href).not.toBe('');
        return { deviation: refs[0] ?? '', href };
      }, cockpit);
      const qa = persona('GMP', 'qaInvestigator');
      const qa2 = persona('GMP', 'qaApprover2');
      const owner = await officePage('GMP', PC_QA2);
      await signIn.office(owner, qa);
      const second = await officePage('GMP', PC_QA2);
      await signIn.office(second, qa2);
      await evidence.step('QA investigates the deviation from the batch\'s record, concludes and closes it', 'The deviation is CLOSED', async () => {
        await owner.goto(`${e2e.url('GMP')}${href}`);
        await expect(owner.getByTestId('deviation-state')).toContainText('OPEN');
        await investigateAndClose({ owner, classifier: cockpit, second }, { owner: qa, second: qa2 }, {
          classification: 'MAJOR',
          rationale: 'A Grade B count above the action limit during an aseptic fill; product sterility assurance to be assessed.',
          cause: 'Operator glove print after the recorded intervention; organism identified as skin flora.',
          causeKind: 'PERSONNEL',
          impact: 'The sterility test of the batch passed; the intervention was on the validated list; the media fill covers it.',
          rootCause: 'Interview, video review of the intervention and the gowning record',
          capa: `CAPA-${s.tag.toUpperCase()}`,
          others: 'Batches filled on the line since the last media fill',
          othersReason: 'Their EM results were within the alert level',
        });
      }, second);
      await evidence.step('The checklist item is green again once the deviation is closed', 'G2.DEVIATIONS GREEN', async () => {
        await home(cockpit, /^Release cockpit/);
        await cockpit.getByTestId(`release-lot-${s.lotCode ?? ''}`).getByRole('link', { name: s.lotCode ?? '' }).click();
        await expect(item).toHaveAttribute('data-status', 'GREEN');
      }, cockpit);
    });
  }

  test(`[INV-05][IN-05][DI-25][INV-48] ${t.name}, GMP 9: both records reviewed and the lot released for IN by the authorised person on a checklist with no red item @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(40 * 60_000);
    const s = loadProduct(e2e, key);
    const base = e2e.url('GMP');
    const head = persona('GMP', 'head1');
    const qa = persona('GMP', 'qaInvestigator');
    const qa2 = persona('GMP', 'qaApprover2');
    const production = await officePage('GMP', PC_PLAN);
    await signIn.office(production, head);
    const qaPage = await officePage('GMP', PC_QA2);
    await signIn.office(qaPage, qa);
    const qa2Page = await officePage('GMP', PC_QA2);
    await signIn.office(qa2Page, qa2);
    const pages = { production, qa: qaPage, qa2: qa2Page };
    const people = { head, qa, qa2 };
    await evidence.step('The processing record reviewed', 'The processing batch is QA reviewed', async () => ({ concluded: await reviewRecord(e2e, pages, people, s.batchId ?? '') }), qa2Page);
    await evidence.step('The packaging record reviewed', 'The packaging order is QA reviewed', async () => ({ concluded: await reviewRecord(e2e, pages, people, s.orderId ?? '') }), qa2Page);
    await evidence.step('QA signs the delta audit-trail review of the processing record if one became due', 'The processing record is covered by its last signed mark', async () => {
      await load(qaPage, `${base}/review/${s.batchId ?? ''}`);
      const panel = qaPage.getByTestId('audit-trail-review');
      await expect(panel.getByTestId('audit-trail-marks')).toBeVisible();
      const button = panel.getByRole('button', { name: 'Sign the delta review' });
      if ((await button.count()) > 0 && (await button.isEnabled())) {
        await button.click();
        await officeSign(qaPage, /^Delta review /, qa);
      }
      await expect(panel.getByText('Covered by the last signed mark')).toBeVisible();
    }, qaPage);
    const cockpit = await officePage('GMP', PC_QA2);
    await signIn.office(cockpit, persona('GMP', 'qcuAuthoriser'));
    await evidence.step('The authorised person releases the lot for IN: ready, no red item on its checklist, the manufacturer release signed', 'The lot is RELEASED', async () => {
      await releaseFinishedLot(cockpit, s.lotCode ?? '', persona('GMP', 'qcuAuthoriser'));
      return { lot: s.lotCode ?? '', state: 'RELEASED' };
    }, cockpit);
  });
}
