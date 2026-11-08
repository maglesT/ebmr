/**
 * API edition A1b (docs/build-plan/api/plan.md, section 4 row C6; lead, 8 November 2026): an API master pair set up on
 * screen from the library with no code change.
 *  - the ready-made catalogue loaded and QA's approval of the API blocks the masters use;
 *  - the steward enters the starting material, the solvent, the drum and the product (dosage form API: the API edition),
 *    QA confirms them; the formula is written and approved;
 *  - the processing master starts blank from the formula (the dispensing clearance and balance status, and QA's release
 *    for packing in a stage of its own) and the author adds the synthesis steps from the library: dispensing, reaction,
 *    completion check, isolation, drying to LOD and the yield; the checks pass;
 *  - the packaging master starts from the same formula as a blank packaging master (PACKAGING_BLANK, offered only for the
 *    API edition): the product and batch sizes are the formula's, its bill of materials the drum the author names, one
 *    packing stage with the line clearance; the author adds the library's pack block (API-PACK, the block that completes an
 *    API packaging record, substance 5000); the checks pass.
 * The header reads Batchwright API on both masters. Every step goes through the generic library form only (owner UI
 * directive). The GMP batch to a released API lot on screen (packaging with the G-21 label specimen, AS-14) is the next
 * part of A1b. DEMO-ONLY data; every code is unique per run.
 */
import { randomBytes } from 'node:crypto';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';
import { checksPass, home, saveRevision } from '../phase7/own-product-flow.ts';
import { addLibraryBlocks, approveBlocks, loadCatalogue, productBlock, type ProductBlock } from './library-support.ts';

/** The synthesis steps of the processing master, in order, after the dispensing's balance status. */
const SYNTHESIS: readonly ProductBlock[] = [
  productBlock('API-DISP', 'FLOOR-BALANCE-150KG', { materialLine: 'BOM-KSM' }),
  productBlock('API-REACT', 'GLR-2000L'),
  productBlock('API-IPC-COMPLETE', 'HPLC'),
  productBlock('API-FILTER', 'NUTSCHE-1M2', { washLine: 'BOM-SOL' }),
  productBlock('API-DRY', 'TRAY-DRYER'),
  productBlock('API-YIELD', 'FLOOR-BALANCE-150KG'),
];
/** The pack: the library block that completes an API packaging record (drums, one entry each). */
const PACK: readonly ProductBlock[] = [productBlock('API-PACK', {})];

test.describe.configure({ mode: 'serial' });

test('[PR-05][DI-04][AS-01] API edition: the author loads the ready-made catalogue as drafts; QA approves each API block the masters use through the signature ceremony @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(20 * 60_000);
  const codes = [...new Set([...SYNTHESIS, ...PACK].map((b) => b.def.code))];
  const a = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(a, persona('GMP', 'author'));
  await evidence.step('The author loads the ready-made catalogue', 'The catalogue\'s blocks are drafts; codes the library holds are left alone', async () => {
    await loadCatalogue(a, e2e.url('GMP'));
    return { loaded: true };
  }, a);
  const q = await officePage('GMP', 'PC-QA-02');
  const qa = persona('GMP', 'approver');
  await signIn.office(q, qa);
  await evidence.step('QA approves the API blocks', 'Each version APPROVED by QA with a signature; none by its author', async () => {
    await approveBlocks(q, e2e.url('GMP'), codes, qa);
    return { approved: codes.join(', ') };
  }, q);
});

test('[PR-01][PR-03][PR-37][DI-04][INV-25][AS-01] API edition: the processing master and its first packaging master are set up on screen from the formula and the library, with no code change; the checks pass on both @office', async ({ officePage, persona, evidence }, testInfo) => {
  test.setTimeout(40 * 60_000);
  const steward = persona('GMP', 'steward');
  const qa = persona('GMP', 'approver');
  const author = persona('GMP', 'author');
  const tag = `R${testInfo.parallelIndex + 1}${randomBytes(3).toString('hex').toUpperCase()}`;
  const product = { code: `LAPI-${tag}`, strength: '99.0 %', name: 'Libapi, an invented API (library)' };
  // The formula's lines (an invented one-step synthesis, per unit of the formula's batch size) and the drum.
  const materials = [
    { line: 'ksm', code: `LAPI-KSM-${tag}`, name: 'Libapi key starting material', kind: 'API', role: 'ACTIVE', mg: '10' },
    { line: 'sol', code: `LAPI-SOL-${tag}`, name: 'Toluene (wash solvent)', kind: 'EXCIPIENT', role: 'EXCIPIENT', mg: '16' },
  ] as const;
  const drum = { code: `LAPI-DRUM-${tag}`, name: 'HDPE drum 30 kg with two PE liners' };

  const s = await officePage('GMP', 'PC-QA-01');
  await signIn.office(s, steward);
  await evidence.step('The steward enters the materials, the drum and the product (dosage form API) on screen', 'Each version waits for QA\'s confirmation', async () => {
    await home(s, /^Master data/);
    await s.getByRole('link', { name: 'Products and materials' }).click();
    const m = s.getByRole('form', { name: 'Enter a material' });
    for (const mat of [...materials, { ...drum, kind: 'PRIMARY_PACKAGING' }]) {
      await m.getByRole('textbox', { name: 'Material code' }).fill(mat.code);
      await m.getByRole('textbox', { name: 'Material name' }).fill(mat.name);
      await choose(m.getByRole('radio', { name: mat.kind, exact: true }));
      await m.getByRole('textbox', { name: 'Stock unit' }).fill(mat.kind === 'PRIMARY_PACKAGING' ? 'nos' : 'kg');
      await m.getByRole('textbox', { name: 'Grade' }).fill('In-house');
      await choose(m.getByRole('radio', { name: 'IN_HOUSE', exact: true }));
      await m.getByRole('textbox', { name: 'Maximum retest interval (months)' }).fill('24');
      await m.getByRole('textbox', { name: 'Reason for the entry' }).fill('New in-house API; the ERP item is not created yet');
      await m.getByRole('button', { name: 'Enter the material' }).click();
      await expect(s.getByTestId('masters-waiting')).toContainText(mat.code);
      await expect(m.getByRole('textbox', { name: 'Material code' })).toHaveValue('');
    }
    const p = s.getByRole('form', { name: 'Enter a product' });
    await p.getByRole('textbox', { name: 'Product code' }).fill(product.code);
    await p.getByRole('textbox', { name: 'Strength' }).fill(product.strength);
    await p.getByRole('textbox', { name: 'Product name' }).fill(product.name);
    await p.getByRole('textbox', { name: 'Dosage form' }).fill('API');
    await p.getByRole('textbox', { name: 'Shelf life (months)' }).fill('36');
    await choose(p.getByRole('radiogroup', { name: /^Beta-lactam/ }).getByRole('radio', { name: 'No', exact: true }));
    await p.getByRole('textbox', { name: 'Reason for the entry' }).fill('New in-house API; the ERP item is not created yet');
    await p.getByRole('button', { name: 'Enter the product' }).click();
    await expect(s.getByTestId('masters-waiting')).toContainText(product.code);
    return { materials: [...materials.map((x) => x.code), drum.code].join(', '), product: product.code };
  }, s);

  const q = await officePage('GMP', 'PC-QA-02');
  await signIn.office(q, qa);
  await evidence.step('QA confirms each master version entered on screen', 'ERP_MASTER_CONFIRMED by QA; the versions are in effect', async () => {
    await home(q, /^Quality/);
    await q.getByRole('link', { name: 'ERP import status' }).click();
    for (const key of [...materials.map((x) => x.code), drum.code, `${product.code} ${product.strength}`]) {
      await q.getByRole('button', { name: `Confirm ${key}` }).click();
      await officeSign(q, /^Confirm the ERP (material|product) master/, qa);
      await expect(q.getByRole('button', { name: `Confirm ${key}` })).toHaveCount(0);
    }
    return { confirmed: materials.length + 2 };
  }, q);

  await evidence.step('The steward records the formula and writes its version', 'A DRAFT version: the starting material and the solvent per unit', async () => {
    await home(s, /^Master data/);
    await s.getByRole('link', { name: 'Formulas' }).click();
    const f = s.getByRole('form', { name: 'Record a formula' });
    await f.getByRole('textbox', { name: 'Product code' }).fill(product.code);
    await f.getByRole('textbox', { name: 'Strength' }).fill(product.strength);
    await f.getByRole('textbox', { name: 'Batch size (units)' }).fill('100000');
    await f.getByRole('button', { name: 'Record the formula' }).click();
    await s.getByTestId(`formula-${product.code}-${product.strength}`).getByRole('link').click();
    const v = s.getByTestId('new-formula-version');
    for (const [i, m] of materials.entries()) {
      if (i > 0) await v.getByRole('button', { name: 'Add a line' }).click();
      const g = v.getByRole('group', { name: `Line ${i + 1}` });
      await g.getByRole('textbox', { name: 'Line id' }).fill(m.line);
      await g.getByRole('textbox', { name: 'Material code' }).fill(m.code);
      await choose(g.getByRole('radio', { name: m.role, exact: true }));
      await choose(g.getByRole('radio', { name: 'PER_UNIT', exact: true }));
      await g.getByRole('textbox', { name: 'Quantity' }).fill(m.mg);
      await choose(g.getByRole('radiogroup', { name: /^Potency adjusted/ }).getByRole('radio', { name: 'No', exact: true }));
      await choose(g.getByRole('radiogroup', { name: /^Compensating excipient/ }).getByRole('radio', { name: 'No', exact: true }));
    }
    await v.getByRole('textbox', { name: 'Reason for the new version' }).fill('First version: the development route');
    await v.getByRole('button', { name: 'Write the draft version' }).click();
    await expect(v.getByText('Draft version written.')).toBeVisible();
    await expect(s.getByTestId('formula-version-1')).toContainText('DRAFT');
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

  const a = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(a, author);
  /** The new-master screen with the product's approved formula chosen. */
  const newMaster = async (): Promise<void> => {
    await home(a, /^Master records/);
    await a.getByRole('link', { name: 'New master record (from a template or a formula)' }).click();
    const c = a.getByTestId('choose-product');
    await c.getByRole('textbox', { name: 'Formula product' }).fill(product.code);
    await c.getByRole('textbox', { name: 'Formula strength' }).fill(product.strength);
    await c.getByRole('textbox', { name: 'Formula batch size (units)' }).fill('100000');
    await c.getByRole('button', { name: 'Choose this product' }).click();
    await expect(c.getByTestId('formula-bom')).toBeVisible();
  };

  await evidence.step('The author starts the processing master blank from the formula and adds the synthesis steps from the library; the checks pass', 'An API DRAFT: the formula\'s header, batch sizes and bill of materials; the library steps before QA\'s release for packing; no error', async () => {
    await newMaster();
    await a.getByRole('radio', { name: /^From the formula, blank/ }).check();
    await a.getByRole('textbox', { name: 'Family code' }).fill(`FAM-${tag}`);
    await a.getByRole('button', { name: 'Create the family and its draft' }).click();
    await expect(a.getByTestId('header-brand')).toContainText('Batchwright API');
    await expect(a.getByText('Release for packing').first()).toBeVisible();
    await addLibraryBlocks(a, 'p-disp-bal', SYNTHESIS);
    await saveRevision(a, `${product.name}: the synthesis steps from the library`);
    await checksPass(a);
    return { blocks: SYNTHESIS.map((b) => b.def.code).join(', ') };
  }, a);

  await evidence.step('The author starts the first packaging master from the same formula as a blank packaging master, names the drum and adds the library\'s pack block; the checks pass', 'An API packaging DRAFT: the formula\'s product and batch sizes, the drum as its bill of materials, the packing stage with the line clearance and the pack; no error', async () => {
    await newMaster();
    // Offered because the server lists the start for this product's edition (the API edition only).
    await a.getByRole('radio', { name: /^A packaging master from the formula, blank/ }).check();
    const packing = a.getByTestId('packing-materials');
    await packing.getByRole('textbox', { name: 'Packing material 1', exact: true }).fill(drum.code);
    await packing.getByRole('textbox', { name: 'Quantity of packing material 1', exact: true }).fill('2');
    await a.getByRole('textbox', { name: 'Family code' }).fill(`FAM-${tag}-PK`);
    await a.getByRole('button', { name: 'Create the family and its draft' }).click();
    await expect(a.getByTestId('header-brand')).toContainText('Batchwright API');
    await expect(a.getByText('Packing').first()).toBeVisible();
    await addLibraryBlocks(a, 'p-disp-clear', PACK);
    await saveRevision(a, `${product.name}: packing into drums`);
    await checksPass(a);
    return { packing: drum.code, blocks: 'API-PACK' };
  }, a);
});
