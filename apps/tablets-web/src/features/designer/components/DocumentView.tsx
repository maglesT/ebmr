/**
 * The document-first view of an MBR version (module C2; plan section 8): sections 0-11 in the order of a paper batch
 * record. The approved batch sizes, product and references are the family's and read-only here; limits, targets,
 * time bounds and hold times are edited in place with DecimalField (text, never a number); the procedure is edited
 * through its rows (ProcedureTable) and the step properties panel.
 */
import type { ReactNode } from 'react';
import { flow } from '@ebmr/recipe-core/pure';
import type { VersionView } from '@ebmr/api-contract';
import { dcls } from '../classes.ts';
import { KNOWN_MARKETS, type Content, type Op } from '../model/ops.ts';
import { DOCUMENT_SECTIONS, sectionId } from '../model/sections.ts';
import type { FindingItem, PaletteItem } from '../model/types.ts';
import { Check, CommitDecimal, CommitText, roleTitle, shortHash } from './common.tsx';
import { ProcedureTable } from './ProcedureTable.tsx';

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

function LimitsTable({ owner, id, name, spec, dispatch, readOnly }: { owner: 'parameter' | 'calculation' | 'yield'; id: string; name: string; spec: flow.LimitSpec; dispatch: (op: Op) => boolean; readOnly: boolean }) {
  return (
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
                <CommitDecimal
                  label={`${name}, ${tierLabel(r.tier)}, ${side === 'low' ? 'lower' : 'upper'} limit${r[side] && !r[side].inclusive ? ' (exclusive)' : ''}`}
                  unit={spec.unit}
                  value={r[side]?.value}
                  readOnly={readOnly}
                  onCommit={(value) => dispatch({ kind: 'SET_LIMIT_BOUND', owner, id, tier: r.tier, side, value })}
                />
              </td>
            ))}
            <td>
              {r.source.kind.toLowerCase().replace('_', ' ')} {r.source.ref}
              {r.pharmacopoeia ? ` (${r.pharmacopoeia.code} ${r.pharmacopoeia.edition})` : ''}
            </td>
            <td className={dcls('small')}>{r.rounding === 'USP_HALF_UP_AT_LIMIT_DECIMALS' ? 'USP, half up at the limit decimals' : 'Ph. Eur., significant figures'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function eventLabel(numbering: flow.MbrNumbering, e: flow.EventRef): string {
  if (!flow.isNodeEvent(e)) return `${e.description} (outside this record)`;
  const n = numbering.byId.get(e.node);
  return `${e.event === 'START' ? 'start' : 'end'} of ${n ? `${n.number} ${n.name}` : e.node}`;
}

export function DocumentView(props: DocumentProps) {
  const { content: c, version: v, dispatch, readOnly } = props;
  const numbering = flow.numberMbr(c);
  const h = c.header;
  const stages: flow.StageNode[] = [];
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'stage') stages.push(n);
  });

  return (
    <div className={dcls('document')}>
      <Section id="0">
        <CommitText label="Title" value={h.title} readOnly={readOnly} onCommit={(title) => dispatch({ kind: 'SET_TITLE', title })} />
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
          <dt>Content hash</dt>
          <dd className={dcls('mono')}>{shortHash(v.contentHash)} (saved revision)</dd>
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
              <tr key={b.id}>
                <td>
                  {b.id}
                  {i === 0 ? ' (reference for the BOM)' : ''}
                </td>
                <td>
                  {b.quantity.value} {b.quantity.unit}
                </td>
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
                <tr key={i.id}>
                  <td>
                    {i.name} <span className={dcls('mono')}>{i.id}</span>
                  </td>
                  <td>
                    {i.valueType.toLowerCase()}
                    {i.unit ? ` (${i.unit})` : ''}
                  </td>
                  <td>{i.source === 'BATCH_HEADER' ? 'batch header' : `master data${i.ref ? ` ${i.ref}` : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>

      <Section id="2">
        <fieldset className={dcls('fieldset')}>
          <legend className={dcls('legend')}>Markets</legend>
          {KNOWN_MARKETS.map((m) => (
            <Check
              key={m}
              label={m === 'IN' ? 'India (IN): always included, Revised Schedule M' : m === 'US' ? 'United States (US)' : 'European Union (EU)'}
              checked={h.marketSet.includes(m)}
              disabled={readOnly || m === 'IN'}
              onChange={(on) => dispatch({ kind: 'SET_MARKETS', markets: on ? [...h.marketSet, m] : h.marketSet.filter((x) => x !== m) })}
            />
          ))}
        </fieldset>
        {h.variants.length > 0 ? <p>Variants: {h.variants.map((x) => `${x.id} (${x.values.join(', ')})`).join('; ')}</p> : <p className={dcls('small')}>No issue-time variants.</p>}
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
              <tr key={r.id}>
                <td className={dcls('mono')}>{r.id}</td>
                <td>{r.kind.toLowerCase().replace(/_/g, ' ')}</td>
                <td>
                  {r.code} v{r.version}
                  {r.title ? `: ${r.title}` : ''}
                </td>
                <td className={dcls('mono')}>{r.hash ? shortHash(r.hash) : 'not pinned'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="4">
        <table className={dcls('grid')} aria-label="Bill of materials">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Material</th>
              <th scope="col">Role</th>
              <th scope="col">Standard quantity</th>
            </tr>
          </thead>
          <tbody>
            {c.bom.map((b) => (
              <tr key={b.id}>
                <td className={dcls('mono')}>{b.id}</td>
                <td>{c.references.find((r) => r.id === b.material)?.title ?? b.material}</td>
                <td>{b.role.toLowerCase().replace(/_/g, ' ')}</td>
                <td>
                  {b.quantity.value} {b.quantity.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="5">
        {stages.map((s) => (
          <div key={s.id}>
            <h3 className={dcls('panelTitle')}>
              Stage {numbering.byId.get(s.id)?.number}: {s.name}
            </h3>
            <p>
              Rooms: {s.binding.rooms.join(', ') || '—'}
              {s.binding.line ? ` · line ${s.binding.line}` : ''} · responsible: {roleTitle(s.responsibleRole)}
            </p>
            <ul className={dcls('list')}>
              {s.binding.equipment.map((e) => (
                <li key={e.ref}>
                  {e.ref}: {c.references.find((r) => r.id === e.equipmentClass)?.title ?? e.equipmentClass} ({e.kind.toLowerCase()})
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>

      <Section id="6">
        {c.parameters.map((p) => (
          <div key={p.id} id={`mbr-item-${p.id}`}>
            <h3 className={dcls('panelTitle')}>
              {p.name} <span className={dcls('mono')}>{p.id}</span>
            </h3>
            <p className={dcls('small')}>
              {p.valueType.toLowerCase()}
              {p.unit ? `, ${p.unit}` : ''}
              {p.precision ? `, ${p.precision.digits} ${p.precision.kind === 'DECIMALS' ? 'decimals' : 'significant figures'}` : ''} · {p.role.toLowerCase().replace(/_/g, ' ')} · {p.criticality.toLowerCase().replace('_', '-')} · captured{' '}
              {p.capture.toLowerCase()}
              {p.evidence && p.evidence !== 'NONE' ? ` with ${p.evidence.toLowerCase()}` : ''}
              {p.accuracyCheck ? ` · accuracy check: ${p.accuracyCheck.toLowerCase().replace('_', ' ')}` : ''}
            </p>
            {p.valueType === 'DECIMAL' ? (
              <CommitDecimal label={`Target of ${p.name}`} unit={p.unit ?? ''} value={p.target} readOnly={readOnly} onCommit={(value) => dispatch({ kind: 'SET_TARGET', parameterId: p.id, value })} />
            ) : null}
            {p.limits ? <LimitsTable owner="parameter" id={p.id} name={p.name} spec={p.limits} dispatch={dispatch} readOnly={readOnly} /> : <p className={dcls('small')}>No limits.</p>}
          </div>
        ))}
      </Section>

      <Section id="7">
        <table className={dcls('grid')} aria-label="Calculations">
          <thead>
            <tr>
              <th scope="col">Calculation</th>
              <th scope="col">Formula</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {c.calculations.map((x) => (
              <tr key={x.id} id={`mbr-item-${x.id}`}>
                <td>
                  {x.name} <span className={dcls('mono')}>{x.id}</span>
                </td>
                <td className={dcls('mono')}>{x.expression}</td>
                <td>
                  {x.output.valueType.toLowerCase()}
                  {x.output.unit ? ` in ${x.output.unit}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={dcls('small')}>Calculations are read-only in this release (the formula editor comes next).</p>
      </Section>

      <Section id="8">
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
          <div key={i.id} id={`mbr-item-${i.id}`} className={dcls('inline')}>
            <strong>{i.name}</strong>
            {i.holdTime ? (
              <CommitDecimal
                label={`Maximum hold of ${i.name}`}
                unit={i.holdTime.max.unit}
                value={i.holdTime.max.value}
                allowEmpty={false}
                readOnly={readOnly}
                onCommit={(value) => value !== null && dispatch({ kind: 'SET_HOLD_TIME', intermediateId: i.id, value })}
              />
            ) : (
              <span>no hold time</span>
            )}
            {i.holdTime ? (
              <span className={dcls('small')}>
                source {i.holdTime.source.kind.toLowerCase().replace('_', ' ')} {i.holdTime.source.ref}
              </span>
            ) : null}
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
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {c.timeConstraints.map((t) => (
              <tr key={t.id} id={`mbr-item-${t.id}`}>
                <td>
                  {t.name} <span className={dcls('small')}>({t.kind.toLowerCase().replace('_', ' ')})</span>
                </td>
                <td>{eventLabel(numbering, t.from)}</td>
                <td>{eventLabel(numbering, t.to)}</td>
                {(['min', 'max'] as const).map((side) => (
                  <td key={side}>
                    <CommitDecimal
                      label={`${t.name}, ${side === 'min' ? 'minimum' : 'maximum'}`}
                      unit={t[side]?.unit ?? t.max?.unit ?? t.min?.unit ?? 'min'}
                      value={t[side]?.value}
                      readOnly={readOnly}
                      onCommit={(value) => dispatch({ kind: 'SET_TIME_BOUND', constraintId: t.id, side, value })}
                    />
                  </td>
                ))}
                <td>{t.source ? `${t.source.kind.toLowerCase().replace('_', ' ')} ${t.source.ref}` : 'none'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="10">
        {c.yieldCheckpoints.map((y) => (
          <div key={y.id} id={`mbr-item-${y.id}`}>
            <h3 className={dcls('panelTitle')}>
              {y.name} <span className={dcls('small')}>({y.kind.toLowerCase()}, basis {y.basis.toLowerCase().replace('_', ' ')})</span>
            </h3>
            <p className={dcls('small')}>
              Result {y.result} against {y.theoretical}
            </p>
            {y.limits ? <LimitsTable owner="yield" id={y.id} name={y.name} spec={y.limits} dispatch={dispatch} readOnly={readOnly} /> : <p>No limits.</p>}
          </div>
        ))}
      </Section>

      <Section id="11">
        <p>
          Risk scale {c.riskScale.ref}: {c.riskScale.classes.join(' < ')}
        </p>
        {c.riskReductions.length > 0 ? (
          <ul className={dcls('list')}>
            {c.riskReductions.map((r) => (
              <li key={r.id} id={`mbr-item-${r.id}`}>
                {r.id}: {r.kind.toLowerCase().replace(/_/g, ' ')} for {r.subjects.join(', ')} · risk class {r.riskClass ?? 'missing'} · rationale {r.rationale ?? 'missing'}
              </li>
            ))}
          </ul>
        ) : (
          <p className={dcls('small')}>No risk-based reductions: every control applies in full.</p>
        )}
        <h3 className={dcls('panelTitle')}>Golden test cases</h3>
        <ul className={dcls('list')}>
          {c.goldenCases.map((g) => (
            <li key={g.id} id={`mbr-item-${g.id}`}>
              {g.id}: {g.description}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
