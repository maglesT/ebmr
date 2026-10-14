/**
 * QMS contract (Phase 6 slice 6a; builder B). Inbound: deviation and CAPA status with a version token, change
 * controls. With a QMS integrated, CAPA rows are mirrors (D-P6a-6) and the release check reads the QMS status with a
 * version token inside the signing transaction (D-P6a-3, mirror data class QMS_STATUS).
 */
import { z } from 'zod';
import { CalendarDate, SourceCode, SourceText, type SystemContract } from '../contract.ts';

export const VersionToken = z.string().regex(/^[\x21-\x7E]{1,64}$/);
export const QmsDeviationStatusV1 = z.strictObject({
  deviationRef: SourceCode,
  status: z.enum(['OPEN', 'UNDER_INVESTIGATION', 'CLOSED', 'CANCELLED']),
  lotNumbers: z.array(SourceCode).max(200),
  versionToken: VersionToken,
});
export const QmsCapaV1 = z.strictObject({
  capaRef: SourceCode,
  title: SourceText,
  status: z.enum(['OPEN', 'IMPLEMENTED', 'EFFECTIVENESS_CHECK', 'CLOSED', 'CANCELLED']),
  needsMasterChange: z.boolean(),
  effectivenessDueDate: CalendarDate.nullable(),
  versionToken: VersionToken,
});
export const QmsChangeControlV1 = z.strictObject({
  changeRef: SourceCode,
  status: z.enum(['OPEN', 'APPROVED', 'IMPLEMENTED', 'CLOSED', 'REJECTED']),
  versionToken: VersionToken,
});

export const QMS: SystemContract = {
  system: 'QMS',
  inbound: {
    'qms.deviation_status': { summary: 'The QMS status of a deviation and the lots it names', versions: { '1': QmsDeviationStatusV1 } },
    'qms.capa': { summary: 'A CAPA and its effectiveness-check due date (IN-01, PR-51)', versions: { '1': QmsCapaV1 } },
    'qms.change_control': { summary: 'The status of a change control', versions: { '1': QmsChangeControlV1 } },
  },
  outbound: ['qms.deviation_raised', 'qms.capa_requested'],
  refusalCodes: {},
};
