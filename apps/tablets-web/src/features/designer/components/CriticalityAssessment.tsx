/**
 * R-rest A11: the master names the risk assessment that classifies its parameters and calculations (an effective
 * RISK_ASSESSMENT of the document-management stand-in, pinned like any reference). With it, a non-critical item needs no
 * reduction of its own; the validator judges the rest.
 */
import { routes } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { useApiQuery } from '../../../api/hooks.ts';
import type { Content, Op } from '../model/ops.ts';
import { Select } from './common.tsx';

export function CriticalityAssessment({ content, dispatch }: { content: Content; dispatch: (op: Op) => boolean }) {
  const docs = useApiQuery(routes.designer.referenceDocuments);
  const assessments = (docs.data?.documents ?? []).filter((d) => d.kind === 'RISK_ASSESSMENT' && d.status === 'EFFECTIVE');
  const current = content.header.criticalityAssessment ?? '';
  const choose = (code: string): void => {
    const d = assessments.find((x) => x.code === code);
    const reference: flow.Reference | null = d ? { id: d.code, kind: 'RISK_ASSESSMENT', code: d.code, version: d.version, hash: d.hash, title: d.title } : null;
    dispatch({ kind: 'SET_CRITICALITY_ASSESSMENT', reference });
  };
  const options = [{ value: '', label: 'None: each non-critical item has its own reduction' }, ...assessments.map((d) => ({ value: d.code, label: `${d.title} (${d.code} v${d.version})` }))];
  if (current !== '' && !assessments.some((d) => d.code === current)) options.push({ value: current, label: current });
  return <Select label="Criticality assessment of this master" value={current} options={options} onChange={choose} />;
}
