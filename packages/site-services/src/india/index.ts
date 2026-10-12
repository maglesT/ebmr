/**
 * India specifics at the site (Phase 4 slice 6a; site services 0885, 0886): manufacturing and loan licences (IN-30,
 * D-6-1), export permissions (D-6-2) and the stability basis of a shelf life (PR-43). Every rule is the database's; these
 * are thin callers of its definers, run inside the person's own command (withCommand).
 */
import type { Queryable } from '../batch-numbers/register.ts';

/** Signed aggregates and meanings fixed for slice 6a (plan "Slice 6 build notes"). */
export const MANUFACTURING_LICENCE_AGGREGATE = 'manufacturing_licence';
export const EXPORT_PERMISSION_AGGREGATE = 'export_permission';
export const LICENCE_APPROVED = 'LICENCE_APPROVED';
export const EXPORT_PERMISSION_APPROVED = 'EXPORT_PERMISSION_APPROVED';

export type LicenceKind = 'MANUFACTURING' | 'LOAN';
export type LicenceForm = '25' | '28' | '25A' | '28A';
export type LicenceState = 'DRAFT' | 'APPROVED' | 'SUSPENDED';

export interface EndorsedProduct {
  productCode: string;
  strength: string;
}

export interface NewManufacturingLicence {
  licenceKind: LicenceKind;
  form: LicenceForm;
  licenceNumber: string;
  holderName: string;
  holderAddress: string;
  /** LOAN only: the host's approved manufacturing licence at the same site. */
  hostLicenceId?: string;
  /** LOAN only: the technical agreement with the host. */
  technicalAgreement?: string;
  /** ISO 8601 instants with offset; no end for a licence kept in force by its retention fee. */
  validFrom: string;
  validUntil?: string;
  products: EndorsedProduct[];
}

export interface NewExportPermission {
  productCode: string;
  strength: string;
  /** A market code (US, EU) or a country code other than IN (D-6a-1). */
  destination: string;
  permissionNumber: string;
  issuingAuthority: string;
  validFrom: string;
  validUntil: string;
}

export interface NewShelfLifeBasis {
  productCode: string;
  strength: string;
  shelfLifeMonths: number;
  stabilityReference: string;
  /** The shelf life rests on accelerated data. */
  tentative: boolean;
}

/** The licence a batch is made under (site.licence_basis). */
export interface LicenceBasis {
  licenceId: string;
  licenceNumber: string;
  form: LicenceForm;
  holderName: string;
  holderAddress: string;
  loanLicenceId?: string;
  loanLicenceNumber?: string;
  loanForm?: LicenceForm;
  loanHolderName?: string;
  loanHolderAddress?: string;
  technicalAgreement?: string;
}

async function value<T>(client: Queryable, text: string, values: unknown[]): Promise<T> {
  const { rows } = await client.query(text, values);
  return (rows[0] as { r: T } | undefined)?.r as T;
}

export function recordManufacturingLicence(client: Queryable, l: NewManufacturingLicence): Promise<string> {
  return value(client, 'select site.record_manufacturing_licence($1::jsonb) as r', [JSON.stringify(l)]);
}

export async function approveManufacturingLicence(client: Queryable, licenceId: string, signatureId: string): Promise<void> {
  await client.query('select site.approve_manufacturing_licence($1, $2)', [licenceId, signatureId]);
}

export async function suspendManufacturingLicence(client: Queryable, licenceId: string, reason: string): Promise<void> {
  await client.query('select site.suspend_manufacturing_licence($1, $2)', [licenceId, reason]);
}

export function recordExportPermission(client: Queryable, p: NewExportPermission): Promise<string> {
  return value(client, 'select site.record_export_permission($1::jsonb) as r', [JSON.stringify(p)]);
}

export async function approveExportPermission(client: Queryable, permissionId: string, signatureId: string): Promise<void> {
  await client.query('select site.approve_export_permission($1, $2)', [permissionId, signatureId]);
}

export async function suspendExportPermission(client: Queryable, permissionId: string, reason: string): Promise<void> {
  await client.query('select site.suspend_export_permission($1, $2)', [permissionId, reason]);
}

export function recordShelfLifeBasis(client: Queryable, b: NewShelfLifeBasis): Promise<string> {
  return value(client, 'select site.record_shelf_life_basis($1::jsonb) as r', [JSON.stringify(b)]);
}

/** Why a batch of the product may not be made at the site now (NULL when a licence covers it; D-6-1). */
export function licenceProblem(client: Queryable, site: string, productCode: string, strength: string): Promise<string | null> {
  return value(client, 'select site.licence_problem($1, $2, $3, clock_timestamp()) as r', [site, productCode, strength]);
}

export function licenceBasis(client: Queryable, site: string, productCode: string, strength: string): Promise<LicenceBasis | null> {
  return value(client, 'select site.licence_basis($1, $2, $3, clock_timestamp()) as r', [site, productCode, strength]);
}

export function exportPermissionProblem(client: Queryable, site: string, productCode: string, strength: string, destination: string): Promise<string | null> {
  return value(client, 'select site.export_permission_problem($1, $2, $3, $4, clock_timestamp()) as r', [site, productCode, strength, destination]);
}
