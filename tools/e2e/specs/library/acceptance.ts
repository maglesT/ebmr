/**
 * Decision 0026 slice S11, the acceptance of the dynamic library: three very different tablets set up through the
 * screens only, from the library, with no change to the product's code, each to a released lot. One spec file per tablet
 * (each its own E2E group, run in parallel in CI) calls `defineAcceptance`, which declares its tests in order:
 *  - the ready-made catalogue loaded and QA's approval of the blocks the tablet uses;
 *  - S11a: as a company does for its own product (phase7/own-product), the steward enters the materials and the
 *    product, QA confirms them; the formula is written and approved; the author starts the master from the formula with
 *    the required skeleton (dispensing; blending with TB-07; QA's release for packing) and adds the product's own steps as
 *    library blocks, each typed with the product's values; change control; the sandbox test batch is issued at the
 *    further approved size (S10) and runs on the kiosks to Execution complete, every library step through the one
 *    generic screen; its result is imported as evidence; four people sign; QA authorises the IN market;
 *  - S11b: the GMP batch, the same screens as Demotab (phase7/own-product-gmp, Demotab 4 to 12): the specifications and
 *    first lots of the materials (QC, the head of QC, QA), the printed foil and carton, the licence, the ERP order, the
 *    batch planned and issued at the authorised size, the GMP floor (the skeleton's stages and every library step with
 *    the GMP plant's units, library/skeleton-floor.ts), the packaging master and its own sandbox run, the packaging
 *    order, QC's results of the finished lot, both records reviewed and the lot released.
 * The three tablets:
 *  - a wet-granulated, film-coated immediate-release tablet: rapid-mixer granulation and fluid-bed drying with its LOD
 *    loop after dispensing; compression, hardness, friability, film coating and disintegration after blending;
 *  - a direct-compression uncoated tablet: compression, uniformity of weight, hardness, friability and disintegration;
 *  - rabeprazole 20 mg enteric-coated with three coats: compression, the seal, enteric and top coats and the enteric
 *    disintegration test (acid, then buffer).
 * Only data is entered, through the screens; the generic defects the runs found were fixed in shared code with tests
 * (PROGRESS.md). DEMO-ONLY data; every code is unique per run.
 */
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SeededPersona } from '@ebmr/test-kit';
import { expect, signIn, test } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { choose } from '../journey/support.ts';
import { reviewRecord } from '../phase7/kiosk-batch-support.ts';
import { closeFloor, packagingRun, type Floor } from '../phase7/own-product-floor.ts';
import {
  authoriseIn, changeControl, checksPass, confirmMasters, enterMaterials, exportTestResult, fourSignatures, importEvidence, issueTestBatch, load, loadProduct, packagingCopy,
  registerTestLots as registerArtworkTestLots, saveProduct, saveRevision, sendToSandbox, type ProductState,
} from '../phase7/own-product-flow.ts';
import {
  approveManufacturers, approveResults, approveSpecifications, defineNumberingRule, draftSpecification, endorseOnLicence, openLot, planAndIssue, planPackaging, postFinishedLot, pullReserveSample,
  receiveDelivery, recordArtwork, recordIdentity, recordResults, releaseFinishedLot, releaseLot, reserveLots, sendOrder,
} from '../phase7/own-product-gmp-flow.ts';
import { registerTestLots, runSkeletonTestBatch, type OwnMaterial, type StageCtx } from '../phase7/own-product-support.ts';
import { addLibraryBlocks, approveBlocks, definePlantProduct, loadCatalogue, productBlock, registerPlantUnits, runLibraryStep, type PlantUnit, type ProductBlock } from './library-support.ts';
import { skeletonRun } from './skeleton-floor.ts';

/** The start page (the application's address; the shell has no home link) and a tile of it. */
const home = async (page: Page, tile: RegExp): Promise<void> => {
  await page.goto(new URL(page.url()).origin + '/');
  await page.getByRole('navigation', { name: 'Functions' }).getByRole('link', { name: tile }).click();
};

/** The sandbox plant's unit of each class (tablets-server cli/sandbox-plant.ts): what an operator names on the kiosk. */
const SANDBOX_UNITS: Readonly<Record<string, string>> = {
  'EQC-BAL': 'TEST-BAL-02',
  'EQC-HT': 'TEST-HT-01',
  'EQC-FRB': 'TEST-FRB-01',
  'EQC-DT': 'TEST-DT-01',
  'EQC-BLENDER': 'TEST-BLD-01',
  'EQC-PRESS-GBT': 'TEST-PRESS-01',
  'EQC-RMG': 'TEST-RMG-01',
  'EQC-FBD': 'TEST-FBD-01',
  'EQC-MILL': 'TEST-MILL-01',
  'EQC-COATER': 'TEST-COATER-01',
  // Registered on screen by the capsule product's test (its plant data, not the demo plant's).
  'EQC-CAPS-FILLER': 'TEST-CAPS-01',
  'EQC-CAPS-POLISH': 'TEST-POLISH-01',
  'EQC-CAPS-CHECKWEIGH': 'TEST-CHECKWEIGH-01',
  'EQC-CAPS-PRINTER': 'TEST-PRINTER-01',
  'EQC-CAPS-INSPECT': 'TEST-INSPECT-01',
  // Registered on screen by the soft-gel product's test (C6b).
  'EQC-SG-FILLMIX': 'TEST-SG-FILLMIX-01',
  'EQC-SG-VISCO': 'TEST-SG-VISCO-01',
  'EQC-SG-MELTER': 'TEST-SG-MELTER-01',
  'EQC-SG-HOLD': 'TEST-SG-HOLD-01',
  'EQC-SG-ENCAP': 'TEST-SG-ENCAP-01',
  'EQC-SG-SEALGAUGE': 'TEST-SG-SEALGAUGE-01',
  'EQC-SG-TUMBLER': 'TEST-SG-TUMBLER-01',
  'EQC-SG-TUNNEL': 'TEST-SG-TUNNEL-01',
  'EQC-SG-HARDNESS': 'TEST-SG-HARDNESS-01',
  'EQC-SG-INSPECT': 'TEST-SG-INSPECT-01',
};

interface Tablet {
  key: string;
  prefix: string;
  name: string;
  strength: string;
  dosageForm: string;
  targetMg: string;
  /** The active first (potency-adjusted), the compensating excipient second, then the lubricant; per unit (mg). Tare and
   *  gross (kg) of the one container weighed for a batch at the further size, 50,000 tablets. */
  materials: readonly {
    id: string;
    name: string;
    mgPerUnit: string;
    tare: string;
    gross: string;
    /** A per-batch line (kg per reference batch, `mgPerUnit` unused): role EXCIPIENT on a capsule (recipe-core 1875), dispensed in its own step and
     *  not charged to the blender; a soft gel's gel-mass components (C6b, D-C6b-1). */
    perBatchKg?: string;
  }[];
  discharge: { tare: string; gross: string };
  afterDispensing: readonly ProductBlock[];
  afterDischarge: readonly ProductBlock[];
  /** Empty capsule shells: a material of its own, the formula's COATING line per unit (`shellMg`, line id `shell`), in
   *  the bill of materials but not dispensed into the blend; the filling step names its lot (Capsules edition C2). */
  shells?: string;
  shellMg?: string;
  /** A library step's MATERIAL_LOT field (its id) naming the lot of the material `id` of `materials` (C6b: the gelatin). */
  stepLots?: Readonly<Record<string, string>>;
  /** Units the plant does not have yet, registered on the sandbox's screens before the batch. */
  plant?: readonly PlantUnit[];
  /** The same for the GMP plant, registered on its screens before the GMP batch. */
  gmpPlant?: readonly PlantUnit[];
  /** S11b: the GMP batch, at the authorised (reference) size of 1,00,000 tablets: the discharge's tare and gross and the
   *  net of the bulk for packing (kg). Each material's container there holds twice the sandbox's net, on the same tare. */
  gmpDischarge: { tare: string; gross: string };
  gmpBulkNet: string;
}

export const TABLETS: readonly Tablet[] = [
  {
    key: 'wg-fc',
    prefix: 'LWG400',
    name: 'Libtab 400 mg, wet granulation, film coated (library)',
    strength: '400 mg',
    dosageForm: 'Film-coated tablet',
    targetMg: '556',
    materials: [
      { id: 'api', name: 'Libtab active', mgPerUnit: '400', tare: '1.250', gross: '21.250' },
      { id: 'lac', name: 'Lactose monohydrate', mgPerUnit: '150', tare: '1.000', gross: '8.500' },
      { id: 'mgs', name: 'Magnesium stearate (lubricant)', mgPerUnit: '6', tare: '0.200', gross: '0.500' },
    ],
    discharge: { tare: '1.000', gross: '28.800' },
    gmpDischarge: { tare: '1.000', gross: '56.600' },
    gmpBulkNet: '55.400',
    afterDispensing: [productBlock('PROC-RMG', 'EQC-RMG'), productBlock('PROC-FBD', 'EQC-FBD')],
    afterDischarge: [productBlock('PROC-COMPRESS', 'EQC-PRESS-GBT'), productBlock('IPC-HARDNESS', 'EQC-HT'), productBlock('IPC-FRIABILITY', 'EQC-FRB'), productBlock('COAT-FILM', 'EQC-COATER'), productBlock('IPC-DT-WATER', 'EQC-DT')],
  },
  {
    key: 'dc',
    prefix: 'LDC250',
    name: 'Libtab 250 mg, direct compression, uncoated (library)',
    strength: '250 mg',
    dosageForm: 'Tablet',
    targetMg: '495',
    materials: [
      { id: 'api', name: 'Libtab DC active', mgPerUnit: '250', tare: '1.250', gross: '13.750' },
      { id: 'mcc', name: 'Microcrystalline cellulose (direct compression)', mgPerUnit: '240', tare: '1.000', gross: '13.000' },
      { id: 'mgs', name: 'Magnesium stearate (lubricant)', mgPerUnit: '5', tare: '0.200', gross: '0.450' },
    ],
    discharge: { tare: '1.000', gross: '25.750' },
    gmpDischarge: { tare: '1.000', gross: '50.500' },
    gmpBulkNet: '49.300',
    afterDispensing: [],
    afterDischarge: [productBlock('PROC-COMPRESS', 'EQC-PRESS-GBT'), productBlock('IPC-WEIGHT-UNIFORMITY', 'EQC-BAL'), productBlock('IPC-HARDNESS', 'EQC-HT'), productBlock('IPC-FRIABILITY', 'EQC-FRB'), productBlock('IPC-DT-WATER', 'EQC-DT')],
  },
  {
    key: 'rabe-ec',
    prefix: 'LRB20',
    name: 'Rabeprazole sodium 20 mg, enteric coated, three coats (library)',
    strength: '20 mg',
    dosageForm: 'Gastro-resistant tablet',
    targetMg: '122',
    materials: [
      { id: 'api', name: 'Rabeprazole sodium', mgPerUnit: '20', tare: '0.250', gross: '1.250' },
      { id: 'man', name: 'Mannitol', mgPerUnit: '100', tare: '1.000', gross: '6.000' },
      { id: 'mgs', name: 'Magnesium stearate (lubricant)', mgPerUnit: '2', tare: '0.100', gross: '0.200' },
    ],
    discharge: { tare: '1.000', gross: '7.100' },
    gmpDischarge: { tare: '1.000', gross: '13.200' },
    gmpBulkNet: '12.050',
    afterDispensing: [],
    afterDischarge: [productBlock('PROC-COMPRESS', 'EQC-PRESS-GBT'), productBlock('COAT-SEAL', 'EQC-COATER'), productBlock('COAT-ENTERIC', 'EQC-COATER'), productBlock('COAT-TOP', 'EQC-COATER'), productBlock('IPC-DT-ENTERIC', 'EQC-DT')],
  },
  {
    // Capsules edition C2 (plan v3): a powder hard capsule on the automatic dosator filler, from the catalogue to its
    // released lot, with no code change; the header reads "Batchwright Capsules" on its master and batch screens.
    key: 'caps',
    prefix: 'LCP200',
    name: 'Libcap 200 mg, hard capsules size 0 (library)',
    strength: '200 mg',
    dosageForm: 'Hard gelatin capsule',
    targetMg: '300',
    materials: [
      { id: 'api', name: 'Libcap active', mgPerUnit: '200', tare: '1.000', gross: '11.000' },
      { id: 'lac', name: 'Lactose monohydrate (capsule grade)', mgPerUnit: '95', tare: '1.000', gross: '5.750' },
      { id: 'mgs', name: 'Magnesium stearate (lubricant)', mgPerUnit: '5', tare: '0.200', gross: '0.450' },
    ],
    discharge: { tare: '1.000', gross: '16.000' },
    gmpDischarge: { tare: '1.000', gross: '31.000' },
    // The filled capsules: the fill less the in-process samples, and the shells (about 96 mg each, size 0).
    gmpBulkNet: '39.400',
    shells: 'Empty hard gelatin capsule shells, size 0',
    shellMg: '96',
    plant: [
      { classCode: 'EQC-CAPS-FILLER', classKind: 'PROCESS', classDescription: 'Automatic capsule filling machine', code: 'TEST-CAPS-01', name: 'Capsule filler', area: 'BLEND-1' },
      { classCode: 'EQC-CAPS-POLISH', classKind: 'PROCESS', classDescription: 'Capsule polishing and sorting machine', code: 'TEST-POLISH-01', name: 'Capsule polisher and sorter', area: 'BLEND-1' },
      { classCode: 'EQC-CAPS-CHECKWEIGH', classKind: 'PROCESS', classDescription: 'Capsule checkweigher', code: 'TEST-CHECKWEIGH-01', name: 'Capsule checkweigher', area: 'BLEND-1' },
      { classCode: 'EQC-CAPS-PRINTER', classKind: 'PROCESS', classDescription: 'Capsule printing machine', code: 'TEST-PRINTER-01', name: 'Capsule printer', area: 'BLEND-1' },
      { classCode: 'EQC-CAPS-INSPECT', classKind: 'PROCESS', classDescription: 'Capsule inspection machine', code: 'TEST-INSPECT-01', name: 'Capsule inspection belt', area: 'BLEND-1' },
    ],
    gmpPlant: [
      { classCode: 'EQC-CAPS-FILLER', classKind: 'PROCESS', classDescription: 'Automatic capsule filling machine', code: 'CAPS-01', name: 'Capsule filler', area: 'BLEND-1' },
      { classCode: 'EQC-CAPS-POLISH', classKind: 'PROCESS', classDescription: 'Capsule polishing and sorting machine', code: 'POLISH-01', name: 'Capsule polisher and sorter', area: 'BLEND-1' },
      { classCode: 'EQC-CAPS-CHECKWEIGH', classKind: 'PROCESS', classDescription: 'Capsule checkweigher', code: 'CAPS-CHECKWEIGH-01', name: 'Capsule checkweigher', area: 'BLEND-1' },
      { classCode: 'EQC-CAPS-PRINTER', classKind: 'PROCESS', classDescription: 'Capsule printing machine', code: 'CAPS-PRINT-01', name: 'Capsule printer', area: 'BLEND-1' },
      { classCode: 'EQC-CAPS-INSPECT', classKind: 'PROCESS', classDescription: 'Capsule inspection machine', code: 'CAPS-INSPECT-01', name: 'Capsule inspection belt', area: 'BLEND-1' },
    ],
    afterDispensing: [],
    afterDischarge: [
      productBlock('PROC-CAPS-FILL', 'EQC-CAPS-FILLER', { shellLine: 'BOM-SHELL' }),
      productBlock('IPC-CAPS-FILL-WEIGHT', 'EQC-BAL'),
      productBlock('IPC-CAPS-LOCK-LENGTH', 'EQC-HT'),
      productBlock('IPC-CAPS-APPEARANCE', {}),
      productBlock('IPC-CAPS-DT', 'EQC-DT'),
      productBlock('PROC-CAPS-POLISH', 'EQC-CAPS-POLISH'),
      // C3: 100 % checkweighing, printing (held for QC at H-PACK before packing) and visual inspection.
      productBlock('PROC-CAPS-CHECKWEIGH', 'EQC-CAPS-CHECKWEIGH'),
      productBlock('PROC-CAPS-PRINT', 'EQC-CAPS-PRINTER'),
      productBlock('PROC-CAPS-INSPECT', 'EQC-CAPS-INSPECT'),
    ],
  },
  {
    // Capsules edition C6b: a soft gelatin capsule (oil suspension fill) on the rotary die encapsulator, from the
    // catalogue to its released, packed lot, with no code change. Two dispensed streams on the formula's skeleton
    // (D-C6b-1): the fill (the active, the oil, the wetting agent) is the per-unit lines, blended with TB-07 as the
    // skeleton's blend; the gel mass (gelatin, glycerin) is per-batch lines, dispensed in their own step and not charged
    // to the blender. No per-unit shells line: the shell is made from the gel mass on the machine.
    key: 'softgel',
    prefix: 'LSG100',
    name: 'Libgel 100 mg, soft gelatin capsules (library)',
    strength: '100 mg',
    dosageForm: 'Soft gelatin capsule',
    // The fill weight per capsule; the shell's is the in-process test's (IPC-SG-FILL-SHELL).
    targetMg: '500',
    materials: [
      { id: 'api', name: 'Libgel active', mgPerUnit: '100', tare: '1.000', gross: '6.000' },
      { id: 'mct', name: 'Medium-chain triglycerides (fill vehicle)', mgPerUnit: '390', tare: '1.000', gross: '20.500' },
      { id: 'lec', name: 'Soya lecithin (wetting agent)', mgPerUnit: '10', tare: '0.200', gross: '0.700' },
      // The gel mass per reference batch of 1,00,000 capsules (the purified water is the plant's, not a lot).
      { id: 'gel', name: 'Gelatin (soft gel grade)', mgPerUnit: '0', perBatchKg: '15', tare: '1.000', gross: '8.500' },
      { id: 'gly', name: 'Glycerin (plasticiser)', mgPerUnit: '0', perBatchKg: '8', tare: '1.000', gross: '5.000' },
    ],
    // The fill: everything charged is discharged.
    discharge: { tare: '1.000', gross: '26.000' },
    gmpDischarge: { tare: '1.000', gross: '51.000' },
    // The dried capsules: the fill and the shell (about 230 mg each), less the in-process samples and the rejects.
    gmpBulkNet: '72.800',
    stepLots: { gelatinLot: 'gel' },
    plant: [
      { classCode: 'EQC-SG-FILLMIX', classKind: 'PROCESS', classDescription: 'Fill preparation vessel (jacketed, under vacuum)', code: 'TEST-SG-FILLMIX-01', name: 'Fill preparation vessel', area: 'BLEND-1' },
      { classCode: 'EQC-SG-VISCO', classKind: 'PROCESS', classDescription: 'Viscometer for fills and gel mass', code: 'TEST-SG-VISCO-01', name: 'Viscometer', area: 'BLEND-1' },
      { classCode: 'EQC-SG-MELTER', classKind: 'PROCESS', classDescription: 'Gel mass melter (jacketed, under vacuum)', code: 'TEST-SG-MELTER-01', name: 'Gel mass melter', area: 'BLEND-1' },
      { classCode: 'EQC-SG-HOLD', classKind: 'PROCESS', classDescription: 'Gel mass holding tank (heated)', code: 'TEST-SG-HOLD-01', name: 'Gel mass holding tank', area: 'BLEND-1' },
      { classCode: 'EQC-SG-ENCAP', classKind: 'PROCESS', classDescription: 'Rotary die soft gel encapsulation machine', code: 'TEST-SG-ENCAP-01', name: 'Rotary die encapsulator', area: 'BLEND-1' },
      { classCode: 'EQC-SG-SEALGAUGE', classKind: 'PROCESS', classDescription: 'Soft gel seal thickness gauge', code: 'TEST-SG-SEALGAUGE-01', name: 'Seal thickness gauge', area: 'BLEND-1' },
      { classCode: 'EQC-SG-TUMBLER', classKind: 'PROCESS', classDescription: 'Soft gel tumble dryer', code: 'TEST-SG-TUMBLER-01', name: 'Tumble dryer', area: 'BLEND-1' },
      { classCode: 'EQC-SG-TUNNEL', classKind: 'PROCESS', classDescription: 'Soft gel drying tunnel (trays)', code: 'TEST-SG-TUNNEL-01', name: 'Drying tunnel', area: 'BLEND-1' },
      { classCode: 'EQC-SG-HARDNESS', classKind: 'PROCESS', classDescription: 'Soft gel hardness tester', code: 'TEST-SG-HARDNESS-01', name: 'Soft gel hardness tester', area: 'BLEND-1' },
      { classCode: 'EQC-SG-INSPECT', classKind: 'PROCESS', classDescription: 'Soft gel inspection machine', code: 'TEST-SG-INSPECT-01', name: 'Soft gel inspection belt', area: 'BLEND-1' },
    ],
    gmpPlant: [
      { classCode: 'EQC-SG-FILLMIX', classKind: 'PROCESS', classDescription: 'Fill preparation vessel (jacketed, under vacuum)', code: 'SG-FILLMIX-01', name: 'Fill preparation vessel', area: 'BLEND-1' },
      { classCode: 'EQC-SG-VISCO', classKind: 'PROCESS', classDescription: 'Viscometer for fills and gel mass', code: 'SG-VISCO-01', name: 'Viscometer', area: 'BLEND-1' },
      { classCode: 'EQC-SG-MELTER', classKind: 'PROCESS', classDescription: 'Gel mass melter (jacketed, under vacuum)', code: 'SG-MELTER-01', name: 'Gel mass melter', area: 'BLEND-1' },
      { classCode: 'EQC-SG-HOLD', classKind: 'PROCESS', classDescription: 'Gel mass holding tank (heated)', code: 'SG-HOLD-01', name: 'Gel mass holding tank', area: 'BLEND-1' },
      { classCode: 'EQC-SG-ENCAP', classKind: 'PROCESS', classDescription: 'Rotary die soft gel encapsulation machine', code: 'SG-ENCAP-01', name: 'Rotary die encapsulator', area: 'BLEND-1' },
      { classCode: 'EQC-SG-SEALGAUGE', classKind: 'PROCESS', classDescription: 'Soft gel seal thickness gauge', code: 'SG-SEALGAUGE-01', name: 'Seal thickness gauge', area: 'BLEND-1' },
      { classCode: 'EQC-SG-TUMBLER', classKind: 'PROCESS', classDescription: 'Soft gel tumble dryer', code: 'SG-TUMBLER-01', name: 'Tumble dryer', area: 'BLEND-1' },
      { classCode: 'EQC-SG-TUNNEL', classKind: 'PROCESS', classDescription: 'Soft gel drying tunnel (trays)', code: 'SG-TUNNEL-01', name: 'Drying tunnel', area: 'BLEND-1' },
      { classCode: 'EQC-SG-HARDNESS', classKind: 'PROCESS', classDescription: 'Soft gel hardness tester', code: 'SG-HARDNESS-01', name: 'Soft gel hardness tester', area: 'BLEND-1' },
      { classCode: 'EQC-SG-INSPECT', classKind: 'PROCESS', classDescription: 'Soft gel inspection machine', code: 'SG-INSPECT-01', name: 'Soft gel inspection belt', area: 'BLEND-1' },
    ],
    afterDispensing: [],
    afterDischarge: [
      // C5: the fill prepared (mixed at temperature, deaerated, its viscosity) from the blended fill.
      productBlock('PROC-FILL-PREP', { vesselClass: 'EQC-SG-FILLMIX', viscometerClass: 'EQC-SG-VISCO' }),
      // C6: the gel mass from the dispensed gel-mass components, the gelatin named by its formula line.
      productBlock('SG-GEL-MASS', 'EQC-SG-MELTER', { gelatinLine: 'BOM-GEL' }),
      // D-C3-6: the gel mass's hold until encapsulation is the master's PROC-HOLD step.
      productBlock('PROC-HOLD', 'EQC-SG-HOLD'),
      productBlock('SG-ENCAP-ROTARY', 'EQC-SG-ENCAP'),
      productBlock('IPC-SG-FILL-SHELL', 'EQC-BAL'),
      productBlock('IPC-SG-SEAL-THICKNESS', 'EQC-SG-SEALGAUGE'),
      productBlock('SG-DRY', { tumbleDryerClass: 'EQC-SG-TUMBLER', tunnelClass: 'EQC-SG-TUNNEL' }),
      productBlock('IPC-SG-HARDNESS', 'EQC-SG-HARDNESS'),
      productBlock('PROC-CAPS-INSPECT', 'EQC-SG-INSPECT'),
    ],
  },
];


/** The GMP demo plant's unit of each class (tablets-server cli/release-path.ts, demo-routes.ts): what an operator names. */
const GMP_UNITS: Readonly<Record<string, string>> = {
  'EQC-BAL': 'BAL-COMP-01',
  'EQC-HT': 'HT-01',
  'EQC-FRB': 'FRB-01',
  'EQC-DT': 'DT-01',
  'EQC-BLENDER': 'BLD-01',
  'EQC-PRESS-GBT': 'PRESS-01',
  'EQC-RMG': 'RMG-01',
  'EQC-FBD': 'FBD-01',
  'EQC-COATER': 'COATER-01',
  // Registered on screen by the capsule product's GMP 3 test.
  'EQC-CAPS-FILLER': 'CAPS-01',
  'EQC-CAPS-POLISH': 'POLISH-01',
  'EQC-CAPS-CHECKWEIGH': 'CAPS-CHECKWEIGH-01',
  'EQC-CAPS-PRINTER': 'CAPS-PRINT-01',
  'EQC-CAPS-INSPECT': 'CAPS-INSPECT-01',
  // Registered on screen by the soft-gel product's GMP 3 test (C6b).
  'EQC-SG-FILLMIX': 'SG-FILLMIX-01',
  'EQC-SG-VISCO': 'SG-VISCO-01',
  'EQC-SG-MELTER': 'SG-MELTER-01',
  'EQC-SG-HOLD': 'SG-HOLD-01',
  'EQC-SG-ENCAP': 'SG-ENCAP-01',
  'EQC-SG-SEALGAUGE': 'SG-SEALGAUGE-01',
  'EQC-SG-TUMBLER': 'SG-TUMBLER-01',
  'EQC-SG-TUNNEL': 'SG-TUNNEL-01',
  'EQC-SG-HARDNESS': 'SG-HARDNESS-01',
  'EQC-SG-INSPECT': 'SG-INSPECT-01',
};

/**
 * The lots a product's library steps name by their MATERIAL_LOT field (field id: lot): a capsule's empty shells
 * (`shellLot`) and the product's own (`stepLots`, C6b); `lotOf` gives the lot of a material id.
 */
function stepLotsOf(t: Tablet, lotOf: (materialId: string) => string): Record<string, string> {
  return {
    ...(t.shells ? { shellLot: lotOf('shell') } : {}),
    ...Object.fromEntries(Object.entries(t.stepLots ?? {}).map(([field, id]) => [field, lotOf(id)])),
  };
}

/** The GMP batch's size: the master's reference size, the one the ERP order names and the IN authorisation covers. */
const GMP_UNITS_PER_BATCH = '100000';

/** Where the tests of one tablet hand on what they made (phase7/own-product-flow's state file). */
const stateKey = (t: Tablet): string => `library-${t.key}`;

/** "1.250", "21.250" -> its net "20.000"; exact, three decimals. */
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
  /** Tare and gross of the one container weighed at 1,00,000 tablets (twice the sandbox's net, on its tare). */
  tare: string;
  gross: string;
  net: string;
  /** What stores reserve for the batch and the quantity of the first delivery (kg). */
  reserve: string;
  delivery: string;
}

/**
 * The empty capsule shells of a capsule product at GMP (the code the S11a test entered): specified, received, tested,
 * released and reserved like the weighed materials, but not dispensed; the filling step names its lot.
 */
function gmpShells(t: Tablet, tag: string): GmpMaterial[] {
  if (!t.shells) return [];
  return [{ id: 'shell', code: `${t.prefix}-SHELL-${tag}`, name: t.shells, active: false, tare: '0', gross: '0', net: '0', reserve: '10.000', delivery: '20.000' }];
}

/** The tablet's materials as the GMP batch weighs them (the codes the S11a test entered with this run's tag). */
function gmpMaterials(t: Tablet, tag: string): GmpMaterial[] {
  return t.materials.map((m, i) => {
    const net = (milli(m.gross) - milli(m.tare)) * 2n;
    return {
      id: m.id, code: `${t.prefix}-${m.id.toUpperCase()}-${tag}`, name: m.name, active: i === 0,
      tare: m.tare, gross: kg(milli(m.tare) + net), net: kg(net), reserve: kg(net + 1000n), delivery: kg(net * 2n + 10_000n),
    };
  });
}

/**
 * Declares the acceptance tests of the tablet `key` of `TABLETS`, in order (serial): the catalogue, S11a, S11b.
 */
export function defineAcceptance(tabletKey: string): void {
  const t = TABLETS.find((x) => x.key === tabletKey);
  if (!t) throw new Error(`no tablet ${tabletKey} in the acceptance`);
  const codes = [...new Set([...t.afterDispensing, ...t.afterDischarge].map((b) => b.def.code))];
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
    await evidence.step('QA approves the blocks the tablet uses', 'Each version APPROVED by QA with a signature; none by its author', async () => {
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
    const materials: OwnMaterial[] = t.materials.map((m, i) => ({ code: `${t.prefix}-${m.id.toUpperCase()}-${tag}`, name: m.name, tare: m.tare, gross: m.gross, group: i === 0 ? 'act' : m.perBatchKg ? 'aid' : 'exc' }));
    // The empty shells are entered and confirmed like any material; the formula does not hold them.
    if (t.shells) materials.push({ code: `${t.prefix}-SHELL-${tag}`, name: t.shells, tare: '0', gross: '0', group: 'exc' });

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
        await m.getByRole('textbox', { name: 'Grade' }).fill(i === 0 ? 'Micronised' : 'Pharma grade');
        await choose(m.getByRole('radio', { name: i === 0 ? 'IP' : 'BP', exact: true }));
        await m.getByRole('textbox', { name: 'Maximum retest interval (months)' }).fill('24');
        await m.getByRole('textbox', { name: 'Reason for the entry' }).fill('New in-house product; the ERP item is not created yet');
        await m.getByRole('button', { name: 'Enter the material' }).click();
        await expect(s.getByTestId('masters-waiting')).toContainText(mat.code);
        // The form clears only when the command returns, which can be after the list shows the code: typing the next
        // material before then loses it (GitHub-hosted run 41580034990).
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

    await evidence.step('The steward records the formula and writes its version with the target tablet weight', 'A DRAFT version: per-unit lines, the potency adjustment with its compensating excipient, 556 mg target, 50000 as a further size', async () => {
      await home(s, /^Master data/);
      await s.getByRole('link', { name: 'Formulas' }).click();
      const f = s.getByRole('form', { name: 'Record a formula' });
      await f.getByRole('textbox', { name: 'Product code' }).fill(product.code);
      await f.getByRole('textbox', { name: 'Strength' }).fill(product.strength);
      await f.getByRole('textbox', { name: 'Batch size (units)' }).fill('100000');
      await f.getByRole('button', { name: 'Record the formula' }).click();
      await s.getByTestId(`formula-${product.code}-${product.strength}`).getByRole('link').click();
      const v = s.getByTestId('new-formula-version');
      // A per-batch line (a soft gel's gel mass, D-C6b-1) is an EXCIPIENT in kg per batch: a capsule's shell components (1875).
      const lines = t.materials.map((m, i) => ({
        id: m.id, mat: materials[i] as OwnMaterial, role: i === 0 ? 'ACTIVE' : 'EXCIPIENT', basis: m.perBatchKg ? 'PER_BATCH' : 'PER_UNIT',
        qty: m.perBatchKg ?? m.mgPerUnit, potency: i === 0 ? 'Yes' : 'No', comp: i === 1 ? 'Yes' : 'No',
      }));
      // A capsule's empty shells: the unit's outer part, a COATING line per unit (C2).
      if (t.shells) lines.push({ id: 'shell', mat: materials[t.materials.length] as OwnMaterial, role: 'COATING', basis: 'PER_UNIT', qty: t.shellMg ?? '96', potency: 'No', comp: 'No' });
      for (const [i, l] of lines.entries()) {
        if (i > 0) await v.getByRole('button', { name: 'Add a line' }).click();
        const g = v.getByRole('group', { name: `Line ${i + 1}` });
        await g.getByRole('textbox', { name: 'Line id' }).fill(l.id);
        await g.getByRole('textbox', { name: 'Material code' }).fill(l.mat.code);
        await choose(g.getByRole('radio', { name: l.role, exact: true }));
        await choose(g.getByRole('radio', { name: l.basis, exact: true }));
        await g.getByRole('textbox', { name: 'Quantity' }).fill(l.qty);
        await choose(g.getByRole('radiogroup', { name: /^Potency adjusted/ }).getByRole('radio', { name: l.potency, exact: true }));
        await choose(g.getByRole('radiogroup', { name: /^Compensating excipient/ }).getByRole('radio', { name: l.comp, exact: true }));
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
    await evidence.step('The author starts a master from the formula with the required skeleton', 'A DRAFT whose header, batch sizes and bill of materials are the formula\'s; dispensing and blending with TB-07; the validator passes', async () => {
      await home(a, /^Master records/);
      await a.getByRole('link', { name: 'New master record (from a template or a formula)' }).click();
      await a.getByRole('radio', { name: /^From the formula, with the required skeleton/ }).check();
      const c = a.getByTestId('choose-product');
      await c.getByRole('textbox', { name: 'Formula product' }).fill(product.code);
      await c.getByRole('textbox', { name: 'Formula strength' }).fill(product.strength);
      await c.getByRole('textbox', { name: 'Formula batch size (units)' }).fill('100000');
      await c.getByRole('button', { name: 'Choose this product' }).click();
      await expect(c.getByTestId('formula-bom')).toContainText(`${t.targetMg} mg`);
      // The lead's condition (C2): a capsule's shells line reads as the empty capsule shells, never as a coating.
      if (t.shells) {
        await expect(c.getByTestId('formula-bom')).toContainText('Empty capsule shells');
        await expect(c.getByTestId('formula-bom')).not.toContainText(/coat/i);
      }
      await a.getByRole('textbox', { name: 'Family code' }).fill(`FAM-${tag}`);
      await a.getByRole('button', { name: 'Create the family and its draft' }).click();
      // A capsule's shells line waits for the filling step that consumes it (added next); a tablet's skeleton passes.
      await expect(a.getByRole('toolbar', { name: 'Designer' }).getByText(t.shells ? /^1 errors, / : 'Passed: no errors, no warnings')).toBeVisible();
      // Capsules edition C2 (decision 0020 amended): the header names the edition by the master's dosage form.
      await expect(a.getByTestId('header-brand')).toContainText(/capsule/i.test(t.dosageForm) ? 'Batchwright Capsules' : 'Batchwright Tablets');
      if (t.shells) {
        const bom = a.getByRole('table', { name: 'Bill of materials' });
        await expect(bom.locator('tr', { hasText: 'BOM-SHELL' })).toContainText('Empty capsule shells');
        await expect(bom).not.toContainText(/coat/i);
      }
      versionId = /\/mbr\/versions\/([0-9a-f-]{36})/.exec(a.url())?.[1] ?? '';
      expect(versionId).not.toBe('');
      // S11b: the GMP half of the acceptance takes the product from here (its own tests, in order).
      saveProduct(e2e, stateKey(t), { tag, product, versionId, familyCode: `FAM-${tag}` });
      await expect(a.getByText('Blending and lubrication').first()).toBeVisible();
      return { versionId };
    }, a);

    // Decision 0026 S11: the product's own steps are library blocks, chosen and given the product's values on screen.
    await evidence.step('The author adds the product\'s library blocks in the designer with the product\'s values; the checks pass', 'Each block pinned with its version and content hash; the values form shows no problem; the revision saved', async () => {
      if (t.afterDispensing.length > 0) await addLibraryBlocks(a, 'p-disp-exc', t.afterDispensing);
      if (t.afterDischarge.length > 0) await addLibraryBlocks(a, 'p-blend-out', t.afterDischarge);
      await saveRevision(a, `${product.name}: its library blocks and values`);
      await checksPass(a);
      return { blocks: [...t.afterDispensing, ...t.afterDischarge].map((b) => b.def.code).join(', ') };
    }, a);

    // The change record, the risk assessment, the draft attributes and the sandbox package, as for any new master
    // (phase7/master-records.spec.ts).
    const changeRecord = `CC-${tag}`;
    const risk = `RA-${tag}`;
    await evidence.step('QA raises the change record and records the risk assessment; the author links them and sends the version to the sandbox', 'Change record and assessment recorded; a test package in the sandbox inbox', async () => {
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
    await evidence.step('Sandbox: the steward registers TEST- lots of the new materials; the test batch, issued at the further size, runs every library step on the kiosks to Execution complete and its result is exported for GMP', 'The run passed; its result is in to-gmp with the sandbox stamp', async () => {
      await registerTestLots({ officePage, kioskPage, persona }, lots);
      // The sandbox plant's data: the product in its product list (a room's clearance names it), units it lacks.
      const sp = await officePage('SANDBOX', 'TEST-PC-01');
      await signIn.office(sp, persona('SANDBOX', 'steward'));
      await definePlantProduct(sp, e2e.url('SANDBOX'), product);
      if (t.plant) await registerPlantUnits(sp, e2e.url('SANDBOX'), t.plant);
      await sp.context().close();
      const shellLot = stepLotsOf(t, (id) => lots[id === 'shell' ? t.materials.length : t.materials.findIndex((m) => m.id === id)]?.lotCode ?? '');
      const run = await runSkeletonTestBatch(e2e, { officePage, kioskPage, persona, browser }, packageHash, lots.slice(0, t.materials.length), t.discharge, {
        // S10: the batch is issued at the further size (not the reference size); every quantity is scaled to it.
        sizeIndex: 1,
        sizeUnits: '50000',
        afterDispensing: async (page, ctx) => {
          for (const b of t.afterDispensing) await runLibraryStep(page, ctx, b, SANDBOX_UNITS, shellLot);
        },
        afterDischarge: async (page, ctx) => {
          for (const b of t.afterDischarge) await runLibraryStep(page, ctx, b, SANDBOX_UNITS, shellLot);
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


  // ---------------------------------------------------------------------------------------------
  // S11b: the GMP batch of the product to its released lot, the same screens as Demotab's (phase7/own-product-gmp,
  // Demotab 4 to 12), on the master built from the library in the test above.

  const PC_STEWARD = 'PC-QA-01';
  const PC_QA = 'PC-QA-02';
  const PC_AUTHOR = 'PC-DESIGN-01';
  const PC_QC = 'PC-QC-01';
  const PC_PLAN = 'PC-PLAN-04';
  const PC_QA2 = 'PC-QA-09';
  const key = stateKey(t);
  const mats = (s: ProductState): GmpMaterial[] => gmpMaterials(t, s.tag);
  /** Every material the GMP site specifies, receives and releases: the weighed ones and a capsule's empty shells. */
  const allMats = (s: ProductState): GmpMaterial[] => [...mats(s), ...gmpShells(t, s.tag)];
  const printedOf = (s: ProductState) => ({
    // No product prefix (LWG400 and the like) in what a sandbox entry names: the sandbox refuses a word shaped like a real
    // batch or lot number (DI-05); the run's tag keeps each unique.
    foil: { material: `FOIL-${s.tag}`, name: `Printed aluminium lidding foil, ${t.strength} (invented)`, artwork: `ART-FOIL-${s.tag}-1` },
    carton: { material: `CTN-${s.tag}`, name: `Printed carton, ${t.strength} 10 x 10 (invented)`, artwork: `ART-CTN-${s.tag}-1` },
  });
  const manufacturer = (s: ProductState) => ({ code: `MFR-${t.prefix}-${s.tag}`, name: `${t.prefix} Fine Chemicals Pvt Ltd (invented)` });

  test(`[IN-33][PR-17][DI-17][IN-30] ${t.name}, GMP 1: the printed foil and carton entered and confirmed; the specifications of the materials, the printed materials and the product approved by the head of QC; the licence endorsing the product; the manufacturer approved by QA @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(25 * 60_000);
    const s = loadProduct(e2e, key);
    const pr = printedOf(s);
    const st = await officePage('GMP', PC_STEWARD);
    await signIn.office(st, persona('GMP', 'steward'));
    await evidence.step('The steward enters the product\'s printed lidding foil and carton', 'Each waits for QA\'s confirmation', async () => {
      await enterMaterials(st, [
        { code: pr.foil.material, name: pr.foil.name, kind: 'PRINTED_PACKAGING', unit: '1', grade: 'Printed', pharmacopoeia: 'NONE' },
        { code: pr.carton.material, name: pr.carton.name, kind: 'PRINTED_PACKAGING', unit: '1', grade: 'Printed', pharmacopoeia: 'NONE' },
      ]);
    }, st);
    const q = await officePage('GMP', PC_QA);
    await signIn.office(q, persona('GMP', 'approver'));
    await evidence.step('QA confirms both printed materials', 'ERP_MASTER_CONFIRMED by a second person', async () => {
      await confirmMasters(q, [pr.foil.material, pr.carton.material], persona('GMP', 'approver'));
    }, q);
    const qc = await officePage('GMP', PC_QC);
    await signIn.office(qc, persona('GMP', 'qcAnalyst'));
    await evidence.step('QC drafts the specifications: the active (assay, water), each excipient (water), the printed foil and carton (text check) and the product (assay, dissolution)', 'A DRAFT specification of each', async () => {
      for (const m of allMats(s)) {
        await draftSpecification(qc, {
          material: m.code, title: m.name, monograph: `In-house specification STP-${m.code}, version 1`,
          tests: m.active
            ? [{ code: 'ASSAY', method: `STP-${t.prefix}-AS-01`, unit: '%', lower: '98.0', upper: '102.0' }, { code: 'WATER', method: 'STP-KF-01', unit: '%', upper: '1.5' }]
            : [{ code: 'WATER', method: 'STP-KF-01', unit: '%', upper: '5.0' }],
        });
      }
      for (const m of [pr.foil, pr.carton]) {
        await draftSpecification(qc, { material: m.material, title: m.name, monograph: `In-house specification of printed materials, version 1 (${s.tag})`, tests: [{ code: 'TEXT_CHECK', method: 'STP-PM-TXT-01', unit: '1', upper: '0' }] });
      }
      await draftSpecification(qc, { material: s.product.code, title: s.product.name, monograph: `In-house finished-product specification STP-${t.prefix}-FP, version 1 (${s.tag})`, tests: [
        { code: 'ASSAY', method: `STP-${t.prefix}-AS-02`, unit: '%', lower: '95.0', upper: '105.0', sample: { quantity: '1', unit: 'packs' } },
        { code: 'DISSOLUTION', method: `STP-${t.prefix}-DS-01`, unit: '%', lower: '80', sample: { quantity: '1', unit: 'packs' } },
      ] });
    }, qc);
    const hq = await officePage('GMP', PC_QC);
    await signIn.office(hq, persona('GMP', 'qcApprover'));
    await evidence.step('The head of QC approves the specifications', 'Each APPROVED and in effect', async () => {
      await approveSpecifications(hq, [...allMats(s).map((m) => m.code), pr.foil.material, pr.carton.material, s.product.code], persona('GMP', 'qcApprover'));
    }, hq);
    const rg = await officePage('GMP', PC_QA);
    await signIn.office(rg, persona('GMP', 'regulatory'));
    await evidence.step('The regulatory signer records the site\'s manufacturing licence endorsing the product; QA approves it', 'The issue gate says the product may be issued (IN-30)', async () => {
      await endorseOnLicence(rg, q, { number: `MH/26/${t.prefix}-${s.tag}`, product: s.product.code, strength: s.product.strength }, persona('GMP', 'approver'));
    }, q);
    const qa = await officePage('GMP', PC_QA2);
    await signIn.office(qa, persona('GMP', 'qaInvestigator'));
    await evidence.step('QA proposes and approves the manufacturer of each material and of the printed materials', 'APPROVED entries of the register (PR-17)', async () => {
      await approveManufacturers(qa, [...allMats(s).map((m) => m.code), pr.foil.material, pr.carton.material], manufacturer(s), persona('GMP', 'qaInvestigator'));
    }, qa);
  });

  test(`[PR-17][IN-24][IN-33][PR-32] ${t.name}, GMP 2: the first lots of the materials and the printed materials received and examined by stores, tested by QC and approved by the head of QC, the printed lots' artwork recorded, released by QA @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(30 * 60_000);
    const s = loadProduct(e2e, key);
    const pr = printedOf(s);
    const sp = await officePage('GMP', PC_PLAN);
    await signIn.office(sp, persona('GMP', 'stores'));
    const deliveries: (readonly [string, string, string, string])[] = [
      ...allMats(s).map((m) => [m.id, m.code, 'kg', m.delivery] as const),
      ['foil', pr.foil.material, '1', '20000'], ['carton', pr.carton.material, '1', '5000'],
    ];
    await evidence.step('Stores receive a delivery of each material and examine its container', 'Each lot in quarantine with its receipt record and examination', async () => {
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
      for (const m of allMats(s)) {
        await openLot(qc, lots[m.id] ?? '');
        await recordResults(qc, m.active ? [['ASSAY', '99.20'], ['WATER', '0.80']] : [['WATER', '2.10']]);
        await recordIdentity(qc, lots[m.id] ?? '', `IR-${t.prefix}-${m.id.toUpperCase()}`);
      }
      for (const role of ['foil', 'carton']) {
        await openLot(qc, lots[role] ?? '');
        await recordResults(qc, [['TEXT_CHECK', '0']]);
        await recordIdentity(qc, lots[role] ?? '', 'VIS-PM-01');
      }
    }, qc);
    const hq = await officePage('GMP', PC_QC);
    await signIn.office(hq, persona('GMP', 'qcApprover'));
    await evidence.step('The head of QC approves the results', 'Each result APPROVED by a second person', async () => {
      for (const m of allMats(s)) {
        await openLot(hq, lots[m.id] ?? '');
        await approveResults(hq, m.active ? ['ASSAY', 'WATER'] : ['WATER'], persona('GMP', 'qcApprover'));
      }
      for (const role of ['foil', 'carton']) {
        await openLot(hq, lots[role] ?? '');
        await approveResults(hq, ['TEXT_CHECK'], persona('GMP', 'qcApprover'));
      }
    }, hq);
    await evidence.step('QC records each printed lot\'s artwork version', 'The artwork versions G-21 checks', async () => {
      await openLot(qc, lots['foil'] ?? '');
      await recordArtwork(qc, lots['foil'] ?? '', pr.foil.artwork);
      await openLot(qc, lots['carton'] ?? '');
      await recordArtwork(qc, lots['carton'] ?? '', pr.carton.artwork);
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

  test(`[INV-01][PR-04][PR-18][IN-18] ${t.name}, GMP 3: the numbering rules; the ERP simulator sends the processing order; the batch planned and issued at the authorised size; stores reserve the lots @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(15 * 60_000);
    const s = loadProduct(e2e, key);
    const base = e2e.url('GMP');
    const st = await officePage('GMP', PC_STEWARD);
    await signIn.office(st, persona('GMP', 'steward'));
    await evidence.step('The steward defines the product\'s numbering rules at SITE-1 (processing and packaging, IN-18)', 'Both rules listed on Batch numbers', async () => {
      await home(st, /^Batch numbers/);
      await defineNumberingRule(st, { ruleCode: `${t.prefix}-PROC-${s.tag}`, kind: 'PROCESSING', format: `L${s.tag}{SEQ:3}`, product: s.product.code });
      await defineNumberingRule(st, { ruleCode: `${t.prefix}-PACK-${s.tag}`, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}', product: s.product.code });
    }, st);
    await evidence.step('The steward lists the product in the GMP plant\'s product list (a room\'s clearance names it)', 'The product is listed on Plant definitions', async () => {
      await definePlantProduct(st, base, s.product);
    }, st);
    const gmpPlant = t.gmpPlant;
    if (gmpPlant) {
      await evidence.step('The steward registers the units the GMP plant lacks for the product (their classes, the units, their qualification)', 'Each unit defined and QUALIFIED in its logbook', async () => {
        await registerPlantUnits(st, base, gmpPlant);
        return { units: gmpPlant.map((u) => u.code).join(', ') };
      }, st);
    }
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
    await evidence.step('The batch issuer plans the batch on SITE-1 line L1 and issues it at the authorised size, 1,00,000 tablets', 'The batch takes its number from the register and is ISSUED', async () => {
      const b = await planAndIssue(ip, base, s.processingOrder ?? '', new RegExp(`MBR ${s.familyCode ?? ''}`), GMP_UNITS_PER_BATCH, issuer);
      s.batchNumber = b.batchNumber;
      s.batchId = b.batchId;
      saveProduct(e2e, key, s);
      return b;
    }, ip);
    await ip.context().close();
    const sp = await officePage('GMP', PC_PLAN);
    await signIn.office(sp, persona('GMP', 'stores'));
    await evidence.step('Stores reserve each lot for the batch', 'Each lot lists the open reservation', async () => {
      await reserveLots(sp, s.batchNumber ?? '', allMats(s).map((m) => [s.lots?.[m.id] ?? '', m.reserve] as const));
    }, sp);
  });

  test(`[DI-30][INV-40][PR-20][INV-27][PR-14][PR-19] ${t.name}, GMP 4: the GMP batch on the kiosks: the skeleton's dispensing and blending and every library step with the GMP plant's units; QA's hold points; the bulk released for packing @office`, async ({ e2e, persona, evidence, browser }) => {
    test.setTimeout(90 * 60_000);
    const s = loadProduct(e2e, key);
    const floor: Floor = {
      e2e, browser, inst: 'GMP', batchId: s.batchId ?? '', batchNumber: s.batchNumber ?? '',
      persona: (k) => persona('GMP', k), containers: (s.gmpContainers ??= {}), save: () => saveProduct(e2e, key, s),
    };
    await evidence.step('GMP floor: the plant cleaned for the batch; dispensing, the product\'s library steps, blending, the bulk for packing; each person by the Tap button of the demo reader', 'Both stages signed off; H-BLEND and H-PACK approved by QA; the run is Execution complete', async () => {
      const ms = mats(s);
      const group = (m: GmpMaterial): OwnMaterial['group'] => (m.active ? 'act' : t.materials.find((x) => x.id === m.id)?.perBatchKg ? 'aid' : 'exc');
      const lots = ms.map((m) => ({ lotCode: s.lots?.[m.id] ?? '', material: { code: m.code, name: m.name, tare: m.tare, gross: m.gross, group: group(m) } }));
      const step = (blocks: readonly ProductBlock[]) => async (page: Page, ctx: StageCtx): Promise<void> => {
        for (const b of blocks) await runLibraryStep(page, ctx, b, GMP_UNITS, stepLotsOf(t, (id) => s.lots?.[id] ?? ''), 1, 'GMP-');
      };
      try {
        const run = await skeletonRun(floor, {
          // TB-07's late addition: the last unit component (a per-batch line is not charged to the blender).
          lots, discharge: t.gmpDischarge, lubricantKg: ms.filter((m) => !t.materials.find((x) => x.id === m.id)?.perBatchKg).at(-1)?.net ?? '0.600',
          afterDispensing: step(t.afterDispensing), afterDischarge: step(t.afterDischarge), bulkNet: t.gmpBulkNet,
        });
        floor.containers['bulk'] = run.bulk ?? '';
        floor.save();
      } finally {
        await closeFloor();
      }
      return { bulk: floor.containers['bulk'] ?? '' };
    });
  });

  test(`[PR-01][PR-03][DI-04] ${t.name}, GMP 5: the packaging master as a copy of the approved cold-form master with the product's own printed foil and carton; the checks pass; change control; the test package in the sandbox inbox @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(20 * 60_000);
    const s = loadProduct(e2e, key);
    const base = e2e.url('GMP');
    const pr = printedOf(s);
    const a = await officePage('GMP', PC_AUTHOR);
    await signIn.office(a, persona('GMP', 'author'));
    await evidence.step('The author starts the packaging master as a copy of the approved cold-form master, naming the product\'s printed foil and carton', 'A DRAFT whose header is the product\'s and whose printed items are its own', async () => {
      s.packFamilyCode = `${t.prefix}-CF-${s.tag}`;
      s.packVersionId = await packagingCopy(a, {
        product: s.product.code, strength: s.product.strength, familyCode: s.packFamilyCode, copyOf: /^RTW-CF-/,
        printed: [{ item: 'FOIL', material: pr.foil.material, artwork: pr.foil.artwork }, { item: 'CARTON', material: pr.carton.material, artwork: pr.carton.artwork }],
      });
      expect(s.packVersionId).toMatch(/^[0-9a-f-]{36}$/);
      saveProduct(e2e, key, s);
      await checksPass(a);
      return { versionId: s.packVersionId };
    }, a);
    const q = await officePage('GMP', PC_QA);
    await signIn.office(q, persona('GMP', 'approver'));
    await evidence.step('Change control; the test package is written', 'A test package with the GMP stamp in the sandbox inbox', async () => {
      await changeControl(q, a, base, s.packVersionId ?? '', { changeRecord: `CC-PK-${s.tag}`, risk: `RA-PK-${s.tag}`, title: `New pack of ${s.product.code}, alu-alu cold-form blister`, tag: `PK-${s.tag}` });
      s.packPackageHash = await sendToSandbox(a, base, s.packVersionId ?? '');
      saveProduct(e2e, key, s);
      return { packageHash: s.packPackageHash };
    }, a);
  });

  test(`[DI-04][DI-05][INV-18][PR-03][IN-38] ${t.name}, GMP 6: the packaging master's sandbox test run on the sandbox's PL-2 kiosk with TEST- printed lots; its result imported as evidence; the four signatures and the IN authorisation @office`, async ({ e2e, officePage, persona, evidence, browser }) => {
    test.setTimeout(60 * 60_000);
    const s = loadProduct(e2e, key);
    const sbx = e2e.url('SANDBOX');
    const pr = printedOf(s);
    const lotCode = (id: string): string => `TEST-L26-${s.tag}-PK-${id.toUpperCase()}`;
    const st = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(st, persona('SANDBOX', 'steward'));
    await evidence.step('Sandbox: TEST- lots of the laminate and of the product\'s printed foil and carton, with their artwork versions', 'TEST- lots RELEASED (sandbox database only)', async () => {
      await registerArtworkTestLots(st, [
        { lotCode: lotCode('acf'), material: 'MAT-ALU-CF', name: 'Cold-form aluminium laminate (forming web)' },
        { lotCode: lotCode('foil'), material: pr.foil.material, name: pr.foil.name, artwork: pr.foil.artwork },
        { lotCode: lotCode('ctn'), material: pr.carton.material, name: pr.carton.name, artwork: pr.carton.artwork },
      ]);
    }, st);
    const iss = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(iss, persona('SANDBOX', 'issuer'));
    await evidence.step('Sandbox: the issuer imports the packaging test package and issues a test packaging order', 'A TEST- batch number', async () => {
      const run = await issueTestBatch(iss, s.packPackageHash ?? '', '1000');
      s.sandboxPackRunId = run.runId;
      s.sandboxPackBatchNumber = run.batchNumber;
      saveProduct(e2e, key, s);
      return run;
    }, iss);
    const floor: Floor = {
      e2e, browser, inst: 'SANDBOX', batchId: s.sandboxPackRunId ?? '', batchNumber: s.sandboxPackBatchNumber ?? '',
      persona: (k) => persona('SANDBOX', k), containers: (s.sandboxPackContainers ??= {}), save: () => saveProduct(e2e, key, s),
    };
    await evidence.step('Sandbox floor: the cold-form packaging on TEST-KIOSK-PACK-2', 'Execution complete; every screen with the TEST, NOT GMP band', async () => {
      try {
        await packagingRun(floor, { formingLot: lotCode('acf'), foil: { material: pr.foil.material, lot: lotCode('foil'), artwork: pr.foil.artwork }, carton: { material: pr.carton.material, lot: lotCode('ctn'), artwork: pr.carton.artwork } });
      } finally {
        await closeFloor();
      }
    });
    const iss2 = await officePage('SANDBOX', 'TEST-PC-01');
    await signIn.office(iss2, persona('SANDBOX', 'issuer'));
    await evidence.step('Sandbox: the issuer exports the test-run result for GMP', 'It passed; the result is in to-gmp with the sandbox stamp', async () => ({ resultFile: await exportTestResult(iss2, sbx, s.sandboxPackRunId ?? '') }), iss2);
    const base = e2e.url('GMP');
    const a = await officePage('GMP', PC_AUTHOR);
    await signIn.office(a, persona('GMP', 'author'));
    await evidence.step('The author starts the verification and imports the sandbox run\'s result', 'The evidence is complete for this content', async () => {
      await importEvidence(a, base, s.packVersionId ?? '', s.sandboxPackBatchNumber ?? '');
    }, a);
    const c = await officePage('GMP', PC_AUTHOR);
    await signIn.office(c, persona('GMP', 'checker'));
    const r = await officePage('GMP', PC_QA);
    await signIn.office(r, persona('GMP', 'regulatory'));
    const q = await officePage('GMP', PC_QA);
    await signIn.office(q, persona('GMP', 'approver'));
    await evidence.step('The four signatures and the IN authorisation of the packaging master', 'APPROVED; the IN authorisation ACTIVE', async () => {
      await fourSignatures({ author: a, checker: c, regulatory: r, qa: q }, { author: persona('GMP', 'author'), checker: persona('GMP', 'checker'), regulatory: persona('GMP', 'regulatory'), qa: persona('GMP', 'approver') }, base, s.packVersionId ?? '');
      await authoriseIn(q, r, base, s.packVersionId ?? '', { site: 'SITE-1', line: 'L1', sizeId: 'PK-1K' }, persona('GMP', 'approver'), persona('GMP', 'regulatory'), `IN: registration of the pack on file (${s.tag})`);
    }, q);
  });

  test(`[IN-38][PR-37][PR-33][PR-34][PR-36][INV-27][DI-30] ${t.name}, GMP 7: the packaging order sent, planned from the batch released for packing (H-PACK) and issued; its bulk issued; the laminate reserved; the order run on KIOSK-PACK-2 with the product's printed lots @office`, async ({ e2e, officePage, persona, evidence, browser }) => {
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
    const sp = await officePage('GMP', PC_PLAN);
    await signIn.office(sp, persona('GMP', 'stores'));
    await evidence.step('Stores reserve the cold-form laminate for the order', 'The lot lists the open reservation', async () => {
      await reserveLots(sp, s.orderNumber ?? '', [['RTW-ACF-001', '0.500']]);
    }, sp);
    const floor: Floor = {
      e2e, browser, inst: 'GMP', batchId: s.orderId ?? '', batchNumber: s.orderNumber ?? '',
      persona: (k) => persona('GMP', k), containers: (s.packContainers ??= {}), save: () => saveProduct(e2e, key, s),
    };
    await evidence.step('GMP floor: the bulk issued to the order; the cold-form packaging order on KIOSK-PACK-2', 'The packaging stage is signed off and the order is complete', async () => {
      try {
        await packagingRun(floor, {
          formingLot: 'RTW-ACF-001', bulk: s.gmpContainers?.['bulk'] ?? '',
          foil: { material: pr.foil.material, lot: s.lots?.['foil'] ?? '', artwork: pr.foil.artwork }, carton: { material: pr.carton.material, lot: s.lots?.['carton'] ?? '', artwork: pr.carton.artwork },
        });
      } finally {
        await closeFloor();
      }
    });
  });

  test(`[IN-05][PR-45][DI-35][IN-33] ${t.name}, GMP 8: the finished lot posted in quarantine; QC records its results against the product's specification and pulls the reserve sample; the head of QC approves them @office`, async ({ e2e, officePage, persona, evidence }) => {
    test.setTimeout(15 * 60_000);
    const s = loadProduct(e2e, key);
    const base = e2e.url('GMP');
    const sp = await officePage('GMP', PC_PLAN);
    await signIn.office(sp, persona('GMP', 'stores'));
    await evidence.step('Stores post the finished packs of the order as its lot, in quarantine', 'The lot of the order is listed', async () => {
      s.lotId = await postFinishedLot(sp, base, s.orderId ?? '', s.orderNumber ?? '', '10');
      s.lotCode = s.orderNumber ?? '';
      saveProduct(e2e, key, s);
      return { lot: s.lotCode };
    }, sp);
    const qc = await officePage('GMP', PC_QC);
    await signIn.office(qc, persona('GMP', 'qcAnalyst'));
    await evidence.step('QC records the assay and dissolution results of the lot and pulls its reserve samples', 'Both results PASS against the product\'s specification; the reserve sample is listed', async () => {
      await openLot(qc, s.lotCode ?? '');
      await recordResults(qc, [['ASSAY', '99.6'], ['DISSOLUTION', '88']]);
      await pullReserveSample(qc, s.lotCode ?? '');
    }, qc);
    const hq = await officePage('GMP', PC_QC);
    await signIn.office(hq, persona('GMP', 'qcApprover'));
    await evidence.step('The head of QC approves both results', 'Both results APPROVED by a second person', async () => {
      await openLot(hq, s.lotCode ?? '');
      await approveResults(hq, ['ASSAY', 'DISSOLUTION'], persona('GMP', 'qcApprover'));
    }, hq);
  });

  test(`[INV-05][IN-05][DI-25][INV-48] ${t.name}, GMP 9: both records reviewed and the lot released by the authorised person on a checklist with no red item @office`, async ({ e2e, officePage, persona, evidence }) => {
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
    await evidence.step('The authorised person releases the lot: ready, no red item on its checklist, the manufacturer release signed', 'The lot is RELEASED', async () => {
      await releaseFinishedLot(cockpit, s.lotCode ?? '', persona('GMP', 'qcuAuthoriser'));
      return { lot: s.lotCode ?? '', state: 'RELEASED' };
    }, cockpit);
  });
}
