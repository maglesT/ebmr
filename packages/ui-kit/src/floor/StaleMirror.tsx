/**
 * The stale-mirror part of a refusal (Phase 6 slice 6a, builder B; DI-31; D-P6a-3): when a guard refused because data
 * mirrored from another system is too old (EBMR-INT-010: qualifications from the LMS at signing, calibrations and
 * maintenance from the CMMS at equipment use) or the QMS could not be asked at release (EBMR-QMS-0xx), the screen says
 * which mirror, how old it is against its bound, and whom to call. The words are read from the server's refusal (the
 * database's own text); nothing is computed here but the display of the seconds.
 */
import { t } from '../i18n/index.ts';

export interface StaleMirror {
  system: string;
  dataClass: string;
  /** Seconds since the last synchronisation, null when it never synchronised or for a live fetch. */
  ageSeconds: number | null;
  boundSeconds: number | null;
  live: boolean;
}

const CLASS_WORDS: Readonly<Record<string, string>> = {
  LMS_QUALIFICATION: 'qualifications and training',
  CMMS_CALIBRATION: 'calibration due dates and results',
  CMMS_MAINTENANCE: 'maintenance due dates',
  QMS_STATUS: 'deviation and CAPA status',
  ERP_LOT_STATUS: 'lot status',
};

/** The stale mirror a refusal names, or null. */
export function staleMirrorOf(code: string, why: string): StaleMirror | null {
  const m = /the (\w+) mirror ([A-Z_]+) is stale: (?:it has never synchronised|last synchronised (\d+) s ago), more than its bound of (\d+) s/.exec(why);
  if (m) return { system: m[1] ?? '', dataClass: m[2] ?? '', ageSeconds: m[3] ? Number(m[3]) : null, boundSeconds: Number(m[4]), live: false };
  if (/^EBMR-QMS-0(1[1345]|20)$/.test(code)) return { system: 'QMS', dataClass: 'QMS_STATUS', ageSeconds: null, boundSeconds: null, live: true };
  return null;
}

const duration = (s: number): string => {
  const h = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h.toString()} h ${min.toString()} min` : min > 0 ? `${min.toString()} min` : `${s.toString()} s`;
};

export function StaleMirrorNotice({ mirror: s }: { mirror: StaleMirror }) {
  return (
    <p data-testid="stale-mirror" data-mirror={s.dataClass}>
      <strong>{t('refusal.staleMirror')}:</strong> {CLASS_WORDS[s.dataClass] ?? s.dataClass} from the {s.system} ({s.dataClass}).{' '}
      {s.live
        ? `The ${s.system} is asked live at release; its answer is not used when it is missing, late or changed.`
        : s.ageSeconds === null
          ? `It has never synchronised (allowed age ${duration(s.boundSeconds ?? 0)}).`
          : `Last synchronised ${duration(s.ageSeconds)} ago (allowed ${duration(s.boundSeconds ?? 0)}).`}{' '}
      Call the {s.system} system owner.
    </p>
  );
}
