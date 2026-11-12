/**
 * Namespace `india` (Phase 4 slice 6a, GMP): manufacturing and loan licences (IN-30, D-6-1), export permissions (D-6-2),
 * the check a planner sees before issue, the batch-number allocation register with the use of every number (IN-18), the
 * India-domestic label particulars and the Schedule H2 payload stub bound to the record (IN-31, D-P4-14), the stability
 * basis of a shelf life (PR-43) and hazard classes with the areas dedicated to them (IN-27). Every rule is the database's
 * (site services 0885, 0886; recipe-core 0890 to 0895).
 *
 * Signed acts are the signable action INDIA_ACT: LICENCE_APPROVE (LICENCE_APPROVED on manufacturing_licence <id>) and
 * EXPORT_PERMISSION_APPROVE (EXPORT_PERMISSION_APPROVED on export_permission <id>), by QA, never the recorder.
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const ProductCode = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/);
const Strength = z.string().trim().min(1).max(64);
const Text = (max: number) => z.string().trim().min(1).max(max);
/** Free text printed on a label or carried in the H2 payload: no ; or = (the payload's separators). */
const LabelText = (max: number) => z.string().trim().min(1).max(max).regex(/^[^;=]*$/, 'no ; or =');
const IsoInstant = z.iso.datetime({ offset: true });
const Destination = z.string().regex(/^[A-Z]{2}$/).refine((d) => d !== 'IN', 'IN needs no export permission');

export const LicenceKind = z.enum(['MANUFACTURING', 'LOAN']);
export type LicenceKind = z.infer<typeof LicenceKind>;
export const LicenceForm = z.enum(['25', '28', '25A', '28A']);
export type LicenceForm = z.infer<typeof LicenceForm>;
export const LicenceState = z.enum(['DRAFT', 'APPROVED', 'SUSPENDED']);
export type LicenceState = z.infer<typeof LicenceState>;
export const HazardClass = z.enum(['NONE', 'SEX_HORMONE', 'STEROID', 'CYTOTOXIC']);
export type HazardClass = z.infer<typeof HazardClass>;
/** The class a room or line is dedicated to: a hazard class, or BETA_LACTAM (recipe-core 1655, PR-27; slice 7n). */
export const DedicationClass = z.enum(['SEX_HORMONE', 'STEROID', 'CYTOTOXIC', 'BETA_LACTAM']);
export type DedicationClass = z.infer<typeof DedicationClass>;

export const EndorsedProduct = z.strictObject({ productCode: ProductCode, strength: Strength });
export type EndorsedProduct = z.infer<typeof EndorsedProduct>;

const Suspension = z.strictObject({ reason: z.string(), suspendedBy: PersonRef, suspendedAt: Instant });

export const LicenceView = z.strictObject({
  licenceId: Uuid,
  siteCode: z.string(),
  licenceKind: LicenceKind,
  form: LicenceForm,
  licenceNumber: z.string(),
  holderName: z.string(),
  holderAddress: z.string(),
  /** API plan A3 (site-services 1735): the holder's telephone, when recorded (the CoA names it; ICH Q7 11.43). */
  holderTelephone: z.string().nullable(),
  hostLicenceId: Uuid.nullable(),
  hostLicenceNumber: z.string().nullable(),
  technicalAgreement: z.string().nullable(),
  validFrom: Instant,
  /** Null: no end date (kept in force by its retention fee). */
  validUntil: Instant.nullable(),
  products: z.array(EndorsedProduct),
  state: LicenceState,
  /** Approved, not suspended and within its validity now. */
  current: z.boolean(),
  recordedBy: PersonRef,
  recordedAt: Instant,
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
  suspension: Suspension.nullable(),
});
export type LicenceView = z.infer<typeof LicenceView>;

export const ExportPermissionView = z.strictObject({
  permissionId: Uuid,
  siteCode: z.string(),
  productCode: z.string(),
  strength: z.string(),
  destination: z.string(),
  permissionNumber: z.string(),
  issuingAuthority: z.string(),
  validFrom: Instant,
  validUntil: Instant,
  state: LicenceState,
  current: z.boolean(),
  recordedBy: PersonRef,
  recordedAt: Instant,
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
  suspension: Suspension.nullable(),
});
export type ExportPermissionView = z.infer<typeof ExportPermissionView>;

/** What the issue gate says now for a product at the session's site (null: nothing stands). */
export const IndiaCheckView = z.strictObject({
  siteCode: z.string(),
  productCode: z.string(),
  strength: z.string(),
  licenceProblem: z.string().nullable(),
  licenceNumber: z.string().nullable(),
  loanLicenceNumber: z.string().nullable(),
  exportProblems: z.array(z.strictObject({ destination: z.string(), problem: z.string().nullable() })),
});
export type IndiaCheckView = z.infer<typeof IndiaCheckView>;

export const AllocationUse = z.enum(['ISSUED', 'PLANNED', 'CANCELLED', 'VOIDED', 'UNUSED']);
export type AllocationUse = z.infer<typeof AllocationUse>;
export const AllocationEntryView = z.strictObject({
  allocationId: Uuid,
  batchNumber: z.string(),
  siteCode: z.string(),
  allocatedAt: z.string(),
  /** The allocation date in the site's zone (YYYY-MM-DD). */
  allocationDate: z.string(),
  productCode: z.string(),
  productName: z.string(),
  strength: z.string().nullable(),
  batchSize: z.string(),
  batchSizeUnit: z.string(),
  edition: z.string(),
  kind: z.enum(['PROCESSING', 'PACKAGING']),
  parentBatchNumber: z.string().nullable(),
  source: z.string(),
  use: AllocationUse,
  voidReason: z.string().nullable(),
  batchId: Uuid.nullable(),
  issuedAt: z.string().nullable(),
  licenceNumber: z.string().nullable(),
  loanLicenceNumber: z.string().nullable(),
  /** The batch is a process simulation (media fill), issued under no licence (recipe-core 1896): why licenceNumber is null. */
  processSimulation: z.boolean(),
});
export type AllocationEntryView = z.infer<typeof AllocationEntryView>;

const Party = z.strictObject({ name: z.string(), address: z.string(), licenceNumber: z.string(), form: z.string() });

/** India-domestic label particulars of a batch and its H2 payload (or why they cannot be given). */
export const IndiaLabelView = z.strictObject({
  batchId: Uuid,
  particulars: z
    .strictObject({
      batchNumber: z.string(),
      productCode: z.string(),
      drugName: z.string(),
      strength: z.string(),
      dosageForm: z.string(),
      manufactureDate: z.string(),
      manufactureLabel: z.string(),
      expiryDate: z.string(),
      expiryLabel: z.string(),
      shelfLifeMonths: z.number().int().positive(),
      tentativeShelfLife: z.boolean(),
      manufacturer: Party,
      loanLicensee: Party.nullable(),
    })
    .nullable(),
  problem: z.string().nullable(),
  h2: z.strictObject({ layoutVersion: z.string(), layoutStatus: z.string(), payload: z.string().nullable(), issuedCount: z.number().int().nonnegative() }),
});
export type IndiaLabelView = z.infer<typeof IndiaLabelView>;

export const H2IssueView = z.strictObject({ issueId: Uuid, batchId: Uuid, payload: z.string(), payloadHash: z.string(), layoutVersion: z.string() });
export type H2IssueView = z.infer<typeof H2IssueView>;

export const ShelfLifeBasisView = z.strictObject({
  basisId: Uuid,
  productCode: z.string(),
  strength: z.string(),
  shelfLifeMonths: z.number().int().positive(),
  stabilityReference: z.string(),
  tentative: z.boolean(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type ShelfLifeBasisView = z.infer<typeof ShelfLifeBasisView>;

/**
 * A hazard record's approval (recipe-core 0912, IN-27): RECORDED until a second QA person approves it (INDIA_ACT
 * HAZARD_APPROVE or DEDICATION_APPROVE), SUPERSEDED once a later record of the same product (or area and class) exists.
 * Only an approved record lifts a restriction; a recorded upgrade or withdrawal restricts at once.
 */
export const HazardRecordState = z.enum(['RECORDED', 'APPROVED', 'SUPERSEDED']);
export const HazardView = z.strictObject({
  products: z.array(z.strictObject({ recordId: Uuid, productCode: z.string(), hazardClass: HazardClass, riskAssessmentRef: z.string(), recordedAt: Instant, state: HazardRecordState })),
  areas: z.array(z.strictObject({ recordId: Uuid, areaCode: z.string(), hazardClass: DedicationClass, dedicated: z.boolean(), breathingAir: z.enum(['NOT_USED', 'BACKED_UP']), justification: z.string(), recordedAt: Instant, state: HazardRecordState })),
});
export type HazardView = z.infer<typeof HazardView>;

export const india = {
  licences: defineRoute({
    id: 'india.licences',
    method: 'GET',
    path: '/api/india/licences',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Manufacturing and loan licences of the site, newest first, with their endorsed products, state and validity (IN-30)',
    response: z.strictObject({ licences: z.array(LicenceView) }),
  }),
  recordLicence: defineRoute({
    id: 'india.recordLicence',
    method: 'POST',
    path: '/api/india/licences',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record a manufacturing licence (Form 25 or 28) or a loan licence (Form 25A or 28A) as granted (regulatory affairs); it counts once QA approves it (INDIA_ACT)',
    body: z.strictObject({
      licenceKind: LicenceKind,
      form: LicenceForm,
      licenceNumber: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._ -]{0,63}$/),
      holderName: LabelText(200),
      holderAddress: LabelText(400),
      holderTelephone: LabelText(200).optional(),
      hostLicenceId: Uuid.optional(),
      technicalAgreement: Text(200).optional(),
      validFrom: IsoInstant,
      validUntil: IsoInstant.optional(),
      products: z.array(EndorsedProduct).min(1).max(200),
    }),
    response: LicenceView,
  }),
  suspendLicence: defineRoute({
    id: 'india.suspendLicence',
    method: 'POST',
    path: '/api/india/licences/:licenceId/suspension',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record that the authority suspended or cancelled an approved licence (QA); the next issue is refused, batches already issued are not affected (D-6-1)',
    params: z.strictObject({ licenceId: Uuid }),
    body: z.strictObject({ reason: Text(2000) }),
    response: LicenceView,
  }),
  recordLicenceTelephone: defineRoute({
    id: 'india.recordLicenceTelephone',
    method: 'POST',
    path: '/api/india/licences/:licenceId/telephone',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record a new telephone for the holder of a licence of this site (regulatory affairs); it supersedes the earlier one on the CoA, which stays in the history (ICH Q7 11.43)',
    params: z.strictObject({ licenceId: Uuid }),
    body: z.strictObject({ telephone: LabelText(200) }),
    response: LicenceView,
  }),
  exportPermissions: defineRoute({
    id: 'india.exportPermissions',
    method: 'GET',
    path: '/api/india/export-permissions',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Export permissions of the site per product, strength and destination with their validity (D-6-2)',
    response: z.strictObject({ permissions: z.array(ExportPermissionView) }),
  }),
  recordExportPermission: defineRoute({
    id: 'india.recordExportPermission',
    method: 'POST',
    path: '/api/india/export-permissions',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record an export permission of one product and strength for one destination (regulatory affairs); it counts once QA approves it (INDIA_ACT)',
    body: z.strictObject({
      productCode: ProductCode,
      strength: Strength,
      destination: Destination,
      permissionNumber: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._ -]{0,63}$/),
      issuingAuthority: Text(200),
      validFrom: IsoInstant,
      validUntil: IsoInstant,
    }),
    response: ExportPermissionView,
  }),
  suspendExportPermission: defineRoute({
    id: 'india.suspendExportPermission',
    method: 'POST',
    path: '/api/india/export-permissions/:permissionId/suspension',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record that an approved export permission was suspended or withdrawn (QA)',
    params: z.strictObject({ permissionId: Uuid }),
    body: z.strictObject({ reason: Text(2000) }),
    response: ExportPermissionView,
  }),
  check: defineRoute({
    id: 'india.check',
    method: 'GET',
    path: '/api/india/check',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'What the issue gate says now for a product and strength at the session\'s site: its licence and the export permission of each destination named',
    query: z.strictObject({ productCode: ProductCode, strength: Strength, destinations: z.string().regex(/^([A-Z]{2})(,[A-Z]{2})*$/).optional() }),
    response: IndiaCheckView,
  }),
  allocationRegister: defineRoute({
    id: 'india.allocationRegister',
    method: 'GET',
    path: '/api/india/allocation-register',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The batch-number allocation register of the site with the use of every number, as exported for an inspector (IN-18)',
    query: z.strictObject({ from: IsoInstant.optional(), to: IsoInstant.optional() }),
    response: z.strictObject({ siteCode: z.string(), entries: z.array(AllocationEntryView) }),
  }),
  label: defineRoute({
    id: 'india.label',
    method: 'GET',
    path: '/api/india/batches/:batchId/label',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The India-domestic label particulars of a GMP batch and its Schedule H2 payload, computed from the record (IN-31, PR-43, D-P4-14)',
    params: z.strictObject({ batchId: Uuid }),
    response: IndiaLabelView,
  }),
  issueH2: defineRoute({
    id: 'india.issueH2',
    method: 'POST',
    path: '/api/india/batches/:batchId/h2-payload',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Release the H2 payload of a batch for printing (STEP.EXECUTE on the batch); it is computed by the database, never typed',
    params: z.strictObject({ batchId: Uuid }),
    body: withAttribution({}),
    response: H2IssueView,
  }),
  verifyH2: defineRoute({
    id: 'india.verifyH2',
    method: 'POST',
    path: '/api/india/batches/:batchId/h2-payload/verification',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Whether a scanned H2 payload is the one issued for the batch and computed from its record now (IN-31 payload binding)',
    params: z.strictObject({ batchId: Uuid }),
    body: z.strictObject({ payload: z.string().max(2000) }),
    response: z.strictObject({ batchId: Uuid, problem: z.string().nullable() }),
  }),
  shelfLifeBases: defineRoute({
    id: 'india.shelfLifeBases',
    method: 'GET',
    path: '/api/india/shelf-life-bases',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The stability basis recorded for each shelf life (PR-43); a changed shelf life takes effect only on one',
    response: z.strictObject({ bases: z.array(ShelfLifeBasisView) }),
  }),
  recordShelfLifeBasis: defineRoute({
    id: 'india.recordShelfLifeBasis',
    method: 'POST',
    path: '/api/india/shelf-life-bases',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record the stability basis of a shelf life (head of QC, QA; PR-43)',
    body: z.strictObject({ productCode: ProductCode, strength: Strength, shelfLifeMonths: z.number().int().min(1).max(120), stabilityReference: Text(200), tentative: z.boolean() }),
    response: ShelfLifeBasisView,
  }),
  hazards: defineRoute({
    id: 'india.hazards',
    method: 'GET',
    path: '/api/india/hazards',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Hazard classes of products and the rooms and lines dedicated to them, latest record first (IN-27)',
    response: HazardView,
  }),
  recordHazard: defineRoute({
    id: 'india.recordHazard',
    method: 'POST',
    path: '/api/india/hazards',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record a product\'s hazard class from its risk assessment, or a room or line dedicated to a class (QA; IN-27)',
    body: z.strictObject({
      product: z.strictObject({ productCode: ProductCode, hazardClass: HazardClass, riskAssessmentRef: Text(200) }).optional(),
      area: z
        .strictObject({ areaCode: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/), hazardClass: DedicationClass, dedicated: z.boolean(), breathingAir: z.enum(['NOT_USED', 'BACKED_UP']), justification: Text(2000) })
        .optional(),
    }),
    response: HazardView,
  }),
} as const;
