/**
 * Deep links into the audit trail viewer (module C1; plan section 11), for the designer (C2), the run overview (C3)
 * and the step screen (C4):
 *   <Link {...auditLink({ chain: `mbr_version:${id}` })}>Audit trail</Link>
 *   <a href={auditHref({ chain: `batch:${runId}` })}>Audit trail</a>
 */
export interface AuditSearch {
  /** A chain key such as mbr_version:<id>, batch:<id>, esig_stub:<id>. */
  chain?: string;
  /** The correlation id of one command: its business entry and every row it changed. */
  correlation?: string;
  /** A person id: the entries they made. */
  person?: string;
}

const clean = (s: AuditSearch): AuditSearch => Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'string' && v !== '')) as AuditSearch;

/** Router link props (TanStack Router `Link`, `navigate`). */
export function auditLink(search: AuditSearch = {}): { to: '/audit'; search: AuditSearch } {
  return { to: '/audit', search: clean(search) };
}

/** The same place as a plain href. */
export function auditHref(search: AuditSearch = {}): string {
  const q = new URLSearchParams(clean(search) as Record<string, string>).toString();
  return q ? `/audit?${q}` : '/audit';
}

export function parseAuditSearch(raw: Record<string, unknown>): AuditSearch {
  const pick = (k: string): string | undefined => (typeof raw[k] === 'string' && raw[k] !== '' ? (raw[k] as string) : undefined);
  const chain = pick('chain');
  const correlation = pick('correlation');
  const person = pick('person');
  return { ...(chain ? { chain } : {}), ...(correlation ? { correlation } : {}), ...(person ? { person } : {}) };
}
