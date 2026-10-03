/**
 * Step properties (module C2): the row editor of the selected step. Name, the configuration form generated from the
 * block schema, who performs and who checks (engine role vocabulary), significance, risk class, and what the step
 * records, computes, reads, consumes, produces and which stage equipment it checks or uses. Each change is one
 * undoable operation; the findings panel re-validates.
 */
import { ENGINE_ROLES } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core/pure';
import { Banner, StatusChip } from '@ebmr/ui-kit';
import { dcls } from '../classes.ts';
import type { Content, Op } from '../model/ops.ts';
import type { PaletteItem } from '../model/types.ts';
import { Check, CheckList, CommitText, roleTitle, Select, type Option } from './common.tsx';
import { ConfigForm } from './ConfigForm.tsx';
import { ConfigList } from './ConfigView.tsx';

const roleOptions: Option[] = ENGINE_ROLES.map((r) => ({ value: r, label: roleTitle(r) }));

function stageOf(c: Content, id: string): flow.StageNode | undefined {
  let found: flow.StageNode | undefined;
  flow.walk(c.procedure.body, (n, ancestors) => {
    if (n.id === id) found = [...ancestors].reverse().find((a): a is flow.StageNode => a.kind === 'stage');
  });
  return found;
}

export function StepEditor({ content, stepId, number, palette, readOnly, dispatch }: { content: Content; stepId: string; number: string; palette: readonly PaletteItem[]; readOnly: boolean; dispatch: (op: Op) => void }) {
  let node: flow.FlowNode | undefined;
  flow.walk(content.procedure.body, (n) => {
    if (n.id === stepId) node = n;
  });
  if (!node || (node.kind !== 'phase' && node.kind !== 'holdPoint')) return <p>Select a step in the procedure to see its properties.</p>;

  if (node.kind === 'holdPoint') {
    const h = node;
    return (
      <div className={dcls('stack')}>
        <h3 className={dcls('panelTitle')}>
          Step {number}: QA hold point
        </h3>
        <CommitText label="Name" value={h.name} readOnly={readOnly} onCommit={(v) => dispatch({ kind: 'UPDATE_HOLD', nodeId: h.id, patch: { name: v } })} />
        <Select label="Released by" value={h.role} disabled={readOnly} options={roleOptions} onChange={(v) => dispatch({ kind: 'UPDATE_HOLD', nodeId: h.id, patch: { role: v } })} />
        <p className={dcls('small')}>Dispositions: {h.dispositions.join(', ')}. Everything after the hold point waits for the release.</p>
      </div>
    );
  }

  const p = node;
  const key = `${p.block.type}@${p.block.version}`;
  const block = palette.find((b) => b.key === key);
  const stage = stageOf(content, p.id);
  const update = (patch: Extract<Op, { kind: 'UPDATE_PHASE' }>['patch']): void => dispatch({ kind: 'UPDATE_PHASE', nodeId: p.id, patch });
  const sopOptions: Option[] = content.references.filter((r) => r.kind === 'SOP').map((r) => ({ value: r.id, label: `${r.code} v${r.version}${r.title ? `: ${r.title}` : ''}` }));
  const check = p.signatures.check;
  const checkValue = check ? check.meaning : 'NONE';
  const params: Option[] = content.parameters.map((x) => ({ value: x.id, label: `${x.name}${x.unit ? ` (${x.unit})` : ''}` }));
  const calcs: Option[] = content.calculations.map((x) => ({ value: x.id, label: x.name }));
  const readable: Option[] = [...params, ...calcs, ...content.inputs.map((x) => ({ value: x.id, label: `${x.name} (input)` }))];
  const bom: Option[] = content.bom.map((b) => ({ value: b.id, label: `${b.id}: ${content.references.find((r) => r.id === b.material)?.title ?? b.material}` }));
  const intermediates: Option[] = content.intermediates.map((i) => ({ value: i.id, label: i.name }));
  const equipment = stage?.binding.equipment ?? [];
  const uses = (ref: string, use: 'STATUS_CHECK' | 'USE'): boolean => p.equipment.some((e) => e.ref === ref && e.use === use);
  const setEquipment = (ref: string, use: 'STATUS_CHECK' | 'USE', on: boolean): void => {
    const others = p.equipment.filter((e) => !(e.ref === ref && e.use === use));
    const next = on ? [...others, { ref, use }] : others;
    const order = (e: { ref: string; use: string }): string => `${equipment.findIndex((x) => x.ref === e.ref)}:${e.use === 'STATUS_CHECK' ? 0 : 1}`;
    update({ equipment: next.sort((a, b) => (order(a) < order(b) ? -1 : 1)) });
  };

  return (
    <div className={dcls('stack')}>
      <h3 className={dcls('panelTitle')}>
        Step {number}: {block?.plainName ?? key}
      </h3>
      <div className={dcls('inline')}>
        <span className={dcls('mono')}>{key}</span>
        {block?.badge ? <StatusChip tone="test" label={block.badge} /> : null}
        {block?.significant ? <StatusChip tone="info" label="Significant step" /> : null}
      </div>
      {block?.availability === 'SANDBOX_ONLY' ? (
        <Banner tone="info" title="This block version runs in sandbox test runs only.">
          A GMP batch refuses it until its database-backed version arrives in Phase 3.
        </Banner>
      ) : null}
      <CommitText label="Step name (as the operator sees it)" value={p.name} readOnly={readOnly} onCommit={(v) => update({ name: v })} />
      <h4>Configuration</h4>
      {block ? (
        <ConfigForm schema={block.configSchema} value={p.config} readOnly={readOnly} sopOptions={sopOptions} onChange={(config) => update({ config })} />
      ) : (
        <>
          <p className={dcls('small')}>The block {key} is not in the palette of this installation; its configuration is shown as saved.</p>
          <ConfigList config={p.config} label={`Configuration of step ${number}`} />
        </>
      )}
      <h4>Who performs and who checks</h4>
      <Select
        label="Done by"
        value={p.signatures.perform?.role ?? ''}
        disabled={readOnly}
        options={[{ value: '', label: '— (automated step, one human verifier)' }, ...roleOptions]}
        onChange={(v) => update({ signatures: { ...(v ? { perform: { role: v } } : {}), ...(check ? { check } : {}) } })}
      />
      <Select
        label="Second person"
        value={checkValue}
        disabled={readOnly}
        options={[
          { value: 'NONE', label: 'None' },
          { value: 'VERIFIED', label: 'Verified (reviews the recorded evidence)' },
          { value: 'WITNESSED', label: 'Witnessed (watches the act)' },
        ]}
        onChange={(v) =>
          update({
            signatures: {
              ...(p.signatures.perform ? { perform: p.signatures.perform } : {}),
              ...(v === 'NONE' ? {} : { check: { meaning: v as flow.CheckMeaning, role: check?.role ?? 'PRODUCTION_VERIFIER' } }),
            },
          })
        }
      />
      {check ? (
        <Select
          label="Checked by"
          value={check.role}
          disabled={readOnly}
          options={roleOptions}
          onChange={(v) => update({ signatures: { ...(p.signatures.perform ? { perform: p.signatures.perform } : {}), check: { meaning: check.meaning, role: v } } })}
        />
      ) : null}
      <Check label="Significant step (performer and an independent checker)" checked={p.significant} disabled={readOnly} onChange={(on) => update({ significant: on })} />
      <Select label="Risk class" value={p.riskClass} disabled={readOnly} options={content.riskScale.classes.map((c) => ({ value: c, label: c }))} onChange={(v) => update({ riskClass: v })} />
      <h4>Data, materials and equipment</h4>
      <CheckList legend="Records (parameters entered or captured here)" items={params} selected={p.records} disabled={readOnly} onChange={(v) => update({ records: v })} />
      <CheckList legend="Computes (calculations, in this order)" items={calcs} selected={p.computes} disabled={readOnly} onChange={(v) => update({ computes: v })} />
      <CheckList legend="Reads (targets and values shown)" items={readable} selected={p.reads} disabled={readOnly} onChange={(v) => update({ reads: v })} />
      <CheckList legend="Consumes (BOM lines)" items={bom} selected={p.consumes} disabled={readOnly} onChange={(v) => update({ consumes: v })} />
      <CheckList legend="Produces (intermediates)" items={intermediates} selected={p.produces} disabled={readOnly} onChange={(v) => update({ produces: v })} />
      <CheckList legend="Uses (intermediates)" items={intermediates} selected={p.uses} disabled={readOnly} onChange={(v) => update({ uses: v })} />
      {equipment.length > 0 ? (
        <fieldset className={dcls('fieldset')}>
          <legend className={dcls('legend')}>Stage equipment</legend>
          {equipment.map((e) => (
            <div key={e.ref} className={dcls('inline')}>
              <strong>{e.ref}</strong>
              <span className={dcls('small')}>{e.kind.toLowerCase()}</span>
              <Check label="checks its status" checked={uses(e.ref, 'STATUS_CHECK')} disabled={readOnly} onChange={(on) => setEquipment(e.ref, 'STATUS_CHECK', on)} />
              <Check label="uses it" checked={uses(e.ref, 'USE')} disabled={readOnly} onChange={(on) => setEquipment(e.ref, 'USE', on)} />
            </div>
          ))}
        </fieldset>
      ) : null}
      {p.system ? (
        <p className={dcls('small')}>
          Computerised system: {p.system.kind.toLowerCase()} {p.system.ref}
          {p.system.recipe !== undefined ? `, recipe ${p.system.recipe}` : ''}
          {p.system.recipeVersion !== undefined ? ` version ${p.system.recipeVersion}` : ''}
        </p>
      ) : null}
    </div>
  );
}
