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
 * The products are data (`INJECTABLES`): a terminally sterilised small-volume vial now; an ampoule is a second entry.
 * The GMP batch to release (I-1c2) is not in this file yet. DEMO-ONLY data; every code is unique per run.
 */
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';
import { checksPass, saveProduct, saveRevision } from '../phase7/own-product-flow.ts';
import { registerTestLots, runSkeletonTestBatch, type OwnMaterial } from '../phase7/own-product-support.ts';
import { addLibraryBlocks, approveBlocks, definePlantProduct, loadCatalogue, productBlock, registerPlantUnits, runLibraryStep, type PlantUnit, type ProductBlock } from './library-support.ts';

/** The start page and a tile of it (as library/acceptance.ts). */
const home = async (page: Page, tile: RegExp): Promise<void> => {
  await page.goto(new URL(page.url()).origin + '/');
  await page.getByTestId('home-all-screens').click(); // declutter D3: the screens are listed under the home's "All screens"
  await page.getByRole('navigation', { name: 'Functions' }).getByRole('link', { name: tile }).click();
};

interface Injectable {
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
  /** The product's library steps, in order, after the dispensing of the other components (before the reconciliation). */
  steps: readonly ProductBlock[];
}

/** A process unit of the sandbox plant (each class its own, as the blocks' examples name them), in the dispensing room. */
const unit = (classCode: string, classDescription: string, code: string, name: string): PlantUnit => ({ classCode, classKind: 'PROCESS', classDescription, code, name, area: 'DISP-1' });

/** The sandbox's balance (tablets-server cli/sandbox-plant.ts): the fill weights are weighed on it. */
const SANDBOX_BALANCE: Readonly<Record<string, string>> = { 'EQC-BAL': 'TEST-BAL-02' };

/**
 * The counts of one nominal vial run that add up (INJ-UNIT-ACCOUNT reads the filling, capping and inspection counts and
 * finds no unit unaccounted for): 10,000 filled, 20 rejected at the line, 40 at capping, 9,800 inspected with 80 rejects
 * (9,720 accepted), 120 sampled and 20 documented losses.
 */
const VIAL_COUNTS = {
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
    // The primary components (vials, stoppers, seals) are not here: every formula line is dispensed by weight except a
    // capsule's shells, and a formula line has no count unit to say "counted, not weighed" (mg or kg only), so
    // INJ-COMPONENT-ACCEPT waits for the lead's decision on that model change.
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
  },
];

/** What a product's library steps name on the sandbox plant: the unit of each class. */
const unitsOf = (t: Injectable): Record<string, string> => ({ ...SANDBOX_BALANCE, ...Object.fromEntries(t.plant.map((u) => [u.classCode, u.code])) });

export function defineInjectablesAcceptance(productKey: string): void {
  const t = INJECTABLES.find((x) => x.key === productKey);
  if (!t) throw new Error(`no injectable ${productKey} in the acceptance`);
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

    await evidence.step('The author adds the product\'s library blocks after the dispensing of the other components with the product\'s values; the checks pass', 'Each block pinned with its version and content hash; the values form shows no problem; the revision saved', async () => {
      await addLibraryBlocks(a, 'p-disp-exc', t.steps);
      await saveRevision(a, `${product.name}: its library blocks and values`);
      await checksPass(a);
      return { blocks: codes.join(', ') };
    }, a);

    const changeRecord = `CC-${tag}`;
    const risk = `RA-${tag}`;
    await evidence.step('QA raises the change record and records the risk assessment; the author links them and sets the draft attributes', 'Change record and assessment recorded and linked', async () => {
      await q.goto(`${e2e.url('GMP')}/mbr/change-records`);
      const raise = q.getByTestId('raise-change-record');
      await raise.getByRole('textbox', { name: 'Change record number' }).fill(changeRecord);
      await raise.getByRole('textbox', { name: 'Title of the change' }).fill(`New product ${product.code}`);
      await choose(raise.getByRole('radio', { name: 'Major' }));
      await choose(raise.getByRole('radio', { name: 'Yes, process-impacting' }));
      await raise.getByRole('textbox', { name: 'Validation reference (optional)' }).fill(`PV-${tag}`);
      await raise.getByRole('button', { name: 'Raise the change record' }).click();
      await expect(raise.getByText(`Change record ${changeRecord} is raised.`)).toBeVisible();
      await q.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/review`);
      const r = q.getByTestId('risk-links');
      await r.getByRole('textbox', { name: 'Assessment code' }).fill(risk);
      await r.getByRole('textbox', { name: 'Title' }).fill('Process risk assessment of the new product');
      await r.getByRole('textbox', { name: 'Risk class' }).fill('MEDIUM');
      await r.getByRole('textbox', { name: 'Rationale reference (the QRM report)' }).fill(`QRM-${tag}`);
      await r.getByRole('button', { name: 'Record the risk assessment' }).click();
      await expect(r.getByText(`Risk assessment ${risk} version 1 is recorded.`)).toBeVisible();

      await a.getByRole('link', { name: 'Change control and evidence' }).click();
      const rl = a.getByTestId('risk-links');
      await rl.getByRole('button', { name: `Link ${risk} version 1` }).click();
      await expect(a.getByTestId(`risk-${risk}`)).toContainText('for the whole master');
      const d = a.getByTestId('draft-attributes');
      await d.getByRole('textbox', { name: 'Change record number' }).fill(changeRecord);
      await d.getByRole('textbox', { name: /^Effective from/ }).fill('2026-01-01T00:00:00+05:30');
      await d.getByRole('textbox', { name: 'Periodic review due (YYYY-MM-DD)' }).fill('2028-12-31');
      await d.getByRole('textbox', { name: 'Reason' }).fill('New product: its change record, effective date and review date');
      await d.getByRole('button', { name: 'Set the draft attributes' }).click();
      await expect(d.getByTestId('draft-change-record')).toContainText(changeRecord);
      return { changeRecord, risk };
    }, a);

    let packageHash = '';
    await evidence.step('The author sends the version to a sandbox test run', 'A test package with the GMP stamp in the sandbox inbox', async () => {
      await a.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}`);
      await a.getByRole('button', { name: 'Send to sandbox…' }).click();
      await a.getByRole('dialog', { name: 'Send to a sandbox test run' }).getByRole('button', { name: 'Write the test package' }).click();
      await expect(a.getByText('The test package is in the sandbox inbox.')).toBeVisible();
      packageHash = /package=([0-9a-f]{64})/.exec((await a.getByRole('link', { name: 'Open the sandbox test packages' }).getAttribute('href')) ?? '')?.[1] ?? '';
      expect(packageHash).toMatch(/^[0-9a-f]{64}$/);
      return { packageHash };
    }, a);

    await a.context().close();
    await q.context().close();
    await s.context().close();
    const lots = materials.map((m, i) => ({ lotCode: `TEST-L26-${tag}-${String(i + 1)}`, material: m }));
    let batchNumber = '';
    await evidence.step('Sandbox: the steward registers TEST- lots of the new materials and the product\'s units; the test batch, issued at the further size, runs the dispensing, every library step and the release for packing on the kiosk to Execution complete; its result is exported for GMP', 'The run passed; its result is in to-gmp with the sandbox stamp', async () => {
      await registerTestLots({ officePage, kioskPage, persona }, lots);
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
          for (const b of t.steps) await runLibraryStep(page, ctx, b, units, {}, 1, 'TEST-', pool);
        },
      });
      batchNumber = run.batchNumber;
      return run;
    });

    a = await officePage('GMP', 'PC-DESIGN-01');
    await signIn.office(a, author);
    await evidence.step('The author starts the verification and imports the sandbox run\'s result', 'IN VERIFICATION; the evidence is complete for this content', async () => {
      await home(a, /^Master records/);
      await a.getByRole('link', { name: new RegExp(`^Open FAM-${tag} version`) }).click();
      await a.getByRole('button', { name: 'Start verification…' }).click();
      await a.getByRole('dialog', { name: 'Start verification' }).getByRole('button', { name: 'Start verification' }).click();
      await a.getByRole('link', { name: 'Change control and evidence' }).click();
      const e = a.getByTestId('verification-evidence');
      for (const kind of ['VALIDATOR', 'VERIFICATION', 'TEST_VECTORS']) await expect(e.getByTestId(`evidence-${kind}`)).toHaveAttribute('data-result', 'PASS');
      await e.getByRole('button', { name: `Import the result of run ${batchNumber}` }).click();
      await expect(e.getByTestId('evidence-SANDBOX_RUN')).toHaveAttribute('data-result', 'PASS');
      await expect(e.getByTestId('evidence-complete')).toHaveText('The evidence is complete for this content.');
      return { evidence: 'complete' };
    }, a);

    const signAs = async (page: Page, label: string, who: SeededPersona): Promise<void> => {
      await page.getByTestId('mbr-lifecycle').getByRole('button', { name: label }).click();
      await officeSign(page, new RegExp(`^${label}`), who);
    };
    q = await officePage('GMP', 'PC-QA-02');
    await signIn.office(q, qa);
    await evidence.step('Prepared by the author, Checked by the checker, the registration references confirmed, Approved by QA', 'Four people; the version is APPROVED', async () => {
      await a.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
      await signAs(a, 'Sign as prepared', author);
      await expect(a.getByTestId('mbr-signing-state')).toContainText('Submitted');
      const c = await officePage('GMP', 'PC-DESIGN-01');
      await signIn.office(c, checker);
      await c.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
      await signAs(c, 'Sign as independently checked', checker);
      await expect(c.getByTestId('mbr-signing-state')).toContainText('Checked');
      const r = await officePage('GMP', 'PC-QA-02');
      await signIn.office(r, regulatory);
      await r.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
      await signAs(r, 'Confirm the registration references', regulatory);
      await expect(r.getByTestId('mbr-sign-REGULATORY_CONFIRM')).toHaveAttribute('data-signed', 'yes');
      await q.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
      await signAs(q, 'Approve for the quality unit', qa);
      await expect(q.getByTestId('mbr-signing-state')).toContainText('Approved');
      return { state: 'APPROVED' };
    }, q);

    await evidence.step('QA proposes the IN market authorisation, the regulatory signer confirms it and QA authorises it', 'The authorisation is ACTIVE', async () => {
      const form = q.getByTestId('mbr-propose-market');
      await form.getByRole('textbox', { name: 'Site' }).fill('SITE-1');
      await form.getByRole('textbox', { name: 'Line' }).fill('L1');
      await form.getByRole('textbox', { name: 'Batch size (its id in the master)' }).fill('BS-100000U');
      await form.getByRole('textbox', { name: /^Regulatory basis/ }).fill(`IN: registration on file (${tag})`);
      await form.getByRole('button', { name: 'Propose the authorisation' }).click();
      await expect(q.getByTestId('market-IN')).toHaveAttribute('data-state', 'PROPOSED');
      const r = await officePage('GMP', 'PC-QA-02');
      await signIn.office(r, regulatory);
      await r.goto(`${e2e.url('GMP')}/mbr/versions/${versionId}/signing`);
      const item = r.getByTestId('market-IN');
      await item.getByRole('button', { name: 'Confirm the registration for IN' }).click();
      await officeSign(r, /^Confirm the registration for IN/, regulatory);
      await q.reload();
      const qi = q.getByTestId('market-IN');
      await qi.getByRole('textbox', { name: 'Reason (authorisation)' }).fill('IN registration confirmed; SITE-1 L1');
      await qi.getByRole('button', { name: 'Authorise for IN' }).click();
      await officeSign(q, /^Authorise for IN/, qa);
      await expect(qi).toHaveAttribute('data-state', 'ACTIVE');
      return { state: 'ACTIVE' };
    }, q);
  });
}
