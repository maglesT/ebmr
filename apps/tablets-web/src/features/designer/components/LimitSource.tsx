/**
 * D-8 (item 21): the author names the source of a limit range, a document pinned from the effective documents of the
 * document-management stand-in. 21 CFR 211.160(b) asks for scientifically sound and appropriate specifications, so the
 * master records where each limit comes from; the validator judges the kind of source against the document's kind.
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import type { flow, limits } from '@ebmr/recipe-core/pure';
import { Button } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { dcls } from '../classes.ts';
import type { Op } from '../model/ops.ts';
import { Select } from './common.tsx';

type Owner = 'parameter' | 'calculation' | 'yield';

/** The source kind a document of each kind stands for (the validator's expected reference kinds, rules-content.ts). */
const SOURCE_OF: Readonly<Record<string, limits.LimitSourceKind>> = {
  REGISTRATION: 'REGISTRATION',
  VALIDATION_REPORT: 'VALIDATION_REPORT',
  PHARMACOPOEIA: 'PHARMACOPOEIA',
  HOLD_STUDY: 'HOLD_STUDY',
  RULE_SET: 'RULE_TABLE',
  DOCUMENT: 'PROCESS_DATA',
  SOP: 'COMPANY_STANDARD',
};

function useSourceDocuments() {
  const docs = useApiQuery(routes.designer.referenceDocuments);
  return (docs.data?.documents ?? []).filter((d) => d.status === 'EFFECTIVE' && SOURCE_OF[d.kind] !== undefined);
}

function referenceOf(d: { code: string; kind: string; version: string; hash: string; title: string }): flow.Reference {
  return { id: d.code, kind: d.kind as flow.Reference['kind'], code: d.code, version: d.version, hash: d.hash, title: d.title };
}

/** The source of one range: a choice of document; choosing one records it as the range's source. */
export function LimitSourcePicker({ owner, id, name, tier, current, dispatch }: { owner: Owner; id: string; name: string; tier: limits.LimitTier; current: string; dispatch: (op: Op) => boolean }) {
  const docs = useSourceDocuments();
  const options = [{ value: '', label: `Keep ${current}` }, ...docs.map((d) => ({ value: d.code, label: `${d.title} (${d.code} v${d.version})` }))];
  const choose = (code: string): void => {
    const d = docs.find((x) => x.code === code);
    const kindOfSource = d ? SOURCE_OF[d.kind] : undefined;
    if (d && kindOfSource) dispatch({ kind: 'SET_LIMIT_SOURCE', owner, id, tier, kindOfSource, reference: referenceOf(d) });
  };
  return <Select label={`Source of ${name}, ${tier.toLowerCase().replace('_', ' ')} range`} value="" options={options} onChange={choose} />;
}

/** Limits for an item that has none: the tier, the unit and the source; the bounds are then set in the table. */
export function AddLimitRange({ owner, id, name, unit, dispatch }: { owner: Owner; id: string; name: string; unit: string; dispatch: (op: Op) => boolean }) {
  const docs = useSourceDocuments();
  const [tier, setTier] = useState<limits.LimitTier>('VALIDATED');
  const [code, setCode] = useState('');
  const d = docs.find((x) => x.code === code);
  const add = (): void => {
    const kindOfSource = d ? SOURCE_OF[d.kind] : undefined;
    if (d && kindOfSource) dispatch({ kind: 'ADD_LIMIT_RANGE', owner, id, tier, unit, kindOfSource, reference: referenceOf(d) });
  };
  return (
    <div className={dcls('inline')}>
      <Select label={`Tier of the new range of ${name}`} value={tier} options={(['REGISTERED', 'VALIDATED', 'INTERNAL_ACTION', 'ALERT'] as const).map((t) => ({ value: t, label: t.toLowerCase().replace('_', ' ') }))} onChange={(v) => setTier(v as limits.LimitTier)} />
      <Select label={`Source of the new range of ${name}`} value={code} options={[{ value: '', label: 'Choose a document' }, ...docs.map((x) => ({ value: x.code, label: `${x.title} (${x.code} v${x.version})` }))]} onChange={setCode} />
      <Button onPress={add} isDisabled={!d}>
        Add limits to {name}
      </Button>
    </div>
  );
}
