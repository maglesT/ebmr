/**
 * Section 8, the numbered procedure (module C2; plan section 8): stage -> operation -> step rows with No.,
 * Instruction, Records, Done by and Checked by, like a paper batch record. Constructs (parallel, alternative, loop,
 * replicate, library call) are read-only labelled boxes around their steps in A1. A construct row states the rules
 * that decide the route (an alternative's conditions, "otherwise" branch, variant values or the roles allowed to
 * choose; a loop's exit and endpoint; a replicate's count and sub-lot prefix), and each branch body follows its own
 * branch row (review F45). A library call shows its bindings and the element's steps under their expanded,
 * numbered ids, read-only (review F46).
 *
 * Editing without drag, by menu or keyboard on a focused step row:
 *   Enter or Space  open the step's properties        Arrow Up / Down        previous / next step
 *   Alt+Arrow Up / Down  move the step in its sequence  Delete                 delete the step (undo brings it back)
 *   Insert or +     insert a step after this one      Ctrl+Z / Ctrl+Y        undo / redo (whole designer)
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import type { flow } from '@ebmr/recipe-core/pure';
import { Button, Dialog, StatusChip } from '@ebmr/ui-kit';
import { dcls } from '../classes.ts';
import { insertionPoint, newStep, type Content, type Op } from '../model/ops.ts';
import type { FindingItem, PaletteItem } from '../model/types.ts';
import { roleTitle } from './common.tsx';
import { blockDefaults, ConfigList } from './ConfigView.tsx';
import { checkWords, humanize, itemLabel, referenceLabel, samplingWords } from './words.ts';

export const rowId = (nodeId: string): string => `mbr-node-${nodeId}`;

const PLAIN: Readonly<Record<string, string>> = {};

/**
 * What a step's row says besides its name and records (review F44): significance and risk class, what it reads and
 * uses, its equipment, yield checkpoint, acceptance scheme and sampling, the computerised system with its recipe, PAT
 * and reprocessing. The checker's document carries them, not only the properties panel of a selected step.
 */
function phaseFacts(c: Content, n: flow.PhaseNode): string[] {
  const out: string[] = [`${n.significant ? 'Significant step (performer and an independent checker)' : 'Not significant'} · risk class ${n.riskClass}`];
  if (n.reads.length > 0) out.push(`Reads ${n.reads.map((r) => itemLabel(c, r)).join(', ')}`);
  for (const e of n.equipment) out.push(`Equipment ${e.ref}: ${e.use === 'STATUS_CHECK' ? 'checks its status (status check)' : 'uses it (use)'}`);
  if (n.yieldCheckpoint) out.push(`Yield checkpoint ${c.yieldCheckpoints.find((y) => y.id === n.yieldCheckpoint)?.name ?? ''} (${n.yieldCheckpoint})`);
  if (n.acceptanceScheme) out.push(`Acceptance scheme ${c.acceptanceSchemes.find((x) => x.id === n.acceptanceScheme)?.title ?? ''} (${n.acceptanceScheme})`);
  for (const x of n.sampling ?? []) out.push(`Sampling ${samplingWords(x)}`);
  if (n.system) {
    out.push(
      `Computerised system ${humanize(n.system.kind)} ${referenceLabel(c, n.system.ref)}${n.system.recipe !== undefined ? `, recipe ${n.system.recipe}` : ''}${n.system.recipeVersion !== undefined ? ` version ${n.system.recipeVersion}` : ''}`,
    );
  }
  if (n.pat) out.push(`PAT method ${n.pat.method}, model ${n.pat.model} version ${n.pat.modelVersion}${n.pat.acceptance !== undefined ? `, accepted when ${n.pat.acceptance}` : ''}`);
  if (n.reprocessing) {
    const r = n.reprocessing;
    out.push(
      `Reprocessing: ${humanize(r.case)}${r.maxPercent !== undefined ? `, at most ${r.maxPercent} %` : ''}${r.maxAge ? `, source at most ${r.maxAge.value} ${r.maxAge.unit} old` : ''}${r.maxSourceBatches !== undefined ? `, at most ${r.maxSourceBatches} source batches` : ''}`,
    );
  }
  return out;
}

/** How an alternative's branch is chosen (review F45): the decision, with the roles allowed to choose. */
function decisionWords(n: flow.AlternativeNode): string {
  const d = n.decision;
  if (d.mode === 'OPERATOR_CHOICE') return `Alternative chosen by an authorised person, with a reason: ${d.roles.map(roleTitle).join(' or ')} may choose`;
  if (d.mode === 'ISSUE_VARIANT') return `Alternative fixed at issue by variant ${d.variant}`;
  const otherwise = n.branches.find((b) => b.otherwise === true);
  return `Alternative decided by recorded data: the branch whose condition holds is taken${otherwise ? `, or "${otherwise.name}" (otherwise) when none holds` : ''}; when more than one holds${otherwise ? '' : ', or none'}, the batch stops for a decision`;
}

/** When one branch of an alternative is taken: its condition, "otherwise", its variant values, or the person's choice. */
function branchRule(n: flow.AlternativeNode, b: flow.AlternativeBranch): string {
  const d = n.decision;
  const rule =
    d.mode === 'DATA'
      ? b.otherwise === true
        ? 'otherwise (taken when no other condition holds)'
        : `taken when ${b.guard ?? '(no condition)'}`
      : d.mode === 'ISSUE_VARIANT'
        ? `taken when variant ${d.variant} is ${(b.variantValues ?? []).join(' or ') || '(no value)'}`
        : 'one of the choices';
  return `"${b.name}": ${rule}${b.body ? '' : ' · no action (no step)'}`;
}

/** The construct row of a parallel, alternative, loop or replicate section: the rules that decide the route. */
function constructWords(c: Content, n: flow.ParallelNode | flow.AlternativeNode | flow.LoopNode | flow.ReplicateNode): string {
  switch (n.kind) {
    case 'parallel':
      return `Parallel branches ${n.branches.map((b) => `"${b.name}"`).join(' and ')}: they run side by side, and the next step waits until every branch has finished`;
    case 'alternative':
      return `${decisionWords(n)}. Branches: ${n.branches.map((b) => branchRule(n, b)).join('; ')}`;
    case 'loop':
      return `Repeat "${n.name}" until ${n.exit.condition}, on the process endpoint ${itemLabel(c, n.exit.endpoint)}: at most ${n.maxIterations} times${n.maxDuration ? ` and at most ${n.maxDuration.value} ${n.maxDuration.unit}` : ''}; every repetition is kept, and running out is an exception`;
    case 'replicate': {
      const k = n.count;
      return `Per sub-lot "${n.name}": ${k.mode === 'EXPRESSION' ? `count from ${k.expression}` : 'count chosen at run time, with a reason'}, between ${k.min} and ${k.max}; ${n.instances === 'SEQUENTIAL' ? 'one after the other (sequential)' : 'they may overlap in time (concurrent)'}; sub-lots are named <batch number>-${n.subLotPrefix}1, -${n.subLotPrefix}2 and so on`;
    }
  }
}

/** A library call in words: the pinned element, its level and what each symbol is bound to (review F46). */
function callWords(c: Content, n: flow.LibraryCallNode, element: flow.LibraryElement | undefined, bind: (id: string) => string): string {
  const binds = Object.entries(n.bind).map(([symbol, item]) => `${symbol} bound to ${itemLabel(c, bind(item))}`);
  return `Library element ${referenceLabel(c, n.element)}${element ? `, ${humanize(element.level)} level, symbols ${element.symbols.join(', ') || 'none'}` : ''}${binds.length > 0 ? `: ${binds.join('; ')}` : ''}`;
}

/** A phase of a library element as the floor runs it: its symbols replaced by the items the call binds (expand.ts). */
function boundPhase(p: flow.PhaseNode, id: string, bind: (s: string) => string): flow.PhaseNode {
  const out: flow.PhaseNode = {
    ...p,
    id,
    records: p.records.map(bind),
    computes: p.computes.map(bind),
    reads: p.reads.map(bind),
    consumes: p.consumes.map(bind),
    produces: p.produces.map(bind),
    uses: p.uses.map(bind),
    equipment: p.equipment.map((e) => ({ ref: bind(e.ref), use: e.use })),
  };
  if (p.yieldCheckpoint !== undefined) out.yieldCheckpoint = bind(p.yieldCheckpoint);
  if (p.acceptanceScheme !== undefined) out.acceptanceScheme = bind(p.acceptanceScheme);
  return out;
}

/** Where a node is rendered: its id in the numbering (a library body's nodes under "call/inner"), and its binding. */
interface At {
  prefix: string;
  bind: (id: string) => string;
  calls: readonly string[];
}

const TOP: At = { prefix: '', bind: (id) => id, calls: [] };

export interface ProcedureProps {
  content: Content;
  numbering: flow.MbrNumbering;
  palette: readonly PaletteItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  dispatch: (op: Op) => boolean;
  readOnly: boolean;
  findingsByNode: ReadonlyMap<string, FindingItem[]>;
}

export function InsertDialog({ open, onClose, palette, onInsert }: { open: boolean; onClose: () => void; palette: readonly PaletteItem[]; onInsert: (block: PaletteItem) => void }) {
  return (
    <Dialog title="Insert a step" isOpen={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <p className={dcls('small')}>Choose what the new step does. Blocks marked "sandbox only" run in test runs until Phase 3. A product's own process steps are library blocks (Add a library block).</p>
      <ul className={dcls('list')} style={{ listStyle: 'none', padding: 0 }}>
        {palette.filter((b) => b.insertable).map((b) => (
          <li key={b.key} style={{ margin: '6px 0' }}>
            <Button onPress={() => onInsert(b)} className={dcls('paletteItem')} aria-label={`Insert ${b.plainName}`}>
              <span>
                <strong>{b.plainName}</strong> <span className={dcls('mono')}>{b.key}</span>
              </span>
              <span className={dcls('inline')}>
                {b.badge ? <StatusChip tone="test" label={b.badge} /> : null}
                {b.significant ? <span className={dcls('small')}>significant: needs a checker</span> : null}
                <span className={dcls('small')}>{b.title}</span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
      <Button onPress={onClose}>Cancel</Button>
    </Dialog>
  );
}

export function ProcedureTable({ content, numbering, palette, selected, onSelect, dispatch, readOnly, findingsByNode }: ProcedureProps) {
  const [insertAfter, setInsertAfter] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const focusRow = (id: string): void => {
    requestAnimationFrame(() => document.getElementById(rowId(id))?.focus());
  };
  const stepRows = (): HTMLElement[] => [...(tableRef.current?.querySelectorAll<HTMLElement>('[data-step-row]') ?? [])];

  const insert = (block: PaletteItem): void => {
    const after = insertAfter;
    setInsertAfter(null);
    if (!after) return;
    const at = insertionPoint(content, after);
    if (!at) return;
    const step = newStep(content, block);
    if (dispatch({ kind: 'INSERT_STEP', ...at, step })) {
      onSelect(step.id);
      focusRow(step.id);
    }
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, id: string): void => {
    if (e.target !== e.currentTarget) return;
    const rows = stepRows();
    const i = rows.findIndex((r) => r.id === rowId(id));
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.altKey) {
      e.preventDefault();
      if (!readOnly && dispatch({ kind: 'MOVE_STEP', nodeId: id, direction: e.key === 'ArrowUp' ? -1 : 1 })) focusRow(id);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
      return;
    }
    if (readOnly) return;
    if (e.key === 'Delete') {
      e.preventDefault();
      const next = rows[i + 1] ?? rows[i - 1];
      if (dispatch({ kind: 'DELETE_STEP', nodeId: id }) && next) next.focus();
      return;
    }
    if (e.key === 'Insert' || e.key === '+') {
      e.preventDefault();
      setInsertAfter(id);
    }
  };

  /**
   * The row of a step or hold point. A step of a library element (inLibrary) is shown under its expanded id
   * ("call/inner") with its number and bound items, read-only: the element is approved on its own and edited there.
   */
  const stepRow = (n: flow.PhaseNode | flow.HoldPointNode, inLibrary = false): ReactNode => {
    const num = numbering.byId.get(n.id)?.number ?? '?';
    const findings = findingsByNode.get(n.id) ?? [];
    const severity = findings.some((f) => f.severity === 'ERROR') ? 'ERROR' : findings.some((f) => f.severity === 'WARNING') ? 'WARNING' : undefined;
    const block = n.kind === 'phase' ? palette.find((b) => b.key === `${n.block.type}@${n.block.version}`) : palette.find((b) => b.level === 'HOLD_POINT');
    const title = n.kind === 'phase' ? (block?.plainName ?? PLAIN[n.block.type] ?? n.block.type) : 'QA hold point';
    const text = n.kind === 'phase' && typeof n.config['text'] === 'string' ? n.config['text'] : null;
    const sop = n.kind === 'phase' && typeof n.config['sop'] === 'string' ? content.references.find((r) => r.id === n.config['sop']) : undefined;
    return (
      <tr
        key={n.id}
        id={rowId(n.id)}
        data-node={n.id}
        {...(inLibrary ? { 'data-library-step': '' } : { 'data-step-row': '', 'data-selected': selected === n.id })}
        {...(severity ? { 'data-severity': severity } : {})}
        className={dcls('stepRow')}
        tabIndex={inLibrary ? -1 : 0}
        aria-label={`Step ${num} ${n.name}`}
        {...(inLibrary ? {} : { onClick: () => onSelect(n.id), onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => onRowKey(e, n.id) })}
      >
        <td className={dcls('no')}>{num}</td>
        <td>
          <div>
            <strong>{n.name}</strong>
          </div>
          <div className={dcls('small')}>
            {title}
            {n.kind === 'phase' ? <span className={dcls('mono')}> · {n.block.type}@{n.block.version}</span> : null}
            {block?.badge ? <> · {block.badge}</> : null}
          </div>
          {text ? <div>{text}</div> : null}
          {sop ? (
            <div className={dcls('small')}>
              Follow {sop.code} v{sop.version}
            </div>
          ) : null}
          {n.kind === 'phase' ? (
            <div className={dcls('small')}>
              Configuration:{' '}
              <ConfigList
                config={n.config}
                label={`Configuration of step ${num}`}
                describe={(k, v) => (k === 'text' && typeof v === 'string' ? 'the instruction above' : k === 'sop' && typeof v === 'string' ? referenceLabel(content, v) : undefined)}
                defaults={blockDefaults(block?.configSchema, n.config)}
              />
            </div>
          ) : null}
          {n.kind === 'phase' ? (
            <ul className={dcls('list')} aria-label={`Details of step ${num}`}>
              {phaseFacts(content, n).map((f, i) => (
                <li key={i} className={dcls('small')}>
                  {f}
                </li>
              ))}
            </ul>
          ) : null}
          {findings.length > 0 ? (
            <div className={dcls('small')}>
              {findings.filter((f) => f.severity === 'ERROR').length} errors, {findings.filter((f) => f.severity === 'WARNING').length} warnings
            </div>
          ) : null}
        </td>
        <td>
          {n.kind === 'phase' ? (
            <ul className={dcls('list')}>
              {n.records.map((r) => (
                <li key={`r-${r}`}>{itemLabel(content, r)}</li>
              ))}
              {n.computes.map((r) => (
                <li key={`c-${r}`}>{itemLabel(content, r)} (computed)</li>
              ))}
              {n.consumes.map((b) => {
                const line = content.bom.find((x) => x.id === b);
                return <li key={`b-${b}`}>{line ? `${b}: ${referenceLabel(content, line.material)}` : b} (dispensed or charged)</li>;
              })}
              {n.produces.map((b) => (
                <li key={`p-${b}`}>
                  {content.intermediates.find((i) => i.id === b)?.name ?? b} ({b}, produced)
                </li>
              ))}
              {n.uses.map((b) => (
                <li key={`u-${b}`}>
                  {content.intermediates.find((i) => i.id === b)?.name ?? b} ({b}, used)
                </li>
              ))}
            </ul>
          ) : (
            <span className={dcls('small')}>Disposition: {n.dispositions.join(' / ')}</span>
          )}
        </td>
        <td>{n.kind === 'phase' ? roleTitle(n.signatures.perform?.role) : roleTitle(n.role)}</td>
        <td>{n.kind === 'phase' ? checkWords(content, n, roleTitle) : '—'}</td>
        <td>
          {inLibrary ? (
            <span className={dcls('small')}>Step of a library element (read-only here)</span>
          ) : (
          <MenuTrigger>
            <Button aria-label={`Actions for step ${num}`} variant="quiet">
              ⋯
            </Button>
            <Popover>
              <Menu
                className={dcls('menu')}
                disabledKeys={readOnly ? ['insert', 'up', 'down', 'delete'] : []}
                onAction={(key) => {
                  if (key === 'edit') onSelect(n.id);
                  else if (key === 'insert') setInsertAfter(n.id);
                  else if (key === 'up' || key === 'down') dispatch({ kind: 'MOVE_STEP', nodeId: n.id, direction: key === 'up' ? -1 : 1 });
                  else if (key === 'delete') dispatch({ kind: 'DELETE_STEP', nodeId: n.id });
                }}
              >
                <MenuItem id="edit" className={dcls('menuItem')}>
                  Step properties
                </MenuItem>
                <MenuItem id="insert" className={dcls('menuItem')}>
                  Insert a step after
                </MenuItem>
                <MenuItem id="up" className={dcls('menuItem')}>
                  Move up
                </MenuItem>
                <MenuItem id="down" className={dcls('menuItem')}>
                  Move down
                </MenuItem>
                <MenuItem id="delete" className={dcls('menuItem')}>
                  Delete
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
          )}
        </td>
      </tr>
    );
  };

  const rows: ReactNode[] = [];
  const box = (key: string, nodeId: string, words: ReactNode, idAttr?: string, small = false): ReactNode => (
    <tr key={key} {...(idAttr ? { id: idAttr, tabIndex: -1 } : {})} data-node={nodeId} className={dcls('constructRow')}>
      <td />
      <td colSpan={5} {...(small ? { className: dcls('small') } : {})}>
        {words}
      </td>
    </tr>
  );
  const visit = (n: flow.FlowNode, at: At): void => {
    const id = `${at.prefix}${n.id}`;
    switch (n.kind) {
      case 'stage': {
        const num = numbering.byId.get(id)?.number ?? '?';
        rows.push(
          <tr key={id} id={rowId(id)} data-node={id} className={dcls('stageRow')} tabIndex={-1}>
            <td className={dcls('no')}>{num}</td>
            <td colSpan={5}>
              Stage {num}: {n.name} · {n.binding.rooms.length > 0 ? `room ${n.binding.rooms.join(', ')}` : 'no room'}
              {n.binding.line ? ` · line ${n.binding.line}` : ''} · signed off by {roleTitle(n.responsibleRole)}
              {n.purpose === 'NON_MATERIAL' ? ' · moves no material' : ''}
            </td>
          </tr>,
        );
        visit(n.body, at);
        return;
      }
      case 'operation': {
        const num = numbering.byId.get(id)?.number ?? '?';
        rows.push(
          <tr key={id} id={rowId(id)} data-node={id} className={dcls('operationRow')} tabIndex={-1}>
            <td className={dcls('no')}>{num}</td>
            <td colSpan={5}>{n.name}</td>
          </tr>,
        );
        visit(n.body, at);
        return;
      }
      case 'sequence':
        for (const c of n.children) visit(c, at);
        return;
      case 'phase':
        rows.push(stepRow(at.prefix ? boundPhase(n, id, at.bind) : n, at.prefix !== ''));
        return;
      case 'holdPoint':
        rows.push(stepRow(at.prefix ? { ...n, id } : n, at.prefix !== ''));
        return;
      case 'parallel':
      case 'alternative': {
        rows.push(box(`${id}-box`, id, <>{constructWords(content, n)} <span className={dcls('small')}>(read-only in this release)</span></>, rowId(id)));
        // Each branch body under its own boundary row, so a step is never read as part of another branch (review F45).
        for (const b of n.branches) {
          const rule = n.kind === 'alternative' ? branchRule(n, b) : `"${b.name}" (runs side by side with the other branches)`;
          rows.push(box(`${id}-branch-${b.id}`, id, <strong>Branch {rule}</strong>, `mbr-branch-${id}-${b.id}`));
          if (b.body) visit(b.body, at);
        }
        rows.push(box(`${id}-end`, id, `end of the ${n.kind === 'parallel' ? 'parallel branches' : 'alternative'}`, undefined, true));
        return;
      }
      case 'loop':
      case 'replicate':
        rows.push(box(`${id}-box`, id, <>{constructWords(content, n)} <span className={dcls('small')}>(read-only in this release)</span></>, rowId(id)));
        visit(n.body, at);
        rows.push(box(`${id}-end`, id, `end of ${n.kind === 'loop' ? 'repeat' : 'per sub-lot'} "${n.name}"`, undefined, true));
        return;
      case 'libraryCall': {
        // The element's body is numbered in place under "call/inner" (flow.numberMbr); its rows are shown read-only
        // with the items the call binds, so the document never skips a numbered step (review F46).
        const element = content.library.find((e) => e.ref === n.element);
        rows.push(box(`${id}-box`, id, <>{callWords(content, n, element, at.bind)} <span className={dcls('small')}>(read-only in this release)</span></>, rowId(id)));
        if (!element) rows.push(box(`${id}-missing`, id, `The element ${n.element} is not embedded in this master, so its steps cannot be shown; the validator refuses such a master.`));
        else if (at.calls.includes(n.element)) rows.push(box(`${id}-recursive`, id, `The element ${n.element} calls itself; the validator refuses such a master.`));
        else {
          const outer = at.bind;
          visit(element.body, { prefix: `${id}/`, bind: (s) => (n.bind[s] !== undefined ? outer(n.bind[s]) : s), calls: [...at.calls, n.element] });
        }
        rows.push(box(`${id}-end`, id, `end of library element ${n.element}`, undefined, true));
        return;
      }
    }
  };
  visit(content.procedure.body, TOP);

  return (
    <>
      <p className={dcls('small')}>Keyboard on a step: Enter opens it, Alt+Arrow keys move it, Delete removes it, Insert adds a step after it; Ctrl+Z undoes.</p>
      <table className={dcls('grid')} ref={tableRef} aria-label="Procedure">
        <thead>
          <tr>
            <th scope="col">No.</th>
            <th scope="col">Instruction</th>
            <th scope="col">Records</th>
            <th scope="col">Done by</th>
            <th scope="col">Checked by</th>
            <th scope="col">
              <span className={dcls('small')}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
      <InsertDialog open={insertAfter !== null} onClose={() => setInsertAfter(null)} palette={palette} onInsert={insert} />
    </>
  );
}
