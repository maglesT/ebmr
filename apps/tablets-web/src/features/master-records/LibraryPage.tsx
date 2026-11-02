/**
 * The library of block definitions (decision 0026, slice S3; contract ns/library.ts). Each block is a form defined as
 * data: its sections, typed fields and signatures. An author checks and stores the next version of a definition; QA
 * approves a draft with a signature through the ceremony (LIBRARY_ACT BLOCK_APPROVE, never the author) and retires
 * an approved version with a reason. Every rule is the server's: the form check (recipe-core library) and the
 * database's hash, version order and permissions. The structured form editor arrives with the formulation builder (S9);
 * here the definition is edited as JSON.
 */
import { useState } from 'react';
import { routes, type LibraryBlockView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const READS = [routes.library.list.id];

interface FieldSummary {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  unit?: unknown;
}

/** The sections and fields of a stored definition, as text the reviewer reads before signing. */
function sectionsOf(definition: Record<string, unknown>): { title: string; fields: string[] }[] {
  const sections = Array.isArray(definition['sections']) ? (definition['sections'] as { title?: unknown; fields?: unknown }[]) : [];
  return sections.map((s) => ({
    title: typeof s.title === 'string' ? s.title : '',
    fields: (Array.isArray(s.fields) ? (s.fields as FieldSummary[]) : []).map(
      (f) => `${typeof f.label === 'string' ? f.label : ''} (${typeof f.type === 'string' ? f.type.toLowerCase() : ''}${typeof f.unit === 'string' ? `, ${f.unit}` : ''})`,
    ),
  }));
}

export function LibraryPage() {
  const [code, setCode] = useState('');
  const filter = code.trim().toUpperCase();
  const q = useApiQuery(routes.library.list, /^[A-Z][A-Z0-9-]{1,39}$/.test(filter) ? { query: { code: filter } } : {});
  const author = useOffered('FORMULA_AUTHOR');
  const qa = useOffered('MASTER_CONFIRMER');
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);
  return (
    <>
      <h1>Block library</h1>
      <p>Each block is a form: sections of typed fields and the signatures the step needs. A formulation uses approved versions only.</p>
      <Field name="libraryCodeFilter" label="Block code" value={code} onChange={setCode} description="Show one block's versions (empty: all)" />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.blocks.length === 0 ? <p>No library block stored yet.</p> : null}
      {q.data?.blocks.map((b) => (
        <BlockCard
          key={b.blockId}
          b={b}
          canApprove={qa}
          onNewVersion={author ? () => setSeed((x) => ({ text: JSON.stringify({ ...b.definition, version: b.version + 1 }, null, 2), n: (x?.n ?? 0) + 1 })) : undefined}
        />
      ))}
      {author ? <LoadCatalogue /> : null}
      {author ? <DraftForm key={seed ? String(seed.n) : 'blank'} initial={seed?.text ?? ''} /> : null}
    </>
  );
}

function BlockCard({ b, canApprove, onNewVersion }: { b: LibraryBlockView; canApprove: boolean; onNewVersion?: (() => void) | undefined }) {
  const signed = useSignedAct(READS);
  const retire = useCommand(routes.library.retire, READS, 'retiring a library block');
  const [reason, setReason] = useState('');
  const name = `${b.code} version ${String(b.version)}`;
  return (
    <Section title={`${name}: ${b.title}`} testId={`library-${b.code}-${String(b.version)}`}>
      <p>
        <StatusChip tone={b.state === 'APPROVED' ? 'ok' : b.state === 'DRAFT' ? 'warning' : 'neutral'} label={b.state} /> {b.category.toLowerCase().replace('_', ' ')} · drafted by{' '}
        {b.draftedBy.legalName}, {b.draftedAt.text}
        {b.approvedBy ? ` · approved by ${b.approvedBy.legalName}, ${b.approvedAt?.text ?? ''}` : ''}
        {b.retiredAt ? ` · retired ${b.retiredAt.text}: ${b.retirementReason ?? ''}` : ''}
      </p>
      <p>Content hash {b.contentHash.slice(0, 16)}…</p>
      {sectionsOf(b.definition).map((s, i) => (
        <div key={i}>
          <h3>{s.title}</h3>
          <ul aria-label={`Fields of ${s.title}`}>
            {s.fields.map((f, j) => (
              <li key={j}>{f}</li>
            ))}
          </ul>
        </div>
      ))}
      {onNewVersion ? <ActButton primary={false} label={`Start version ${String(b.version + 1)} from ${name}`} onPress={onNewVersion} /> : null}
      {canApprove && b.state === 'DRAFT' ? (
        <ActButton
          label={`Approve ${name} (signature)`}
          onPress={() => signed.sign({ kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: b.blockId }, `Approve the library block ${name}`)}
          disabled={signed.busy || signed.outcome === 'SIGNED'}
        />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
      {canApprove && b.state === 'APPROVED' ? (
        <>
          <Field name={`retireReason-${b.blockId}`} label={`Reason to retire ${name}`} value={reason} onChange={setReason} />
          <ActButton label={`Retire ${name}`} onPress={() => retire.run({ body: { blockId: b.blockId, reason: reason.trim() } })} disabled={reason.trim() === '' || retire.busy} />
          <ActResult error={retire.error} done={retire.done} label="Retired." />
        </>
      ) : null}
    </Section>
  );
}

/** S7: the ready-made catalogue, stored as drafts (codes the library holds are left alone); QA approves what is used. */
function LoadCatalogue() {
  const load = useCommand(routes.library.loadCatalogue, READS, 'loading the ready-made catalogue');
  return (
    <Section title="Ready-made catalogue" testId="library-catalogue">
      <p>Load the ready-made blocks (process steps, coatings, tests, controls and packaging) as drafts. Codes the library already holds are left alone; nothing is used until QA approves it.</p>
      <ActButton primary={false} label="Load the ready-made catalogue as drafts" onPress={() => load.run({ body: {} })} disabled={load.busy} />
      {load.done ? (
        <p data-testid="library-catalogue-result">
          {load.done.drafted.length} stored as drafts{load.done.skipped.length > 0 ? `; ${String(load.done.skipped.length)} already in the library` : ''}.
        </p>
      ) : null}
      <ActResult error={load.error} />
    </Section>
  );
}

/** The next version of a definition, as JSON: checked by the server, then stored as a draft for QA's approval. */
function DraftForm({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const check = useCommand(routes.library.check, [], 'checking a block definition');
  const draft = useCommand(routes.library.draft, READS, 'storing a library block');
  let parsed: Record<string, unknown> | null = null;
  let parseProblem: string | null = null;
  if (text.trim() !== '') {
    try {
      const v: unknown = JSON.parse(text);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) parsed = v as Record<string, unknown>;
      else parseProblem = 'The definition is a JSON object.';
    } catch (e) {
      parseProblem = `The definition is not valid JSON: ${e instanceof Error ? e.message : 'unknown error'}`;
    }
  }
  return (
    <Section title="Store a block definition" testId="library-draft">
      <p>Write the definition (code, version, title, category, sections, signatures). Check it, then store it; QA approves it before any formulation uses it.</p>
      <div>
        <label htmlFor="library-definition">Definition (JSON)</label>
        <textarea id="library-definition" value={text} onChange={(e) => setText(e.target.value)} rows={18} spellCheck={false} style={{ display: 'block', inlineSize: '100%', fontFamily: 'monospace' }} />
      </div>
      {parseProblem ? <p role="alert">{parseProblem}</p> : null}
      <ActButton primary={false} label="Check the definition" onPress={() => (parsed ? check.run({ body: { definition: parsed } }) : null)} disabled={!parsed || check.busy} />
      {check.error ? <RefusalMessage error={check.error} /> : null}
      {check.done ? (
        check.done.problems.length === 0 ? (
          <p data-testid="library-check-ok">No problems found.</p>
        ) : (
          <ul aria-label="Problems in the definition">
            {check.done.problems.map((p, i) => (
              <li key={i}>
                {p.severity === 'ERROR' ? 'Problem' : 'Warning'} at {p.path}: {p.message}
              </li>
            ))}
          </ul>
        )
      ) : null}
      <ActButton label="Store as the next version" onPress={() => (parsed ? draft.run({ body: { definition: parsed } }) : null)} disabled={!parsed || draft.busy} />
      <ActResult error={draft.error} done={draft.done} label="Stored as a draft." />
    </Section>
  );
}
