/**
 * The document-first view of an MBR version (module C2; plan section 8): sections 0-11 in the order of a paper batch
 * record. The approved batch sizes, product and references are the family's and read-only here; limits, targets,
 * time bounds and hold times are edited in place with DecimalField (text, never a number); the procedure is edited
 * through its rows (ProcedureTable) and the step properties panel.
 *
 * The document is what the author, the checker and the approver read, so it shows every member of the saved content
 * that decides how a batch runs (review F44): acceptance schemes, the limits and breach handling of parameters and
 * calculations, readings per capture, market rules, hold-time storage, time-constraint breach, warning and pauses,
 * specimens, market predicates and golden-case values. Values are shown exactly as written (never rounded), and each
 * limit bound says in words whether its value passes. test/designer/document-complete.test.tsx walks every member.
 */
import { useState, type ReactNode } from 'react';
import { flow, library } from '@ebmr/recipe-core/pure';
import type { VersionView } from '@ebmr/api-contract';
import { dcls } from '../classes.ts';
import { KNOWN_MARKETS, type Content, type Op } from '../model/ops.ts';
import { documentNumbering } from '../model/numbering.ts';
import { DOCUMENT_SECTIONS, sectionId } from '../model/sections.ts';
import type { FindingItem, PaletteItem } from '../model/types.ts';
import { boundWords, Check, CommitDecimal, CommitText, comparisonWords, roleTitle, Select } from './common.tsx';
import { ProcedureTable } from './ProcedureTable.tsx';
import { AddStage, StageEditor } from './StageEditor.tsx';
import { actionBreachWords, eventWords, goldenValueText, humanize, itemLabel, marketRuleWords, quantityWords, referenceLabel, roundingWords, samplingWords, sourceWords, yesNo } from './words.ts';
import { useScreenDosageForm } from '../../../app/brand.tsx';

export interface DocumentProps {
  content: Content;
  version: VersionView;
  palette: readonly PaletteItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  dispatch: (op: Op) => boolean;
  readOnly: boolean;
  findingsByNode: ReadonlyMap<string, FindingItem[]>;
}

function Section({ id, children }: { id: string; children: ReactNode }) {
  const s = DOCUMENT_SECTIONS.find((x) => x.id === id);
  return (
    <section className={dcls('section')} id={sectionId(id)} aria-labelledby={`${sectionId(id)}-title`}>
      <h2 className={dcls('sectionTitle')} id={`${sectionId(id)}-title`} tabIndex={-1}>
        <span className={dcls('sectionNo')}>{id}</span>
        {s?.title}
      </h2>
      {children}
    </section>
  );
}

const tierLabel = (t: string): string => t.toLowerCase().replace('_', ' ');

type LimitOwner = 'parameter' | 'calculation' | 'yield';

/**
 * One bound of a limit range: in words with its comparison in every mode ("less than 3.5 %"), and while editing a
 * choice of the comparison next to the value. The choice is remembered while the value is cleared, so a cleared
 * exclusive bound typed again stays exclusive; a new bound is created with the comparison shown (review F47).
 */
function BoundCell({ owner, id, name, tier, side, bound, unit, dispatch, readOnly }: { owner: LimitOwner; id: string; name: string; tier: flow.LimitSpec['ranges'][number]['tier']; side: 'low' | 'high'; bound: { value: string; inclusive: boolean } | undefined; unit: string; dispatch: (op: Op) => boolean; readOnly: boolean }) {
  const [inclusive, setInclusive] = useState(bound?.inclusive ?? true);
  // The content changed (undo, a server answer): follow the bound when there is one (derived state, set during render).
  const [base, setBase] = useState(bound?.inclusive);
  if (base !== bound?.inclusive) {
    setBase(bound?.inclusive);
    if (bound) setInclusive(bound.inclusive);
  }
  const what = `${name}, ${tierLabel(tier)}, ${side === 'low' ? 'lower' : 'upper'} limit`;
  if (readOnly) return <span data-bound={side}>{boundWords(side, bound, unit)}</span>;
  return (
    <div className={dcls('stack')} data-bound={side}>
      <Select
        label={`${what}: the value itself`}
        value={inclusive ? 'INCLUSIVE' : 'EXCLUSIVE'}
        options={[
          { value: 'INCLUSIVE', label: `${comparisonWords(side, true)} (the value itself passes)` },
          { value: 'EXCLUSIVE', label: `${comparisonWords(side, false)} (the value itself fails)` },
        ]}
        onChange={(v) => {
          const next = v === 'INCLUSIVE';
          setInclusive(next);
          if (bound && bound.inclusive !== next) dispatch({ kind: 'SET_LIMIT_INCLUSIVE', owner, id, tier, side, inclusive: next });
        }}
      />
      <CommitDecimal label={what} unit={unit} value={bound?.value} readOnly={false} onCommit={(value) => dispatch({ kind: 'SET_LIMIT_BOUND', owner, id, tier, side, value, inclusive: bound?.inclusive ?? inclusive })} />
      <span className={dcls('small')}>{boundWords(side, bound, unit)}</span>
    </div>
  );
}

function LimitsTable({ owner, id, name, spec, dispatch, readOnly }: { owner: LimitOwner; id: string; name: string; spec: flow.LimitSpec; dispatch: (op: Op) => boolean; readOnly: boolean }) {
  return (
    <>
      <table className={dcls('grid')} aria-label={`Limits of ${name}`}>
        <thead>
          <tr>
            <th scope="col">Tier</th>
            <th scope="col">Low</th>
            <th scope="col">High</th>
            <th scope="col">Source</th>
            <th scope="col">Rounding</th>
          </tr>
        </thead>
        <tbody>
          {spec.ranges.map((r) => (
            <tr key={r.tier}>
              <th scope="row">{tierLabel(r.tier)}</th>
              {(['low', 'high'] as const).map((side) => (
                <td key={side}>
                  <BoundCell owner={owner} id={id} name={name} tier={r.tier} side={side} bound={r[side]} unit={spec.unit} dispatch={dispatch} readOnly={readOnly} />
                </td>
              ))}
              <td>
                {sourceWords(r.source)}
                {r.pharmacopoeia ? ` (${r.pharmacopoeia.code} ${r.pharmacopoeia.edition})` : ''}
              </td>
              <td className={dcls('small')}>{roundingWords(r.rounding)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={dcls('small')}>
        Limits in {spec.unit}; {actionBreachWords(spec.actionBreach)}.
      </p>
    </>
  );
}

/** One range of an acceptance criterion, read-only (criteria are not edited in this release). */
function rangeWords(r: flow.LimitSpec['ranges'][number], unit: string): string {
  return `${tierLabel(r.tier)}: ${boundWords('low', r.low, unit)}, ${boundWords('high', r.high, unit)}; ${roundingWords(r.rounding)}; source ${sourceWords(r.source)}${r.pharmacopoeia ? ` (${r.pharmacopoeia.code} ${r.pharmacopoeia.edition})` : ''}`;
}

function AcceptanceSchemes({ c }: { c: Content }) {
  if (c.acceptanceSchemes.length === 0) return <p className={dcls('small')}>No acceptance schemes.</p>;
  return (
    <>
      {c.acceptanceSchemes.map((s) => (
        <div key={s.id} id={`mbr-item-${s.id}`} tabIndex={-1}>
          <h4>
            {s.title} <span className={dcls('mono')}>{s.id}</span>
          </h4>
          <p className={dcls('small')}>Method: {s.method === 'ALL_APPLY' ? 'all apply (each criterion is evaluated on its own and every one must pass)' : humanize(s.method)}</p>
          <table className={dcls('grid')} aria-label={`Criteria of ${s.title}`}>
            <thead>
              <tr>
                <th scope="col">Criterion</th>
                <th scope="col">Markets</th>
                <th scope="col">Pharmacopoeia</th>
                <th scope="col">Statistic</th>
                <th scope="col">Range</th>
                <th scope="col">Sampling</th>
              </tr>
            </thead>
            <tbody>
              {s.criteria.map((k) => (
                <tr key={k.id}>
                  <td>
                    {k.title} <span className={dcls('mono')}>{k.id}</span>
                  </td>
                  <td>{k.governingMarkets.join(', ')}</td>
                  <td>
                    {k.pharmacopoeia.code} {k.pharmacopoeia.edition}
                  </td>
                  <td>
                    {itemLabel(c, k.statistic)} in {k.unit}
                  </td>
                  <td>{rangeWords(k.range, k.unit)}</td>
                  <td>
                    <ul className={dcls('list')}>
                      {k.sampling.map((x, i) => (
                        <li key={i}>{samplingWords(x)}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

function parameterFacts(p: flow.Parameter): string[] {
  const out: string[] = [humanize(p.valueType)];
  if (p.unit) out.push(`unit ${p.unit}`);
  if (p.semanticTag) out.push(`semantic tag ${p.semanticTag}`);
  if (p.precision) out.push(`${p.precision.digits} ${p.precision.kind === 'DECIMALS' ? 'decimals' : 'significant figures'}`);
  if (p.categories) out.push(`values ${p.categories.join(', ')}`);
  if (p.readings !== undefined) out.push(`${p.readings} readings per capture`);
  out.push(humanize(p.role), p.criticality === 'CRITICAL' ? 'critical' : 'non-critical', `risk class ${p.riskClass}`, `captured ${humanize(p.capture)}`);
  if (p.evidence) out.push(p.evidence === 'NONE' ? 'evidence none' : `with ${humanize(p.evidence)} as evidence`);
  if (p.accuracyCheck) out.push(`accuracy check: ${humanize(p.accuracyCheck)}`);
  return out;
}

function Parameters({ c, dispatch, readOnly }: { c: Content; dispatch: (op: Op) => boolean; readOnly: boolean }) {
  return (
    <>
      {c.parameters.map((p) => (
        <div key={p.id} id={`mbr-item-${p.id}`} tabIndex={-1}>
          <h3 className={dcls('panelTitle')}>
            {p.name} <span className={dcls('mono')}>{p.id}</span>
          </h3>
          <p className={dcls('small')}>{parameterFacts(p).join(' · ')}</p>
          {p.valueType === 'DECIMAL' && !readOnly ? (
            <CommitDecimal label={`Target of ${p.name}`} unit={p.unit ?? ''} value={p.target} readOnly={false} onCommit={(value) => dispatch({ kind: 'SET_TARGET', parameterId: p.id, value })} />
          ) : (
            <p>
              Target: {p.target !== undefined ? `${p.target}${p.unit ? ` ${p.unit}` : ''}` : 'none'}
            </p>
          )}
          {p.marketRule ? <p className={dcls('small')}>Limit {marketRuleWords(p.marketRule)}.</p> : null}
          {p.limits ? <LimitsTable owner="parameter" id={p.id} name={p.name} spec={p.limits} dispatch={dispatch} readOnly={readOnly} /> : <p className={dcls('small')}>No limits.</p>}
        </div>
      ))}
    </>
  );
}

function Calculations({ c, dispatch, readOnly }: { c: Content; dispatch: (op: Op) => boolean; readOnly: boolean }) {
  return (
    <>
      {c.calculations.map((x) => (
        <div key={x.id} id={`mbr-item-${x.id}`} tabIndex={-1}>
          <h3 className={dcls('panelTitle')}>
            {x.name} <span className={dcls('mono')}>{x.id}</span>
          </h3>
          <p>
            Formula: <span className={dcls('mono')}>{x.expression}</span>
          </p>
          <p className={dcls('small')}>
            Result {humanize(x.output.valueType)}
            {x.output.unit ? ` in ${x.output.unit}` : ''}
            {x.output.semanticTag ? ` (semantic tag ${x.output.semanticTag})` : ''} · {x.criticality === 'CRITICAL' ? 'critical' : 'non-critical'} · risk class {x.riskClass}
          </p>
          {x.limits ? <LimitsTable owner="calculation" id={x.id} name={x.name} spec={x.limits} dispatch={dispatch} readOnly={readOnly} /> : <p className={dcls('small')}>No limits.</p>}
        </div>
      ))}
      <p className={dcls('small')}>Formulas are read-only in this release (the formula editor comes next).</p>
    </>
  );
}

const MARKET_NAMES: Readonly<Record<string, string>> = { IN: 'India (IN)', US: 'United States (US)', EU: 'European Union (EU)' };

function timeBoundWords(side: 'min' | 'max', q: { value: string; unit: string } | undefined): string {
  if (!q) return side === 'min' ? 'no minimum' : 'no maximum';
  return `${side === 'min' ? 'at least' : 'at most'} ${q.value} ${q.unit}`;
}

export function DocumentView(props: DocumentProps) {
  const { content: c, version: v, dispatch, readOnly } = props;
  const { numbering, problem: numberingProblem } = documentNumbering(c);
  const h = c.header;
  // Capsules edition C2: a capsule master on screen turns the header to Batchwright Capsules.
  useScreenDosageForm(h.product.dosageForm);
  const stages: flow.StageNode[] = [];
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'stage') stages.push(n);
  });
  const predicates = Object.entries(h.predicates);

  return (
    <div className={dcls('document')}>
      <Section id="0">
        {readOnly ? (
          <p>
            <strong>Title:</strong> {h.title}
          </p>
        ) : (
          <CommitText label="Title" value={h.title} readOnly={false} onCommit={(title) => dispatch({ kind: 'SET_TITLE', title })} />
        )}
        <dl className={dcls('dl')}>
          <dt>Document</dt>
          <dd>
            MBR-{v.familyCode}-v{v.number}, revision {v.revision}
          </dd>
          <dt>Family</dt>
          <dd>{h.family}</dd>
          <dt>Edition</dt>
          <dd>
            {h.edition}, {h.recordKind.toLowerCase()} record
          </dd>
          <dt>Content format</dt>
          <dd>
            {c.format}, version {c.formatVersion}
          </dd>
          <dt>Content hash</dt>
          <dd className={dcls('mono')}>{v.contentHash} (saved revision)</dd>
        </dl>
        <table className={dcls('grid')} aria-label="Signatures">
          <thead>
            <tr>
              <th scope="col">Prepared by</th>
              <th scope="col">Checked by</th>
              <th scope="col">Approved by (QA)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>not signed</td>
              <td>not signed</td>
              <td>not signed</td>
            </tr>
          </tbody>
        </table>
        <p className={dcls('small')}>Electronic signatures (prepared, checked, approved) are applied after verification, with the approval rendition.</p>
      </Section>

      <Section id="1">
        <dl className={dcls('dl')}>
          <dt>Product</dt>
          <dd>
            {h.product.name} {h.product.strength} ({h.product.code})
          </dd>
          <dt>Dosage form</dt>
          <dd>{h.product.dosageForm}</dd>
        </dl>
        <table className={dcls('grid')} aria-label="Approved batch sizes">
          <thead>
            <tr>
              <th scope="col">Batch size</th>
              <th scope="col">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {h.batchSizes.map((b, i) => (
              <tr key={b.id} id={`mbr-item-${b.id}`} tabIndex={-1}>
                <td>
                  {b.id}
                  {i === 0 ? ' (reference for the BOM)' : ''}
                </td>
                <td>{quantityWords(b.quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={dcls('small')}>The approved batch sizes belong to the family: a batch can be made only at one of them (no free scaling). Another size is another family.</p>
        {c.inputs.length > 0 ? (
          <table className={dcls('grid')} aria-label="Header and master-data inputs">
            <thead>
              <tr>
                <th scope="col">Input at issue</th>
                <th scope="col">Type</th>
                <th scope="col">From</th>
              </tr>
            </thead>
            <tbody>
              {c.inputs.map((i) => (
                <tr key={i.id} id={`mbr-item-${i.id}`} tabIndex={-1}>
                  <td>
                    {i.name} <span className={dcls('mono')}>{i.id}</span>
                  </td>
                  <td>
                    {humanize(i.valueType)}
                    {i.unit ? ` (${i.unit})` : ''}
                    {i.categories ? `, values ${i.categories.join(', ')}` : ''}
                  </td>
                  <td>{i.source === 'BATCH_HEADER' ? 'batch header' : `master data${i.ref ? ` ${referenceLabel(c, i.ref)}` : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={dcls('small')}>No header or master-data inputs.</p>
        )}
      </Section>

      <Section id="2">
        <p>Markets of this master: {h.marketSet.map((m) => MARKET_NAMES[m] ?? m).join(', ')}.</p>
        {readOnly ? null : (
          <fieldset className={dcls('fieldset')}>
            <legend className={dcls('legend')}>Markets</legend>
            {KNOWN_MARKETS.map((m) => (
              <Check
                key={m}
                label={m === 'IN' ? 'India (IN): always included, Revised Schedule M' : m === 'US' ? 'United States (US)' : 'European Union (EU)'}
                checked={h.marketSet.includes(m)}
                disabled={m === 'IN'}
                onChange={(on) => dispatch({ kind: 'SET_MARKETS', markets: on ? [...h.marketSet, m] : h.marketSet.filter((x) => x !== m) })}
              />
            ))}
          </fieldset>
        )}
        {predicates.length > 0 ? (
          <table className={dcls('grid')} aria-label="Market predicates">
            <thead>
              <tr>
                <th scope="col">Predicate the market engine resolves the content minima with</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {predicates.map(([k, x]) => (
                <tr key={k}>
                  <td className={dcls('mono')}>{k}</td>
                  <td>{typeof x === 'boolean' ? yesNo(x) : x}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={dcls('small')}>No market predicates are set: the market engine resolves the content minima from the market set alone.</p>
        )}
        {h.variants.length > 0 ? (
          <ul className={dcls('list')} aria-label="Issue-time variants">
            {h.variants.map((x) => (
              <li key={x.id} id={`mbr-item-${x.id}`} tabIndex={-1}>
                Variant {x.id}: {x.values.join(', ')}
              </li>
            ))}
          </ul>
        ) : (
          <p className={dcls('small')}>No issue-time variants.</p>
        )}
      </Section>

      <Section id="3">
        <p className={dcls('small')}>Every reference is pinned by version and hash; the reference documents come from a DEMO-ONLY stand-in for the document-management system.</p>
        <table className={dcls('grid')} aria-label="References">
          <thead>
            <tr>
              <th scope="col">Id</th>
              <th scope="col">Kind</th>
              <th scope="col">Document</th>
              <th scope="col">Hash</th>
            </tr>
          </thead>
          <tbody>
            {c.references.map((r) => (
              <tr key={r.id} id={`mbr-item-${r.id}`} tabIndex={-1}>
                <td className={dcls('mono')}>{r.id}</td>
                <td>{humanize(r.kind)}</td>
                <td>
                  {r.code} v{r.version}
                  {r.title ? `: ${r.title}` : ''}
                </td>
                <td className={dcls('mono')}>{r.hash ?? 'not pinned'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {(c.blockDefinitions ?? []).length > 0 ? (
        // Decision 0026 S9: the library blocks this master carries, each pinned by its content hash.
        <table className={dcls('grid')} aria-label="Library blocks carried" data-testid="library-blocks-carried">
          <thead>
            <tr>
              <th scope="col">Library block</th>
              <th scope="col">Title</th>
              <th scope="col">Content hash</th>
            </tr>
          </thead>
          <tbody>
            {library.definitionsOf(c).map((d) => (
              <tr key={`${d.code}@${String(d.version)}`}>
                <td className={dcls('mono')}>
                  {d.code} v{String(d.version)}
                </td>
                <td>{d.title}</td>
                <td className={dcls('mono')}>{library.definitionHash(d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <Section id="4">
        <table className={dcls('grid')} aria-label="Bill of materials">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Material</th>
              <th scope="col">Role</th>
              <th scope="col">Standard quantity</th>
              <th scope="col">Approved specimen</th>
            </tr>
          </thead>
          <tbody>
            {c.bom.map((b) => (
              <tr key={b.id} id={`mbr-item-${b.id}`} tabIndex={-1}>
                <td className={dcls('mono')}>{b.id}</td>
                <td>{referenceLabel(c, b.material)}</td>
                <td>{flow.bomShellsLabel(b.role, h.product.dosageForm) ?? humanize(b.role)}</td>
                <td>
                  {quantityWords(b.quantity)}
                  {b.overage ? (
                    <span data-testid={`bom-overage-${b.id}`}>
                      {' '}
                      (includes an overage of {b.overage.percent !== undefined ? `${b.overage.percent} %` : b.overage.quantity ? `${quantityWords(b.overage.quantity)} ${b.overage.quantity.unit === 'mg' ? 'per unit' : 'per batch'}` : ''}: {b.overage.reason})
                    </span>
                  ) : null}
                </td>
                <td>{b.specimen ? referenceLabel(c, b.specimen) : b.role === 'PRINTED_COMPONENT' ? 'missing (a printed component needs one)' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="5">
        {stages.map((s) => (
          <div key={s.id} data-node={s.id}>
            <h3 className={dcls('panelTitle')}>
              Stage {numbering.byId.get(s.id)?.number}: {s.name}
            </h3>
            <p>
              Rooms: {s.binding.rooms.join(', ') || '—'}
              {s.binding.line ? ` · line ${s.binding.line}` : ''} · responsible: {roleTitle(s.responsibleRole)} · {s.purpose === 'MATERIAL' ? 'material stage' : 'non-material stage (moves no material)'}
            </p>
            <ul className={dcls('list')}>
              {s.binding.equipment.map((e) => (
                <li key={e.ref}>
                  {e.ref}: {referenceLabel(c, e.equipmentClass)} ({e.kind.toLowerCase()})
                </li>
              ))}
            </ul>
            {!readOnly && c.procedure.body.kind === 'sequence' && c.procedure.body.children.includes(s) ? (
              <StageEditor stage={s} first={stages[0]?.id === s.id} last={stages[stages.length - 1]?.id === s.id} dispatch={dispatch} />
            ) : null}
          </div>
        ))}
        {!readOnly ? <AddStage content={c} stages={stages} palette={props.palette} dispatch={dispatch} /> : null}
      </Section>

      <Section id="6">
        <Parameters c={c} dispatch={dispatch} readOnly={readOnly} />
        <h3 className={dcls('panelTitle')}>Acceptance schemes</h3>
        <AcceptanceSchemes c={c} />
      </Section>

      <Section id="7">
        <Calculations c={c} dispatch={dispatch} readOnly={readOnly} />
      </Section>

      <Section id="8">
        <p>
          Procedure {c.procedure.name} <span className={dcls('mono')}>{c.procedure.id}</span>
        </p>
        {numberingProblem ? <p role="alert">This procedure cannot be numbered in full: {numberingProblem}</p> : null}
        <ProcedureTable
          content={c}
          numbering={numbering}
          palette={props.palette}
          selected={props.selected}
          onSelect={props.onSelect}
          dispatch={dispatch}
          readOnly={readOnly}
          findingsByNode={props.findingsByNode}
        />
      </Section>

      <Section id="9">
        <h3 className={dcls('panelTitle')}>Hold times of intermediates</h3>
        {c.intermediates.map((i) => (
          <div key={i.id} id={`mbr-item-${i.id}`} tabIndex={-1}>
            <div className={dcls('inline')}>
              <strong>{i.name}</strong>
              <span className={dcls('mono')}>{i.id}</span>
              {i.holdTime && !readOnly ? (
                <CommitDecimal
                  label={`Maximum hold of ${i.name}`}
                  unit={i.holdTime.max.unit}
                  value={i.holdTime.max.value}
                  allowEmpty={false}
                  readOnly={false}
                  onCommit={(value) => value !== null && dispatch({ kind: 'SET_HOLD_TIME', intermediateId: i.id, value })}
                />
              ) : null}
            </div>
            {i.holdTime ? (
              <p className={dcls('small')}>
                Held {timeBoundWords('max', i.holdTime.max)} from the end of the producing step to the start of each using step · source {sourceWords(i.holdTime.source)} · storage {i.holdTime.storage ?? 'not stated'}
              </p>
            ) : (
              <p className={dcls('small')}>No hold time.</p>
            )}
            {i.finalOutput !== undefined ? <p className={dcls('small')}>{i.finalOutput ? 'Final output: it leaves this record (no step here uses it).' : 'Not a final output: a step of this record uses it.'}</p> : null}
          </div>
        ))}
        <h3 className={dcls('panelTitle')}>Time constraints</h3>
        <table className={dcls('grid')} aria-label="Time constraints">
          <thead>
            <tr>
              <th scope="col">Constraint</th>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Minimum</th>
              <th scope="col">Maximum</th>
              <th scope="col">Breach and warning</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {c.timeConstraints.map((t) => (
              <tr key={t.id} id={`mbr-item-${t.id}`} tabIndex={-1}>
                <td>
                  {t.name} <span className={dcls('mono')}>{t.id}</span> <span className={dcls('small')}>({humanize(t.kind)})</span>
                </td>
                <td>{eventWords(numbering, t.from)}</td>
                <td>{eventWords(numbering, t.to)}</td>
                {(['min', 'max'] as const).map((side) => (
                  <td key={side}>
                    {readOnly ? (
                      timeBoundWords(side, t[side])
                    ) : (
                      <>
                        <span className={dcls('small')}>{side === 'min' ? 'at least' : 'at most'}</span>
                        <CommitDecimal
                          label={`${t.name}, ${side === 'min' ? 'minimum' : 'maximum'}`}
                          unit={t[side]?.unit ?? t.max?.unit ?? t.min?.unit ?? 'min'}
                          value={t[side]?.value}
                          readOnly={false}
                          onCommit={(value) => dispatch({ kind: 'SET_TIME_BOUND', constraintId: t.id, side, value })}
                        />
                      </>
                    )}
                  </td>
                ))}
                <td>
                  <ul className={dcls('list')}>
                    <li>{t.breach === 'EXCEPTION_AND_BLOCK' ? 'Beyond the maximum: exception and block (the step and everything after it stop)' : 'Beyond the maximum: exception (the step goes on)'}</li>
                    <li>{t.warnBefore ? `Warning ${quantityWords(t.warnBefore)} before the maximum` : 'No early warning'}</li>
                    <li>{t.pauses === 'INCLUDED' ? 'Pauses included (paused time counts)' : 'Pauses excluded (paused time does not count)'}</li>
                    {t.marketRule ? <li>Maximum {marketRuleWords(t.marketRule)}</li> : null}
                  </ul>
                </td>
                <td>{t.source ? sourceWords(t.source) : 'none'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="10">
        {c.yieldCheckpoints.map((y) => (
          <div key={y.id} id={`mbr-item-${y.id}`} tabIndex={-1}>
            <h3 className={dcls('panelTitle')}>
              {y.name} <span className={dcls('mono')}>{y.id}</span> <span className={dcls('small')}>({y.kind.toLowerCase()}, basis {humanize(y.basis)})</span>
            </h3>
            <p className={dcls('small')}>
              Result {itemLabel(c, y.result)} against the theoretical {itemLabel(c, y.theoretical)}
            </p>
            {y.limits ? <LimitsTable owner="yield" id={y.id} name={y.name} spec={y.limits} dispatch={dispatch} readOnly={readOnly} /> : <p>No limits.</p>}
          </div>
        ))}
      </Section>

      <Section id="11">
        <p>
          Risk scale {referenceLabel(c, c.riskScale.ref)}: {c.riskScale.classes.join(' < ')}
        </p>
        {c.riskReductions.length > 0 ? (
          <ul className={dcls('list')}>
            {c.riskReductions.map((r) => (
              <li key={r.id} id={`mbr-item-${r.id}`} tabIndex={-1}>
                {r.id}: {humanize(r.kind)} for {r.subjects.join(', ')} · risk class {r.riskClass ?? 'missing'} · rationale {r.rationale ? referenceLabel(c, r.rationale) : 'missing'}
              </li>
            ))}
          </ul>
        ) : (
          <p className={dcls('small')}>No risk-based reductions: every control applies in full.</p>
        )}
        <h3 className={dcls('panelTitle')}>Golden test cases</h3>
        {c.goldenCases.map((g) => (
          <div key={g.id} id={`mbr-item-${g.id}`} tabIndex={-1}>
            <p>
              <span className={dcls('mono')}>{g.id}</span>: {g.description}
            </p>
            <table className={dcls('grid')} aria-label={`Golden case ${g.id}`}>
              <thead>
                <tr>
                  <th scope="col">Given (input)</th>
                  <th scope="col">Value</th>
                  <th scope="col">Expected (result)</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.max(Object.keys(g.inputs).length, Object.keys(g.expected).length) }, (_, i) => {
                  const input = Object.entries(g.inputs)[i];
                  const expected = Object.entries(g.expected)[i];
                  return (
                    <tr key={i}>
                      <td>{input ? itemLabel(c, input[0]) : ''}</td>
                      <td>{input ? goldenValueText(input[1]) : ''}</td>
                      <td>{expected ? itemLabel(c, expected[0]) : ''}</td>
                      <td>{expected ? goldenValueText(expected[1]) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </Section>
    </div>
  );
}
