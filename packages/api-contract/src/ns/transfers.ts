/**
 * Namespaces `transfers` and `federation` (Phase 6 slice 6i-0, GMP; outline L-41; DI-31, DI-39, PR-57; kernel 1220, site
 * services 0980, 0981, recipe-core 1090): lot-transfer packages between site installations and the site-to-site
 * genealogy endpoint.
 *
 *  - This installation and its peers: the identity (code, site, edition, key fingerprint) and every other installation
 *    proposed by the system administrator, trusted only once QA approved its key (signed act PEER_INSTALLATION_APPROVE).
 *  - Outbound: `prepare` builds the package in the database from its own records (status and release decision, CoA,
 *    hold limit, rule resolutions, genealogy excerpt) and the server seals it with the installation's key in the same
 *    command; `packageFile` hands the payload and seal over for the file or HTTPS exchange (D-P6i-1: no hub).
 *  - Inbound: `import` takes a payload and seal as received; the database verifies the seal and the destination and
 *    answers RECEIVED (a local lot in QUARANTINE) or REFUSED with the reason and an alarm (DI-31). Local QA decides the
 *    receipt (signed act TRANSFER_RECEIPT_DECIDE); the lot is released and used only after an acceptance.
 *  - Alarms of both paths, acknowledged with a note (ALARM.ACKNOWLEDGE).
 *  - `federation.genealogy` is the read-only endpoint other installations call (`auth: NONE`): the request is sealed by
 *    the caller's installation key, which is its authentication; the answer is sealed by this installation's key and
 *    carries its as-of point. A refusal is 403 with the database's reason.
 *
 * Quantities are decimal text; instants are Instant (epoch microseconds and site text).
 */
import { z } from 'zod';
import { DecimalString, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';
import { GenealogyNodeView } from './genealogy.ts';

export const InstallationCode = z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, 'an installation code such as PUNE-TAB-GMP');
const Seal = z.string().regex(/^[A-Za-z0-9+/]{85}[AQgw]==$/, 'the standard base64 of a 64-byte Ed25519 seal');
const PublicKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'the standard base64 of a 32-byte Ed25519 public key');
const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);

export const InstallationIdentityView = z.strictObject({
  installationCode: InstallationCode,
  siteCode: z.string().min(1),
  edition: z.enum(['TABLETS', 'INJECTABLES']),
  keyFingerprint: Fingerprint,
  keyVersion: z.number().int().positive(),
  /** Whether this server holds the private key of the current version (EBMR_INSTALLATION_KEY_FILE). */
  serverHoldsKey: z.boolean(),
});
export type InstallationIdentityView = z.infer<typeof InstallationIdentityView>;

export const PeerInstallationState = z.enum(['PROPOSED', 'APPROVED', 'REVOKED']);
export const PeerInstallationView = z.strictObject({
  peerId: Uuid,
  installationCode: InstallationCode,
  siteCode: z.string().min(1),
  edition: z.enum(['TABLETS', 'INJECTABLES']),
  baseUrl: z.string().min(1),
  keyFingerprint: Fingerprint,
  state: PeerInstallationState,
  proposedBy: PersonRef,
  proposedAt: Instant,
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
});
export type PeerInstallationView = z.infer<typeof PeerInstallationView>;

export const TransferPackageView = z.strictObject({
  packageId: Uuid,
  packageNo: z.string().min(1),
  lotId: Uuid,
  lotCode: z.string().min(1),
  materialCode: z.string().min(1),
  materialName: z.string().min(1),
  destination: InstallationCode,
  quantity: DecimalString,
  unit: z.string().min(1),
  /** The lot status the package carries (DI-39). */
  status: z.string().min(1),
  holdUntil: Instant,
  holdBasis: z.enum(['EXPIRY', 'RETEST', 'CARRIED', 'STATED']),
  ruleCount: z.number().int().nonnegative(),
  sealed: z.boolean(),
  preparedBy: PersonRef,
  preparedAt: Instant,
});
export type TransferPackageView = z.infer<typeof TransferPackageView>;

export const TransferPackageFileView = z.strictObject({
  packageId: Uuid,
  packageNo: z.string().min(1),
  /** A file name for the exchange, e.g. XFR-INT-2601-T1.json. */
  fileName: z.string().min(1),
  payload: z.string().min(1),
  seal: Seal,
});
export type TransferPackageFileView = z.infer<typeof TransferPackageFileView>;

export const TransferReceiptState = z.enum(['RECEIVED', 'ACCEPTED', 'REFUSED']);
export const TransferRuleView = z.strictObject({
  key: z.string().min(1),
  method: z.string().min(1),
  /** Values as the rule tables hold them (JSON text: decimals as strings, sets as arrays). */
  carried: z.string(),
  local: z.string().nullable(),
  resolved: z.string().nullable(),
  winner: z.enum(['EQUAL', 'CARRIED', 'LOCAL', 'MERGED', 'CARRIED_ONLY', 'NOT_COMPARABLE']),
});
export const CoaLineView = z.strictObject({
  testCode: z.string().min(1),
  methodReference: z.string().min(1),
  result: DecimalString,
  unit: z.string().min(1),
  lowerLimit: DecimalString.nullable(),
  upperLimit: DecimalString.nullable(),
  verdict: z.enum(['PASS', 'FAIL']),
});
export const TransferReceiptSummaryView = z.strictObject({
  receiptId: Uuid,
  packageId: Uuid,
  packageNo: z.string().min(1),
  origin: InstallationCode,
  originLotCode: z.string().min(1),
  /** The lot status at the origin, carried in the package (DI-39). */
  originState: z.string().min(1),
  lotId: Uuid,
  lotCode: z.string().min(1),
  /** The local lot's state (QUARANTINE until released here after the acceptance). */
  lotState: z.string().min(1),
  materialCode: z.string().min(1),
  materialName: z.string().min(1),
  quantity: DecimalString,
  unit: z.string().min(1),
  holdUntil: Instant,
  /** Whole seconds of hold time left now (0 once passed); the clock kept running since the origin (D-P6i-0-5). */
  holdRemainingSeconds: z.string().regex(/^(0|[1-9][0-9]*)$/),
  state: TransferReceiptState,
  receivedBy: PersonRef,
  receivedAt: Instant,
  decision: z.strictObject({ decision: z.enum(['ACCEPTED', 'REFUSED']), reason: z.string().nullable(), by: PersonRef, at: Instant, signatureId: Uuid }).nullable(),
});
export type TransferReceiptSummaryView = z.infer<typeof TransferReceiptSummaryView>;
export const TransferReceiptView = TransferReceiptSummaryView.extend({
  /** The origin's release decision (event, route, when), quoted from the package. */
  originDecision: z.strictObject({ event: z.string().min(1), route: z.string().nullable(), decidedAt: Instant.nullable() }).nullable(),
  coa: z.array(CoaLineView),
  markets: z.array(z.string()),
  rules: z.array(TransferRuleView),
  /** The origin's backward genealogy excerpt of the lot, as of its own instant. */
  genealogyAsOf: Instant.nullable(),
  genealogy: z.array(GenealogyNodeView),
  payloadSha256: Fingerprint,
});
export type TransferReceiptView = z.infer<typeof TransferReceiptView>;

export const TransferImportView = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('RECEIVED'), receipt: TransferReceiptView }),
  z.strictObject({
    outcome: z.literal('REFUSED'),
    kind: z.enum(['MALFORMED', 'UNKNOWN_PEER', 'TAMPERED', 'WRONG_DESTINATION', 'DUPLICATE']),
    reason: z.string().min(1),
    alarmId: Uuid,
  }),
]);
export type TransferImportView = z.infer<typeof TransferImportView>;

export const InstallationAlarmView = z.strictObject({
  alarmId: Uuid,
  kind: z.enum(['MALFORMED', 'UNKNOWN_PEER', 'TAMPERED', 'WRONG_DESTINATION', 'DUPLICATE', 'REPLAYED', 'UNREACHABLE', 'WRONG_ANSWER']),
  severity: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
  path: z.enum(['TRANSFER_IMPORT', 'FEDERATION_ANSWER', 'FEDERATION_QUERY']),
  peer: z.string().nullable(),
  reason: z.string().nullable(),
  raisedAt: Instant,
  acknowledgement: z.strictObject({ by: PersonRef, at: Instant, note: z.string().min(1) }).nullable(),
});
export type InstallationAlarmView = z.infer<typeof InstallationAlarmView>;

const receiptParams = z.strictObject({ receiptId: Uuid });
const packageParams = z.strictObject({ packageId: Uuid });

export const transfers = {
  peers: defineRoute({
    id: 'transfers.peers',
    method: 'GET',
    path: '/api/transfers/peers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'This installation and the other site installations it trusts or was asked to trust (L-41)',
    response: z.strictObject({ installation: InstallationIdentityView.nullable(), peers: z.array(PeerInstallationView) }),
  }),
  proposePeer: defineRoute({
    id: 'transfers.proposePeer',
    method: 'POST',
    path: '/api/transfers/peers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'The system administrator proposes another installation with its URL and public key; QA approves its key before it is trusted (DI-31)',
    body: z.strictObject({ installationCode: InstallationCode, siteCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/), edition: z.enum(['TABLETS', 'INJECTABLES']),
                           baseUrl: z.string().regex(/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[!-~]*)?$/).max(200), publicKey: PublicKey }),
    response: PeerInstallationView,
  }),
  packages: defineRoute({
    id: 'transfers.packages',
    method: 'GET',
    path: '/api/transfers/packages',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The lot-transfer packages this site sealed, newest first',
    response: z.strictObject({ packages: z.array(TransferPackageView) }),
  }),
  prepare: defineRoute({
    id: 'transfers.prepare',
    method: 'POST',
    path: '/api/transfers/packages',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'The stores build a lot-transfer package of a released intermediate for a trusted installation; the server seals it with the installation key (L-41)',
    body: withAttribution({
      lotId: Uuid,
      destination: InstallationCode,
      quantity: DecimalString,
      markets: z.array(z.enum(['IN', 'US', 'EU'])).max(3).optional(),
      /** An earlier hold limit than the lot's own (UTC ISO instant). */
      holdUntil: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/).optional(),
    }),
    response: TransferPackageFileView,
  }),
  packageFile: defineRoute({
    id: 'transfers.packageFile',
    method: 'GET',
    path: '/api/transfers/packages/:packageId/file',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The sealed package as exchanged: the payload text and its seal',
    params: packageParams,
    response: TransferPackageFileView,
  }),
  receipts: defineRoute({
    id: 'transfers.receipts',
    method: 'GET',
    path: '/api/transfers/receipts',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The packages this site received, newest first, with the local lot, the hold time left and local QA\'s decision',
    response: z.strictObject({ receipts: z.array(TransferReceiptSummaryView) }),
  }),
  receipt: defineRoute({
    id: 'transfers.receipt',
    method: 'GET',
    path: '/api/transfers/receipts/:receiptId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One received package: the origin\'s status, decision and CoA, the rule resolutions re-resolved here, the genealogy excerpt and the hold time left',
    params: receiptParams,
    response: TransferReceiptView,
  }),
  import: defineRoute({
    id: 'transfers.import',
    method: 'POST',
    path: '/api/transfers/receipts',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'The stores take in a received package (payload and seal as received): a local lot in QUARANTINE, or a refusal with an alarm (DI-31)',
    body: withAttribution({ payload: z.string().min(1).max(2_000_000), seal: z.string().min(1).max(200) }),
    response: TransferImportView,
  }),
  alarms: defineRoute({
    id: 'transfers.alarms',
    method: 'GET',
    path: '/api/transfers/alarms',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The alarms of the transfer and federation paths, newest first (DI-31)',
    response: z.strictObject({ alarms: z.array(InstallationAlarmView) }),
  }),
  acknowledgeAlarm: defineRoute({
    id: 'transfers.acknowledgeAlarm',
    method: 'POST',
    path: '/api/transfers/alarms/:alarmId/acknowledge',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'A person acknowledges a transfer or federation alarm with a note',
    params: z.strictObject({ alarmId: Uuid }),
    body: withAttribution({ note: z.string().trim().min(1).max(1000) }),
    response: InstallationAlarmView,
  }),
} as const;

export const federation = {
  genealogy: defineRoute({
    id: 'federation.genealogy',
    method: 'POST',
    path: '/api/federation/genealogy',
    installation: 'GMP',
    auth: 'NONE',
    mutating: false,
    idempotency: 'NONE',
    summary: 'Site to site, read-only: the genealogy from a transfer this site exchanged with the caller, as of an instant; request and answer sealed by installation keys (L-41)',
    body: z.strictObject({ request: z.string().min(1).max(4000), seal: z.string().min(1).max(200) }),
    response: z.strictObject({ payload: z.string().min(1), seal: Seal }),
  }),
} as const;
