/**
 * Plant rules: the penicillin facility rule of a site and the beta-lactam classification of a material or product
 * (Phase 7 slice 7g-2, decision 0025; recipe-core 0973, 1210; PR-27). The master-data steward proposes; a QA person who
 * is not the proposer approves through the signing ceremony (INDIA_ACT FACILITY_RULE_APPROVE or BETA_LACTAM_APPROVE,
 * meaning QA_APPROVED). The stricter rule wins: a proposal that tightens is in force at once, one that loosens only once
 * approved. What is in force, what is pending and each proposal's effect are the database's; the screen shows them.
 * Every act is offered to whoever opens the page: who may propose (MASTERDATA.CHANGE) and who may approve (PLANT_RULE.APPROVE,
 * never the proposer) is the database's rule, and its refusal is shown in its own words.
 */
import { useState } from 'react';
import { routes, type BetaLactamSubjectView, type FacilityRuleSubjectView, type PlantRuleProposalView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';

export const PLANT_RULE_READS: readonly string[] = [routes.plantRules.proposals.id];

const SITE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,63}$/;

export function PlantRulesPage() {
  const q = useApiQuery(routes.plantRules.proposals, {});
  return (
    <>
      <h1>Penicillin facility and beta-lactam rules</h1>
      <p>
        A beta-lactam (penicillin) material or product is received and processed only at a site that is a penicillin facility. The master-data steward proposes a rule; it is in
        force once a QA person who did not propose it approves it. The stricter rule wins: a proposal that tightens (a site that is not a penicillin facility, a material that is
        beta-lactam) is in force at once, and one that loosens waits for QA. Only the latest proposal of a site, material or product can be approved, and only once.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Penicillin facility rules" testId="facility-rules">
        {q.data && q.data.facilityRules.length === 0 ? <p>No facility rule is recorded: no site is a penicillin facility.</p> : null}
        <ul>
          {q.data?.facilityRules.map((f) => <FacilitySubject key={f.site} f={f} />)}
        </ul>
        <ProposeFacility />
      </Section>
      <Section title="Beta-lactam classifications" testId="beta-lactam">
        {q.data && q.data.betaLactam.length === 0 ? <p>No classification is recorded.</p> : null}
        <ul>
          {q.data?.betaLactam.map((b) => <BetaSubject key={`${b.kind}:${b.code}`} b={b} />)}
        </ul>
        <ProposeBetaLactam />
      </Section>
    </>
  );
}

function InForce({ inForce, pending, yes, no }: { inForce: boolean; pending: boolean; yes: string; no: string }) {
  return (
    <>
      <StatusChip tone={inForce ? 'warning' : 'info'} label={`In force: ${inForce ? yes : no}`} /> {pending ? <StatusChip tone="pending" label="A proposal waits for QA" /> : null}
    </>
  );
}

function FacilitySubject({ f }: { f: FacilityRuleSubjectView }) {
  return (
    <li data-testid={`facility-${f.site}`} data-in-force={f.inForce ? 'yes' : 'no'} data-pending={f.pending ? 'yes' : 'no'}>
      <strong>{f.site}</strong> <InForce inForce={f.inForce} pending={f.pending} yes="a penicillin facility" no="not a penicillin facility" />
      <Versions versions={f.versions} what={(p) => (p.value ? 'is a penicillin facility' : 'is not a penicillin facility')} subject={f.site} act="FACILITY_RULE_APPROVE" />
    </li>
  );
}

function BetaSubject({ b }: { b: BetaLactamSubjectView }) {
  const subject = `${b.kind.toLowerCase()} ${b.code}`;
  return (
    <li data-testid={`beta-${b.kind}-${b.code}`} data-in-force={b.inForce ? 'yes' : 'no'} data-pending={b.pending ? 'yes' : 'no'}>
      <strong>{subject}</strong> <InForce inForce={b.inForce} pending={b.pending} yes="beta-lactam" no="not beta-lactam" />
      <Versions versions={b.versions} what={(p) => (p.value ? 'is beta-lactam' : 'is not beta-lactam')} subject={subject} act="BETA_LACTAM_APPROVE" />
    </li>
  );
}

const EFFECT: Readonly<Record<PlantRuleProposalView['effect'], string>> = {
  TIGHTENS: 'tightens: in force at once',
  LOOSENS: 'loosens: in force only once QA approves it',
  UNCHANGED: 'repeats the approved value',
};

function Versions({ versions, what, subject, act }: { versions: PlantRuleProposalView[]; what: (p: PlantRuleProposalView) => string; subject: string; act: 'FACILITY_RULE_APPROVE' | 'BETA_LACTAM_APPROVE' }) {
  const signed = useSignedAct(PLANT_RULE_READS);
  return (
    <>
      <ul>
        {versions.map((p) => (
          <li key={p.proposalId} data-testid={`proposal-${p.proposalId}`} data-state={p.state} data-effect={p.effect}>
            Version {p.version}: {subject} {what(p)} ({EFFECT[p.effect]}) <StatusChip tone={p.state === 'APPROVED' ? 'ok' : p.state === 'PROPOSED' ? 'pending' : 'neutral'} label={p.state.charAt(0) + p.state.slice(1).toLowerCase()} />
            <br />
            {p.reason}. Proposed by {p.proposedBy.legalName} {p.proposedAt.text}
            {p.approvedBy ? `; approved by ${p.approvedBy.legalName} ${p.approvedAt?.text ?? ''}` : ''}
            {p.state === 'PROPOSED' ? (
              <ActButton
                label={`Approve version ${p.version} of ${subject}`}
                onPress={() => signed.sign({ kind: 'INDIA_ACT', act, subjectId: p.proposalId }, `Approve: ${subject} ${what(p)} (version ${p.version})`)}
                disabled={signed.busy}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <ActResult error={signed.error} outcome={signed.outcome} />
    </>
  );
}

function ProposeFacility() {
  const propose = useCommand(routes.plantRules.setFacilityRule, PLANT_RULE_READS);
  const [site, setSite] = useState('');
  const [penicillin, setPenicillin] = useState('true');
  const [justification, setJustification] = useState('');
  const ok = SITE.test(site.trim()) && justification.trim() !== '';
  return (
    <div data-testid="propose-facility">
      <h3>Propose a facility rule</h3>
      <Field name="facilitySite" label="Site code" value={site} onChange={setSite} />
      <floor.ChoiceGroup
        label="The site"
        options={[
          { value: 'true', label: 'is a penicillin facility' },
          { value: 'false', label: 'is not a penicillin facility' },
        ]}
        value={penicillin}
        onChange={setPenicillin}
      />
      <Field name="facilityJustification" label="Justification" value={justification} onChange={setJustification} />
      <ActButton
        label="Propose the facility rule"
        onPress={() => ok && propose.run({ params: { site: site.trim() }, body: { penicillinFacility: penicillin === 'true', justification: justification.trim() } })}
        disabled={!ok || propose.busy}
      />
      <ActResult error={propose.error} done={propose.done} label="The rule is proposed: a tightening is in force now, a loosening once QA approves it." />
    </div>
  );
}

function ProposeBetaLactam() {
  const propose = useCommand(routes.plantRules.classifyBetaLactam, PLANT_RULE_READS);
  const [kind, setKind] = useState('MATERIAL');
  const [code, setCode] = useState('');
  const [beta, setBeta] = useState('true');
  const [reason, setReason] = useState('');
  const ok = CODE.test(code.trim()) && reason.trim() !== '';
  return (
    <div data-testid="propose-beta-lactam">
      <h3>Propose a classification</h3>
      <floor.ChoiceGroup
        label="Kind"
        options={[
          { value: 'MATERIAL', label: 'Material' },
          { value: 'PRODUCT', label: 'Product' },
        ]}
        value={kind}
        onChange={setKind}
      />
      <Field name="betaCode" label="Material or product code" value={code} onChange={setCode} />
      <floor.ChoiceGroup
        label="It"
        options={[
          { value: 'true', label: 'is beta-lactam' },
          { value: 'false', label: 'is not beta-lactam' },
        ]}
        value={beta}
        onChange={setBeta}
      />
      <Field name="betaReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Propose the classification"
        onPress={() => ok && propose.run({ body: { kind: kind === 'PRODUCT' ? 'PRODUCT' : 'MATERIAL', code: code.trim(), betaLactam: beta === 'true', reason: reason.trim() } })}
        disabled={!ok || propose.busy}
      />
      <ActResult error={propose.error} done={propose.done} label="The classification is proposed: a tightening is in force now, a loosening once QA approves it." />
    </div>
  );
}
