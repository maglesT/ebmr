/**
 * What is being signed (module C1; plan section 6, step 1; DI-37): renderers for the SignableContentView
 * `rendering` of each kind, matched to the shapes the execution store (C3) sends from GET /api/esig/content:
 *  - common: runId, batchNumber, product {code, name, strength}, mbr {familyCode, versionNumber, revision,
 *    contentHash}, meaning, meaningText;
 *  - batch_step: step, instruction, fields (FieldView), entries (EntryView), exceptions (ExceptionView);
 *  - batch_stage: stage, steps (StepSummaryView), exceptions;
 *  - batch_exception: step, exception, recorded, deviation, disposition (the proposed outcome and justification
 *    when the signed content carries them: shown first and prominently, from the content, never from client state);
 *  - mbr_version and anything else: the generic list.
 * They are tolerant: the known members come first with plain labels, and EVERY other member (at the top level and
 * inside known objects) follows as labelled text, so nothing the signature binds to is ever hidden. The exact
 * canonical text (what is hashed) is also always available in a disclosure of the signature dialog.
 * GMP time is never formatted here: instants show the server's text; a bare epoch value shows exact UTC.
 */
import type { ReactNode } from 'react';
import type { SignableContentView } from '@ebmr/api-contract';
import { utcText } from '../audit/AuditEventList.tsx';
import { icls } from './classes.ts';

type Obj = Record<string, unknown>;

const KIND_TITLES: Readonly<Record<string, string>> = {
  batch_step: 'Step',
  batch_stage: 'Stage',
  mbr_version: 'Master record version',
  batch_exception: 'Exception',
  fallback: 'Record',
};

const COMMON = ['kind', 'runId', 'batchNumber', 'product', 'mbr', 'meaning', 'meaningText'] as const;

/** "stepNumber" / "step_number" -> "Step number". */
export function humanize(key: string): string {
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** A data value as it travels (DataValueWire): decimals with their unit, exactly as sent. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (!isObj(v)) return str(v) ?? JSON.stringify(v);
  switch (v['kind']) {
    case 'DECIMAL':
      return `${str(v['value']) ?? '?'} ${str(v['unit']) ?? ''}`.trim();
    case 'COUNT':
    case 'CATEGORY':
    case 'TEXT':
      return str(v['value']) ?? '—';
    case 'BOOLEAN':
      return v['value'] === true ? 'Yes' : v['value'] === false ? 'No' : '—';
    case 'INSTANT':
      return typeof v['us'] === 'string' && /^-?\d+$/.test(v['us']) ? utcText(v['us']) : '—';
    case 'SERIES':
      return `${arr(v['values']).map((x) => str(x) ?? '?').join(', ')} ${str(v['unit']) ?? ''}`.trim();
    default:
      return scalarText(v) ?? JSON.stringify(v);
  }
}

/** Plain text of well-known value shapes: instants {us, text}, decimals {value, unit}, persons {legalName, loginName}. */
export function scalarText(v: unknown): string | null {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v === '' ? '(empty)' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isObj(v)) {
    if (typeof v['text'] === 'string' && typeof v['us'] === 'string') return v['text'];
    if (typeof v['legalName'] === 'string') return personText(v);
    if (typeof v['value'] === 'string' && typeof v['unit'] === 'string' && Object.keys(v).every((k) => ['value', 'unit', 'kind'].includes(k))) return `${v['value']} ${v['unit']}`;
  }
  return null;
}

function personText(p: unknown, none = '—'): string {
  if (!isObj(p)) return none;
  const role = str(p['role']);
  return `${str(p['legalName']) ?? '?'}${str(p['loginName']) ? ` (${str(p['loginName'])})` : ''}${role ? `, ${role}` : ''}`;
}

const instantText = (i: unknown): string => (isObj(i) && typeof i['text'] === 'string' ? i['text'] : (scalarText(i) ?? '—'));

const TIERS: Readonly<Record<string, string>> = { REGISTERED: 'Registered limit', VALIDATED: 'Validated range', INTERNAL_ACTION: 'Action limit', ALERT: 'Alert limit' };

/** "Alert limit: ≥ 12.0 and ≤ 14.0 /min (VALIDATION_REPORT VR-BLEND-01: text); rounding HALF_UP to 1 decimal". */
export function limitText(l: unknown, unit: string | null = null): string {
  if (!isObj(l)) return str(l) ?? JSON.stringify(l);
  const bound = (b: unknown, lower: boolean): string | null => (isObj(b) ? `${lower ? (b['inclusive'] === true ? '≥' : '>') : b['inclusive'] === true ? '≤' : '<'} ${str(b['value']) ?? '?'}` : null);
  const low = bound(l['low'], true);
  const high = bound(l['high'], false);
  const range = [low, high].filter((x): x is string => x !== null).join(' and ') || 'no bound';
  const src = isObj(l['source']) ? `${str(l['source']['kind']) ?? ''} ${str(l['source']['ref']) ?? ''}`.trim() + (str(l['source']['text']) ? `: ${str(l['source']['text'])}` : '') : null;
  const tier = str(l['tier']) ?? '';
  return `${TIERS[tier] ?? tier}: ${range}${unit ? ` ${unit}` : ''}${src ? ` (${src})` : ''}${str(l['rounding']) ? `; rounding ${str(l['rounding'])}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Generic pieces

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={icls('factRow')}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Value({ value, depth }: { value: unknown; depth: number }): ReactNode {
  const s = scalarText(value);
  if (s !== null) return <span className={icls('valueCell')}>{s}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>none</span>;
    return (
      <ol>
        {(value as unknown[]).map((item, i) => (
          <li key={i}>
            <Value value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  if (isObj(value)) return <Facts data={value} order={[]} depth={depth + 1} />;
  return <span>{JSON.stringify(value)}</span>;
}

/** Every member of `data`: those in `order` first with their labels, then all others in key order. */
function Facts({ data, order, depth, skip = [] }: { data: Obj; order: readonly (readonly [string, string])[]; depth: number; skip?: readonly string[] }) {
  const seen = new Set<string>(['kind', ...skip]);
  const rows: [string, string, unknown][] = [];
  for (const [key, label] of order) {
    if (key in data && !seen.has(key)) {
      rows.push([key, label, data[key]]);
      seen.add(key);
    }
  }
  for (const key of Object.keys(data).sort()) {
    if (!seen.has(key)) {
      rows.push([key, humanize(key), data[key]]);
      seen.add(key);
    }
  }
  if (rows.length === 0) return null;
  if (depth > 6) return <span>{JSON.stringify(data)}</span>;
  return (
    <dl className={icls('facts')}>
      {rows.map(([key, label, value]) => (
        <Row key={key} label={label}>
          <Value value={value} depth={depth} />
        </Row>
      ))}
    </dl>
  );
}

/** The members of an object that a renderer did not show itself, as labelled text (never dropped). */
function Extras({ data, known, title }: { data: unknown; known: readonly string[]; title?: string }) {
  if (!isObj(data)) return null;
  const rest = Object.fromEntries(Object.entries(data).filter(([k]) => !known.includes(k) && k !== 'kind'));
  if (Object.keys(rest).length === 0) return null;
  return (
    <>
      {title ? <h5 className={icls('sectionTitle')}>{title}</h5> : null}
      <Facts data={rest} order={[]} depth={1} />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h4 className={icls('sectionTitle')}>{title}</h4>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared engine views

function Header({ r }: { r: Obj }) {
  const product = isObj(r['product']) ? r['product'] : null;
  const mbr = isObj(r['mbr']) ? r['mbr'] : null;
  return (
    <dl className={icls('facts')}>
      {'batchNumber' in r ? <Row label="Batch">{str(r['batchNumber']) ?? '—'}</Row> : null}
      {product ? (
        <Row label="Product">
          {[str(product['code']), str(product['name']), str(product['strength'])].filter(Boolean).join(' · ')}
          <Extras data={product} known={['code', 'name', 'strength']} />
        </Row>
      ) : null}
      {mbr ? (
        <Row label="Master record">
          {`${str(mbr['familyCode']) ?? '?'} version ${str(mbr['versionNumber']) ?? '?'}, revision ${str(mbr['revision']) ?? '?'}`}
          <span className={icls('hash')}>{` · SHA-256 ${str(mbr['contentHash']) ?? '?'}`}</span>
          <Extras data={mbr} known={['familyCode', 'versionNumber', 'revision', 'contentHash']} />
        </Row>
      ) : null}
      {'runId' in r ? <Row label="Run">{str(r['runId']) ?? '—'}</Row> : null}
      {'meaning' in r ? <Row label="Meaning">{`${str(r['meaning']) ?? '?'}${str(r['meaningText']) ? `: ${str(r['meaningText'])}` : ''}`}</Row> : null}
    </dl>
  );
}

const EXCEPTION_KEYS = ['exceptionId', 'title', 'type', 'category', 'severity', 'tier', 'expected', 'actual', 'blocking', 'status', 'deviationRef', 'whatToDo', 'routedTo', 'raisedBy', 'raisedAt', 'controls'];

function ExceptionBlock({ e }: { e: unknown }) {
  if (!isObj(e)) return <Value value={e} depth={1} />;
  const tier = str(e['tier']);
  return (
    <article aria-label={`Exception ${str(e['exceptionId']) ?? ''}`}>
      <h5 className={icls('sectionTitle')}>{`${str(e['exceptionId']) ?? '?'}: ${str(e['title']) ?? ''}`}</h5>
      <dl className={icls('facts')}>
        <Row label="Type">{`${str(e['type']) ?? '—'}${str(e['category']) ? ` (${str(e['category'])})` : ''}`}</Row>
        <Row label="Severity">{`${str(e['severity']) ?? '—'}${tier ? `, ${TIERS[tier] ?? tier}` : ''}`}</Row>
        <Row label="Expected">{str(e['expected']) ?? '—'}</Row>
        <Row label="Actual">{str(e['actual']) ?? '—'}</Row>
        <Row label="Blocking">{e['blocking'] === true ? 'Yes: it stops the work until it is resolved' : 'No'}</Row>
        <Row label="Status">{str(e['status']) ?? '—'}</Row>
        <Row label="Deviation">{str(e['deviationRef']) ?? 'none linked'}</Row>
        <Row label="What to do">{str(e['whatToDo']) ?? '—'}</Row>
        <Row label="Routed to">{arr(e['routedTo']).map((x) => str(x) ?? '?').join(', ') || '—'}</Row>
        <Row label="Raised by">{e['raisedBy'] === null ? 'the system' : personText(e['raisedBy'])}</Row>
        <Row label="Raised at">{instantText(e['raisedAt'])}</Row>
        <Row label="Controls">{arr(e['controls']).map((x) => str(x) ?? '?').join(', ') || '—'}</Row>
      </dl>
      <Extras data={e} known={EXCEPTION_KEYS} />
    </article>
  );
}

function Exceptions({ list }: { list: unknown }) {
  const items = arr(list);
  return (
    <Section title="Exceptions">
      {items.length === 0 ? <p>None.</p> : items.map((e, i) => <ExceptionBlock key={isObj(e) ? (str(e['exceptionId']) ?? i) : i} e={e} />)}
    </Section>
  );
}

const ATTEMPT_KEYS = ['pointId', 'attempt', 'version', 'value', 'echo', 'by', 'at', 'source', 'verdict', 'flags', 'status'];

function Attempt({ a, unit }: { a: unknown; unit: string | null }) {
  if (!isObj(a)) return <Value value={a} depth={2} />;
  const source = isObj(a['source']) ? a['source'] : {};
  const verdict = isObj(a['verdict']) ? a['verdict'] : null;
  const flags = arr(a['flags']).map((x) => str(x) ?? '?');
  void unit;
  return (
    <li>
      <dl className={icls('facts')}>
        <Row label="Value">
          <span className={icls('valueCell')}>{valueText(a['value'])}</span>
          {str(a['echo']) ? ` (${str(a['echo'])})` : ''}
        </Row>
        <Row label="Attempt">{`${str(a['attempt']) ?? '?'}, version ${str(a['version']) ?? '?'}, ${str(a['status']) ?? '?'}`}</Row>
        <Row label="Entered by">{personText(a['by'])}</Row>
        <Row label="At">{instantText(a['at'])}</Row>
        <Row label="Source">
          {[str(source['mode']), str(source['deviceCode']) ? `device ${str(source['deviceCode'])}` : null, str(source['raw']) ? `raw ${str(source['raw'])}` : null, str(source['code']) ? `code ${str(source['code'])}` : null]
            .filter(Boolean)
            .join(', ') || '—'}
        </Row>
        <Row label="Limit check">{verdict ? `${str(verdict['text']) ?? ''}${verdict['failed'] === true ? ' (outside the limit)' : ''}` : 'not evaluated'}</Row>
        {flags.length ? <Row label="Flags">{flags.join(', ')}</Row> : null}
      </dl>
      <Extras data={a} known={ATTEMPT_KEYS} />
      <Extras data={source} known={['mode', 'deviceCode', 'raw', 'code']} />
    </li>
  );
}

const FIELD_KEYS = ['item', 'name', 'valueType', 'unit', 'precision', 'categories', 'capture', 'target', 'limits', 'attempts', 'computed', 'required'];

function Field({ f }: { f: unknown }) {
  if (!isObj(f)) return <Value value={f} depth={1} />;
  const unit = str(f['unit']);
  const target = isObj(f['target']) ? f['target'] : null;
  const precision = isObj(f['precision']) ? f['precision'] : null;
  const limits = arr(f['limits']);
  const attempts = arr(f['attempts']);
  return (
    <article aria-label={`Value ${str(f['name']) ?? str(f['item']) ?? ''}`}>
      <h5 className={icls('sectionTitle')}>{`${str(f['name']) ?? '?'}${unit ? ` (${unit})` : ''}`}</h5>
      <dl className={icls('facts')}>
        <Row label="Item">{`${str(f['item']) ?? '?'} · ${str(f['valueType']) ?? '?'}${precision ? ` · ${str(precision['digits']) ?? '?'} ${precision['kind'] === 'SIGNIFICANT_FIGURES' ? 'significant figures' : 'decimals'}` : ''}`}</Row>
        <Row label="Captured">{`${str(f['capture']) ?? '?'}${f['computed'] === true ? ', computed (never typed)' : ''}${f['required'] === true ? ', required' : ''}`}</Row>
        {Array.isArray(f['categories']) ? <Row label="Choices">{arr(f['categories']).map((x) => str(x) ?? '?').join(', ')}</Row> : null}
        <Row label="Target">{target ? `${valueText(target['value'])}${str(target['source']) ? ` (${str(target['source'])})` : ''}` : '—'}</Row>
        <Row label="Limits">
          {limits.length === 0 ? (
            'none'
          ) : (
            <ul>
              {limits.map((l, i) => (
                <li key={i}>{limitText(l, unit)}</li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="Recorded">
          {attempts.length === 0 ? (
            'nothing recorded'
          ) : (
            <ol>
              {attempts.map((a, i) => (
                <Attempt key={isObj(a) ? `${str(a['pointId']) ?? ''}-${str(a['attempt']) ?? i}-${str(a['version']) ?? ''}` : i} a={a} unit={unit} />
              ))}
            </ol>
          )}
        </Row>
      </dl>
      <Extras data={f} known={FIELD_KEYS} />
    </article>
  );
}

const ENTRY_KEYS = ['entryId', 'kind', 'summary', 'data', 'by', 'at'];

function Entry({ e }: { e: unknown }) {
  if (!isObj(e)) return <Value value={e} depth={1} />;
  return (
    <li>
      <p>{`${str(e['summary']) ?? str(e['kind']) ?? '?'} (${str(e['kind']) ?? '?'}, ${str(e['entryId']) ?? '?'})`}</p>
      <dl className={icls('facts')}>
        <Row label="By">{personText(e['by'])}</Row>
        <Row label="At">{instantText(e['at'])}</Row>
      </dl>
      {isObj(e['data']) ? <Facts data={e['data']} order={[]} depth={1} /> : null}
      <Extras data={e} known={ENTRY_KEYS} />
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Kinds

const STEP_TOP = [...COMMON, 'step', 'instruction', 'fields', 'entries', 'exceptions'];

function BatchStep({ r }: { r: Obj }) {
  const step = isObj(r['step']) ? r['step'] : {};
  const stage = isObj(step['stage']) ? step['stage'] : null;
  const instruction = isObj(r['instruction']) ? r['instruction'] : {};
  const sop = isObj(instruction['sop']) ? instruction['sop'] : null;
  const fields = arr(r['fields']);
  const entries = arr(r['entries']);
  return (
    <>
      <Header r={r} />
      <Section title="Step">
        <dl className={icls('facts')}>
          <Row label="Step">{`${str(step['number']) ?? '?'} ${str(step['title']) ?? ''}`.trim()}</Row>
          <Row label="Kind">{step['kind'] === 'HOLD' ? 'QA hold point' : 'Processing step'}</Row>
          <Row label="Block">{str(step['block']) ? `${str(step['block']) ?? ''}${str(step['blockTitle']) ? ` ${str(step['blockTitle'])}` : ''}` : '—'}</Row>
          <Row label="Stage">{stage ? `${str(stage['number']) ?? '?'} ${str(stage['name']) ?? ''}`.trim() : '—'}</Row>
          <Row label="Step key">{`${str(step['stepKey']) ?? '?'} (${str(step['stepId']) ?? '?'})`}</Row>
        </dl>
        <Extras data={step} known={['stepKey', 'stepId', 'number', 'title', 'kind', 'block', 'blockTitle', 'stage']} />
        <Extras data={stage} known={['stageKey', 'number', 'name']} />
      </Section>
      <Section title="Instruction">
        <p>{str(instruction['text']) ?? 'No instruction text.'}</p>
        {sop ? (
          <p>
            {`SOP ${str(sop['code']) ?? '?'} ${str(sop['title']) ?? ''}, version ${str(sop['version']) ?? '?'}`}
            <span className={icls('hash')}>{str(sop['hash']) ? ` · SHA-256 ${str(sop['hash'])}` : ''}</span>
          </p>
        ) : null}
        <Extras data={instruction} known={['text', 'sop']} />
        <Extras data={sop} known={['code', 'title', 'version', 'hash']} />
      </Section>
      <Section title="Values">{fields.length === 0 ? <p>None.</p> : fields.map((f, i) => <Field key={isObj(f) ? (str(f['item']) ?? i) : i} f={f} />)}</Section>
      <Section title="Entries">
        {entries.length === 0 ? (
          <p>None.</p>
        ) : (
          <ol>
            {entries.map((e, i) => (
              <Entry key={isObj(e) ? (str(e['entryId']) ?? i) : i} e={e} />
            ))}
          </ol>
        )}
      </Section>
      <Exceptions list={r['exceptions']} />
      <Extras data={r} known={STEP_TOP} title="Also in the record" />
    </>
  );
}

const STAGE_TOP = [...COMMON, 'stage', 'steps', 'exceptions'];
const SUMMARY_KEYS = ['stepKey', 'stepId', 'number', 'title', 'block', 'status', 'statusText', 'openExceptions'];

function BatchStage({ r }: { r: Obj }) {
  const stage = isObj(r['stage']) ? r['stage'] : {};
  const steps = arr(r['steps']);
  return (
    <>
      <Header r={r} />
      <Section title="Stage">
        <dl className={icls('facts')}>
          <Row label="Stage">{`${str(stage['number']) ?? '?'} ${str(stage['name']) ?? ''}`.trim()}</Row>
          <Row label="Started at">{instantText(stage['startedAt'])}</Row>
          <Row label="Stage key">{`${str(stage['stageKey']) ?? '?'} (${str(stage['stageId']) ?? '?'})`}</Row>
        </dl>
        <Extras data={stage} known={['stageKey', 'stageId', 'number', 'name', 'startedAt']} />
      </Section>
      <Section title="Steps">
        {steps.length === 0 ? (
          <p>None.</p>
        ) : (
          <table className={icls('contentTable')}>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Title</th>
                <th scope="col">Block</th>
                <th scope="col">Status</th>
                <th scope="col">Open exceptions</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) =>
                isObj(s) ? (
                  <tr key={str(s['stepKey']) ?? i}>
                    <th scope="row">{str(s['number']) ?? '?'}</th>
                    <td>
                      {str(s['title']) ?? ''}
                      <Extras data={s} known={SUMMARY_KEYS} />
                    </td>
                    <td>{str(s['block']) ?? '—'}</td>
                    <td>{str(s['statusText']) ?? str(s['status']) ?? '—'}</td>
                    <td>{str(s['openExceptions']) ?? '0'}</td>
                  </tr>
                ) : (
                  <tr key={i}>
                    <td colSpan={5}>
                      <Value value={s} depth={1} />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </Section>
      <Exceptions list={r['exceptions']} />
      <Extras data={r} known={STAGE_TOP} title="Also in the record" />
    </>
  );
}

const EXCEPTION_TOP = [...COMMON, 'step', 'exception', 'recorded', 'deviation', 'disposition'];

/** The proposed disposition, from the signed content only: first and prominent. */
function Disposition({ d }: { d: unknown }) {
  const proposed = isObj(d) && isObj(d['proposed']) ? d['proposed'] : null;
  return (
    <section className={icls('disposition')} aria-label="Proposed disposition" data-present={proposed ? 'true' : 'false'}>
      <h4 className={icls('sectionTitle')}>Proposed disposition</h4>
      {proposed ? (
        <>
          <dl className={icls('facts')}>
            <Row label="Outcome">{str(proposed['outcome']) === 'NO_IMPACT' ? 'No impact (NO_IMPACT)' : str(proposed['outcome']) === 'DEVIATION_RAISED' ? 'Deviation raised (DEVIATION_RAISED)' : (str(proposed['outcome']) ?? '—')}</Row>
            <Row label="Justification">{str(proposed['justification']) ?? '—'}</Row>
            <Row label="Deviation">{str(proposed['deviationRef']) ?? 'none'}</Row>
          </dl>
          <Extras data={proposed} known={['outcome', 'justification', 'deviationRef']} />
        </>
      ) : (
        <p>No disposition is part of the content shown. The signature binds only what is shown here.</p>
      )}
      <Extras data={d} known={['proposed']} />
    </section>
  );
}

function BatchException({ r }: { r: Obj }) {
  const step = isObj(r['step']) ? r['step'] : null;
  const recorded = isObj(r['recorded']) ? r['recorded'] : null;
  const deviation = isObj(r['deviation']) ? r['deviation'] : null;
  const limits = recorded ? arr(recorded['limits']) : [];
  const recordedValue = recorded ? (recorded['value'] !== null && recorded['value'] !== undefined ? valueText(recorded['value']) : (str(recorded['text']) ?? '—')) : null;
  return (
    <>
      <Disposition d={r['disposition']} />
      <Header r={r} />
      <Section title="Exception">
        <ExceptionBlock e={r['exception']} />
      </Section>
      <Section title="Step">{step ? <p>{`${str(step['number']) ?? '?'} ${str(step['title']) ?? ''} (${str(step['stepKey']) ?? '?'})`}</p> : <p>Not raised at a step.</p>}</Section>
      <Extras data={step} known={['stepKey', 'number', 'title']} />
      <Section title="Recorded value">
        {recorded ? (
          <dl className={icls('facts')}>
            <Row label={str(recorded['name']) ?? 'Value'}>
              <span className={icls('valueCell')}>{recordedValue}</span>
              {` (${str(recorded['item']) ?? '?'})`}
            </Row>
            {recorded['value'] !== null && str(recorded['text']) ? <Row label="As recorded">{str(recorded['text'])}</Row> : null}
            <Row label="Limits">
              {limits.length === 0 ? (
                'none'
              ) : (
                <ul>
                  {limits.map((l, i) => (
                    <li key={i}>{limitText(l)}</li>
                  ))}
                </ul>
              )}
            </Row>
          </dl>
        ) : (
          <p>No recorded value belongs to this exception.</p>
        )}
        <Extras data={recorded} known={['item', 'name', 'value', 'text', 'limits']} />
      </Section>
      <Section title="Deviation linked">
        {deviation ? <p>{`${str(deviation['ref']) ?? '?'}, linked by ${deviation['linkedBy'] === null ? 'the system' : personText(deviation['linkedBy'])} at ${instantText(deviation['at'])}`}</p> : <p>None.</p>}
        <Extras data={deviation} known={['ref', 'linkedBy', 'at']} />
      </Section>
      <Extras data={r} known={EXCEPTION_TOP} title="Also in the record" />
    </>
  );
}

/** Preferred order and labels of the generic renderer (master record versions and unknown kinds). */
const KNOWN: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  mbr_version: [
    ['number', 'Number'],
    ['revision', 'Revision'],
    ['title', 'Title'],
    ['product', 'Product'],
    ['state', 'State'],
    ['markets', 'Markets'],
    ['contentHash', 'Content hash'],
    ['changes', 'Changes'],
  ],
};

/** The record to be signed, per rendering kind; unknown kinds use the generic list (every field shown). */
export function SignableContent({ view }: { view: SignableContentView }) {
  const rendering = view.rendering as Obj & { kind: string };
  const kind = rendering.kind in KIND_TITLES ? rendering.kind : 'fallback';
  let body: ReactNode;
  if (kind === 'batch_step') body = <BatchStep r={rendering} />;
  else if (kind === 'batch_stage') body = <BatchStage r={rendering} />;
  else if (kind === 'batch_exception') body = <BatchException r={rendering} />;
  else {
    const data: Obj =
      kind === 'fallback' && isObj(rendering['content'])
        ? { ...rendering['content'], ...(rendering['state'] !== undefined && rendering['state'] !== null ? { state: rendering['state'] } : {}) }
        : rendering;
    const extra = kind === 'fallback' ? Object.fromEntries(Object.entries(rendering).filter(([k]) => !['kind', 'content', 'state'].includes(k))) : {};
    body = <Facts data={{ ...data, ...extra }} order={KNOWN[kind] ?? []} depth={0} />;
  }
  return (
    <section aria-label={`${KIND_TITLES[kind] ?? 'Record'} to be signed`}>
      <h3 className={icls('sectionTitle')}>{view.title}</h3>
      {body}
      <p className={icls('muted')}>
        {`${KIND_TITLES[kind] ?? 'Record'} ${view.aggregateId}, content version ${view.contentVersion}${view.preview ? ' (as it will be when signed)' : ''}`}
      </p>
    </section>
  );
}
