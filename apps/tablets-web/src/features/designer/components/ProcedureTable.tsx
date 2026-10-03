/**
 * Section 8, the numbered procedure (module C2; plan section 8): stage -> operation -> step rows with No.,
 * Instruction, Records, Done by and Checked by, like a paper batch record. Constructs (parallel, alternative, loop,
 * replicate, library call) are read-only labelled boxes around their steps in A1.
 *
 * Editing without drag, by menu or keyboard on a focused step row:
 *   Enter or Space  open the step's properties        Arrow Up / Down        previous / next step
 *   Alt+Arrow Up / Down  move the step in its sequence  Delete                 delete the step (undo brings it back)
 *   Insert or +     insert a step after this one      Ctrl+Z / Ctrl+Y        undo / redo (whole designer)
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { flow } from '@ebmr/recipe-core/pure';
import { Button, Dialog, StatusChip } from '@ebmr/ui-kit';
import { dcls } from '../classes.ts';
import { insertionPoint, newStep, type Content, type Op } from '../model/ops.ts';
import type { FindingItem, PaletteItem } from '../model/types.ts';
import { roleTitle } from './common.tsx';
import { humanize, itemLabel, referenceLabel, samplingWords } from './words.ts';

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

function constructLabel(n: flow.FlowNode): string {
  switch (n.kind) {
    case 'parallel':
      return `Parallel branches (${n.branches.map((b) => b.name).join(' | ')}): all run, all must finish`;
    case 'alternative':
      return `Alternative (${n.decision.mode === 'DATA' ? 'decided by recorded data' : n.decision.mode === 'OPERATOR_CHOICE' ? 'chosen by an authorised person, with a reason' : `fixed at issue by variant ${n.decision.variant}`}): ${n.branches.map((b) => b.name).join(' | ')}`;
    case 'loop':
      return `Repeat "${n.name}" until ${n.exit.condition} (at most ${n.maxIterations} times${n.maxDuration ? `, ${n.maxDuration.value} ${n.maxDuration.unit}` : ''})`;
    case 'replicate':
      return `Per sub-lot "${n.name}" (${n.count.mode === 'EXPRESSION' ? `count from ${n.count.expression}` : 'count chosen at run time'}, ${n.count.min}-${n.count.max}, ${n.instances.toLowerCase()})`;
    case 'libraryCall':
      return `Library element ${n.element}`;
    default:
      return n.kind;
  }
}

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
      <p className={dcls('small')}>Choose what the new step does. Blocks marked "sandbox only" run in test runs until Phase 3.</p>
      <ul className={dcls('list')} style={{ listStyle: 'none', padding: 0 }}>
        {palette.map((b) => (
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

  const stepRow = (n: flow.PhaseNode | flow.HoldPointNode): ReactNode => {
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
        data-step-row=""
        data-selected={selected === n.id}
        {...(severity ? { 'data-severity': severity } : {})}
        className={dcls('stepRow')}
        tabIndex={0}
        aria-label={`Step ${num} ${n.name}`}
        onClick={() => onSelect(n.id)}
        onKeyDown={(e) => onRowKey(e, n.id)}
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
        <td>{n.kind === 'phase' && n.signatures.check ? `${roleTitle(n.signatures.check.role)} (${n.signatures.check.meaning.toLowerCase()})` : '—'}</td>
        <td>
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
        </td>
      </tr>
    );
  };

  const rows: ReactNode[] = [];
  const visit = (n: flow.FlowNode, depth: number): void => {
    switch (n.kind) {
      case 'stage': {
        const num = numbering.byId.get(n.id)?.number ?? '?';
        rows.push(
          <tr key={n.id} id={rowId(n.id)} data-node={n.id} className={dcls('stageRow')} tabIndex={-1}>
            <td className={dcls('no')}>{num}</td>
            <td colSpan={5}>
              Stage {num}: {n.name} · {n.binding.rooms.length > 0 ? `room ${n.binding.rooms.join(', ')}` : 'no room'}
              {n.binding.line ? ` · line ${n.binding.line}` : ''} · signed off by {roleTitle(n.responsibleRole)}
              {n.purpose === 'NON_MATERIAL' ? ' · moves no material' : ''}
            </td>
          </tr>,
        );
        visit(n.body, depth + 1);
        return;
      }
      case 'operation': {
        const num = numbering.byId.get(n.id)?.number ?? '?';
        rows.push(
          <tr key={n.id} id={rowId(n.id)} data-node={n.id} className={dcls('operationRow')} tabIndex={-1}>
            <td className={dcls('no')}>{num}</td>
            <td colSpan={5}>{n.name}</td>
          </tr>,
        );
        visit(n.body, depth + 1);
        return;
      }
      case 'sequence':
        for (const c of n.children) visit(c, depth);
        return;
      case 'phase':
      case 'holdPoint':
        rows.push(stepRow(n));
        return;
      default:
        rows.push(
          <tr key={`${n.id}-box`} id={rowId(n.id)} className={dcls('constructRow')} tabIndex={-1}>
            <td />
            <td colSpan={5}>
              {constructLabel(n)} <span className={dcls('small')}>(read-only in this release)</span>
            </td>
          </tr>,
        );
        for (const c of flow.childrenOf(n)) visit(c, depth + 1);
        rows.push(
          <tr key={`${n.id}-end`} className={dcls('constructRow')}>
            <td />
            <td colSpan={5} className={dcls('small')}>
              end of {n.kind}
            </td>
          </tr>,
        );
    }
  };
  visit(content.procedure.body, 0);

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
