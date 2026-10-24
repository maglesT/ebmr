/**
 * A lot's assay result and artwork version on screen (Phase 7 slice 7o; R4, R8): what a potency-adjusted dispensing
 * (TB-01) reads of the lot, and the artwork version a printed packaging lot was checked with (G-21). Shown on the GMP
 * lot page (QC records them) and on the sandbox's test lots (the steward records them for test data). The server and the
 * database decide who may record and what is valid; a recorded artwork version never changes, a later assay result
 * supersedes the current one with the person's reason.
 */
import { useState } from 'react';
import { routes, type LotResultView } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from './acts.tsx';
import { DefineForm } from './define-form.tsx';
import { RefusalMessage } from './refusal.tsx';

const REFRESH = [routes.execution.lotQuality.id];
const BASES = ['AS_IS', 'ANHYDROUS_WATER', 'DRIED_LOD', 'ANHYDROUS_SOLVENT_FREE'] as const;

type Basis = (typeof BASES)[number];
const NEEDS: Record<Basis, readonly ('assay' | 'water' | 'lod' | 'solvents')[]> = {
  AS_IS: ['assay'],
  ANHYDROUS_WATER: ['assay', 'water'],
  DRIED_LOD: ['assay', 'lod'],
  ANHYDROUS_SOLVENT_FREE: ['assay', 'water', 'solvents'],
};
const TEST: Record<string, string> = {
  assay: 'ASSAY',
  water: 'WATER',
  lod: 'LOD',
  solvents: 'RESIDUAL_SOLVENTS',
};

/**
 * GMP (tablets 1001): the values are the lot's approved, passing LIMS results, chosen by the person, never typed; the
 * database copies each value and records its source.
 */
function GmpAssayForm({ lotCode, results }: { lotCode: string; results: readonly LotResultView[] }) {
  const [basis, setBasis] = useState<Basis | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [certificate, setCertificate] = useState('');
  const [reason, setReason] = useState('');
  const cmd = useCommand(routes.execution.recordLotAssay, REFRESH, 'recording the assay result');
  const needs = basis ? NEEDS[basis] : [];
  const ready = basis !== null && needs.every((m) => chosen[m]) && certificate.trim() !== '';
  const send = async (): Promise<void> => {
    if (!basis) return;
    const ids = Object.fromEntries(needs.map((m) => [`${m}ResultId`, chosen[m] ?? '']));
    await cmd.run({
      params: { code: lotCode },
      body: {
        basis,
        ...ids,
        certificateRef: certificate.trim(),
        ...(reason.trim() !== '' ? { reason: reason.trim() } : {}),
      },
    });
  };
  return (
    <form aria-label={`Record the assay result of ${lotCode}`} onSubmit={(e) => e.preventDefault()}>
      <h3>Record the assay result of {lotCode}</h3>
      <floor.ChoiceGroup label="Basis" options={BASES.map((b) => ({ value: b, label: b }))} value={basis} onChange={(v) => setBasis(v as Basis)} />
      {needs.map((m) => {
        const options = results.filter((r) => r.testCode === TEST[m] && r.state === 'APPROVED' && r.verdict === 'PASS' && r.unit === '%');
        return (
          <floor.ChoiceGroup
            key={m}
            label={`${TEST[m] ?? m} result`}
            description={options.length === 0 ? `No approved, passing ${TEST[m] ?? m} result of this lot yet` : 'an approved, passing result of this lot'}
            options={options.map((r) => ({
              value: r.resultId,
              label: `${r.testCode} ${r.value} ${r.unit} (${r.purpose})`,
            }))}
            value={chosen[m] ?? null}
            onChange={(v) => setChosen((c) => ({ ...c, [m]: v }))}
          />
        );
      })}
      <Field name="certificateRef" label="Certificate or result reference" value={certificate} onChange={setCertificate} />
      <Field name="reason" label="Reason (when it replaces the current result)" description="optional" value={reason} onChange={setReason} />
      <ActButton label="Record the assay result" onPress={send} disabled={!ready || cmd.busy} />
      <ActResult error={cmd.error} done={cmd.done} />
    </form>
  );
}

/** `results`: on GMP the lot's LIMS results (the assay is chosen from the approved ones); absent in the sandbox (typed). */
export function LotQualityForms({ lotCode, results }: { lotCode: string; results?: readonly LotResultView[] }) {
  const q = useApiQuery(routes.execution.lotQuality, {
    params: { code: lotCode },
  });
  const v = q.data;
  const params = { code: lotCode };
  return (
    <Section title={`Assay and artwork of lot ${lotCode}`} testId={`lot-quality-${lotCode}`}>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <p data-testid="lot-assay">
        {v?.assay
          ? `Assay ${v.assay.assay} % (${v.assay.basis}${v.assay.water ? `, water ${v.assay.water} %` : ''}${v.assay.lod ? `, loss on drying ${v.assay.lod} %` : ''}${v.assay.solvents ? `, solvents ${v.assay.solvents} %` : ''}), certificate ${v.assay.certificateRef}, recorded ${v.assay.recordedAt.text}`
          : 'No assay result recorded.'}
      </p>
      <p data-testid="lot-artwork">{v?.artwork ? `Artwork version ${v.artwork}` : 'No artwork version recorded.'}</p>
      {results ? (
        <GmpAssayForm lotCode={lotCode} results={results} />
      ) : (
        <DefineForm
          title={`Record the assay result of ${lotCode}`}
          route={routes.execution.recordLotAssay}
          params={params}
          refresh={REFRESH}
          submitLabel="Record the assay result"
          fields={[
            { name: 'basis', label: 'Basis', kind: 'choice', options: BASES },
            { name: 'assay', label: 'Assay (%)', kind: 'decimal' },
            {
              name: 'water',
              label: 'Water (%)',
              kind: 'decimal',
              optional: true,
              description: 'for an anhydrous basis',
            },
            {
              name: 'lod',
              label: 'Loss on drying (%)',
              kind: 'decimal',
              optional: true,
              description: 'for the dried basis',
            },
            {
              name: 'solvents',
              label: 'Residual solvents (%)',
              kind: 'decimal',
              optional: true,
              description: 'for the anhydrous, solvent-free basis',
            },
            {
              name: 'certificateRef',
              label: 'Certificate or result reference',
              kind: 'text',
            },
            {
              name: 'reason',
              label: 'Reason (when it replaces the current result)',
              kind: 'text',
              optional: true,
            },
          ]}
        />
      )}
      {v && v.artwork === null ? (
        <DefineForm
          title={`Record the artwork version of ${lotCode}`}
          route={routes.execution.recordLotArtwork}
          params={params}
          refresh={REFRESH}
          submitLabel="Record the artwork version"
          fields={[
            {
              name: 'artwork',
              label: 'Artwork version',
              kind: 'text',
              description: 'the printed packaging lot was checked against this version (printed packaging lots only)',
            },
          ]}
        />
      ) : null}
    </Section>
  );
}
