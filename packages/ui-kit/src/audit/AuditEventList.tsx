/**
 * AuditEventList (module C1; plan section 11; DI-22, DI-23): the audit trail, one group per command (correlation):
 * the plain-language business entry first, then the field changes of that command, expandable (old -> new). Each
 * entry shows who (legal name, user ID, role), when (site time with offset and zone from the server, plus UTC),
 * why (the reason given), how (the terminal) and where it sits in its hash chain.
 */
import type { AuditEventView } from '@ebmr/api-contract';
import { icls } from '../identity/classes.ts';

/**
 * UTC text of epoch microseconds, exact to the microsecond and independent of the browser's zone and locale:
 * integer arithmetic only (days to civil date, H. Hinnant's algorithm).
 */
export function utcText(us: string): string {
  const micros = BigInt(us);
  const perDay = 86_400_000_000n;
  let days = micros / perDay;
  let rest = micros % perDay;
  if (rest < 0n) {
    rest += perDay;
    days -= 1n;
  }
  const z = days + 719_468n;
  const era = (z >= 0n ? z : z - 146_096n) / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const d = doy - (153n * mp + 2n) / 5n + 1n;
  const m = mp < 10n ? mp + 3n : mp - 9n;
  const y = yoe + era * 400n + (m <= 2n ? 1n : 0n);
  const pad = (v: bigint, n: number) => v.toString().padStart(n, '0');
  const h = rest / 3_600_000_000n;
  const mi = (rest / 60_000_000n) % 60n;
  const s = (rest / 1_000_000n) % 60n;
  const f = rest % 1_000_000n;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)} ${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}.${pad(f, 6)} UTC`;
}

export interface AuditGroup {
  correlationId: string | null;
  business: AuditEventView[];
  rows: AuditEventView[];
}

/** Consecutive events of one command form a group; business entries lead it. */
export function groupByCommand(events: readonly AuditEventView[]): AuditGroup[] {
  const groups: AuditGroup[] = [];
  for (const e of events) {
    const last = groups.at(-1);
    const g = last && last.correlationId !== null && last.correlationId === e.correlationId ? last : null;
    const target = g ?? { correlationId: e.correlationId, business: [], rows: [] };
    if (!g) groups.push(target);
    (e.kind === 'BUSINESS' ? target.business : target.rows).push(e);
  }
  return groups;
}

const whoText = (e: AuditEventView): string => (e.who ? `${e.who.legalName} (${e.who.loginName}), ${e.who.role}` : 'the installation (software release)');

function Entry({ e }: { e: AuditEventView }) {
  return (
    <article className={icls('entry')} data-kind={e.kind} aria-label={`${e.kind === 'BUSINESS' ? 'Entry' : 'Change'} ${e.seq} of ${e.chainKey}`}>
      <div className={icls('entryHead')}>
        <p className={icls('entrySummary')}>{e.summary}</p>
        <span className={icls('muted')}>{`${e.chainKey} #${e.seq}`}</span>
      </div>
      <p className={icls('entryMeta')}>{`Who: ${whoText(e)}${e.device ? ` · Terminal: ${e.device}` : ''}`}</p>
      <p className={icls('entryMeta')}>{`When: ${e.at.text} · ${utcText(e.at.us)}`}</p>
      {e.why ? <p className={icls('entryMeta')}>{`Why: ${e.why}`}</p> : null}
      {e.changes.length ? (
        <details className={icls('changes')}>
          <summary>{`Field changes (${e.changes.length})`}</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Old value</th>
                <th scope="col">New value</th>
              </tr>
            </thead>
            <tbody>
              {e.changes.map((c) => (
                <tr key={c.field}>
                  <th scope="row">{c.field}</th>
                  <td className={icls('oldValue')}>{c.old ?? '—'}</td>
                  <td className={icls('newValue')}>{c.new ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </article>
  );
}

export function AuditEventList({ events }: { events: readonly AuditEventView[] }) {
  const groups = groupByCommand(events);
  if (groups.length === 0) return <p className={icls('muted')}>No audit entries match.</p>;
  return (
    <div className={icls('audit')}>
      {groups.map((g, i) => (
        <section key={`${g.correlationId ?? 'none'}-${i}`} className={icls('group')} aria-label={`Command ${g.correlationId ?? ''}`.trim()}>
          {g.business.map((e) => (
            <Entry key={e.eventId} e={e} />
          ))}
          {g.rows.length && g.business.length ? (
            <details>
              <summary>{`Records changed by this action (${g.rows.length})`}</summary>
              {g.rows.map((e) => (
                <Entry key={e.eventId} e={e} />
              ))}
            </details>
          ) : (
            g.rows.map((e) => <Entry key={e.eventId} e={e} />)
          )}
        </section>
      ))}
    </div>
  );
}
