/**
 * Market policies and site values over HTTP (slice 7g WP3; decision D-P7R-3: market policies stay in v1.0; kernel 0320,
 * 0350, 0360; INV-47, IN-52, ST-01, DI-09):
 *  - a policy is defined (market.define_policy) and given new versions (market.set_policy_version) under a change record
 *    that covers area MARKET_POLICY; a loosening carries the approval: the latest valid POLICY_LOOSENING_APPROVED
 *    signature on the version's record (market_policy_version <policy>@<version>@<position>, signed through the ceremony,
 *    signable MARKET_LOOSENING). The server only finds it; the database checks that it signs exactly this version and
 *    that its signer is not the author (EBMR-MKT-073, EBMR-MKT-075, EBMR-ESIG-070);
 *  - a tightening already in force is applied to an issued batch (market.apply_policy_tightening; INV-47: never a
 *    loosening); the batch's pins are read (market.batch_policy_pin);
 *  - a site value is set (market.set_site_value) under a change record covering area SITE_VALUE; a loosening of a
 *    guidance value carries its justification reference and QA's SITE_VALUE_LOOSENING_APPROVED signature of exactly that
 *    loosening (market_site_loosening, found the same way).
 */
import type pg from 'pg';
import type { BatchPoliciesView, MarketPolicyView, Routes, SiteValuePreviewView, SiteValuesView } from '@ebmr/api-contract';
import { market, type ActorContext } from '@ebmr/kernel';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { Handlers } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { signaturesOf } from '../esig/views.ts';

type Db = pg.Pool | pg.PoolClient;

export const POLICY_AGGREGATE = 'market_policy_version';
export const SITE_LOOSENING_AGGREGATE = 'market_site_loosening';

/** A rule value as the person typed it: true and false are flags, anything else is a decimal or a category as text. */
export const ruleValueOf = (text: string): market.RuleValue => (text === 'true' ? true : text === 'false' ? false : text);
const valueText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** The latest valid signature with `meaning` on a record, or undefined. */
export async function latestApproval(db: Db, aggregateType: string, aggregateId: string, meaning: string): Promise<string | undefined> {
  return (await signaturesOf(db, aggregateType, aggregateId)).filter((s) => s.valid && s.meaning === meaning).at(-1)?.signatureId;
}

/** What the next version of `policy` at `position` signs (market.policy_version_target), or null for an unknown policy or position. */
export async function policyTarget(db: Db, policy: string, position: string): Promise<{ aggregateId: string } | null> {
  try {
    const t = await market.policyVersionApprovalTarget(db, policy, position);
    return { aggregateId: t.aggregateId };
  } catch (e) {
    if (e instanceof market.MarketRuleError) return null;
    throw e;
  }
}

/** The stub site of the market configuration by its code. */
export async function siteIdOf(db: Db, code: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select id from market.stub_site where code = $1', [code]);
  const id = rows[0]?.id;
  if (!id) throw refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'INVALID_INPUT', whatHappened: 'There is no site with this code in the market configuration.', why: `Site ${code} is not configured.`, whatYouCanDo: ['Choose a site of the list.'], whoCanHelp: ['The master-data steward'], controls: ['IN-52'] });
  return id;
}

export interface SiteValueInput {
  site: string;
  key: string;
  value: string;
  effectiveFrom: string;
  justificationRef?: string | undefined;
}

/** market.site_value_preview for the input, with the record a QA approval of the loosening signs (when there is one). */
export async function sitePreview(db: Db, input: SiteValueInput): Promise<{ preview: market.SiteValuePreview; siteId: string }> {
  const siteId = await siteIdOf(db, input.site);
  const preview = await market.siteValuePreview(db, {
    siteId, key: input.key, value: ruleValueOf(input.value), effectiveFrom: input.effectiveFrom, ...(input.justificationRef ? { justificationRef: input.justificationRef } : {}),
  });
  return { preview, siteId };
}

interface PolicyRow { code: string; title: string; level: 'VENDOR' | 'TENANT'; controls: string[]; positions: string[]; default_position: string; loosening_requires: string; current: string | null }
interface VersionRow {
  id: string; policy_code: string; version: number; position: string; direction: MarketPolicyView['versions'][number]['direction']; from_us: string; at_us: string;
  author: string; approver: string | null; change_ref: string | null; reason: string;
}

export async function policyViews(app: AppContext, db: Db, code?: string): Promise<MarketPolicyView[]> {
  const { rows } = await db.query<PolicyRow>(
    `select p.code, p.title, p.level, p.controls, array(select jsonb_array_elements_text(p.positions)) as positions, p.default_position, p.loosening_requires,
            (select v.position from market.policy_version v where v.policy_code = p.code and v.effective_from <= clock_timestamp()
              order by v.effective_from desc, v.version desc limit 1) as current
       from market.policy p where ($1::text is null or p.code = $1) order by p.code`,
    [code ?? null],
  );
  const { rows: versions } = await db.query<VersionRow>(
    `select v.id, v.policy_code, v.version, v.position, v.direction, ${usOf('v.effective_from')} as from_us, ${usOf('v.recorded_at')} as at_us,
            v.author_person_id as author, v.approver_person_id as approver, v.change_ref, v.reason
       from market.policy_version v where ($1::text is null or v.policy_code = $1) order by v.policy_code, v.version`,
    [code ?? null],
  );
  const people = await peopleOf(db, versions.flatMap((v) => [v.author, v.approver]));
  return rows.map((p) => ({
    code: p.code, title: p.title, level: p.level, controls: p.controls, positions: p.positions, defaultPosition: p.default_position, looseningRequires: p.loosening_requires, current: p.current,
    versions: versions.filter((v) => v.policy_code === p.code).map((v) => ({
      versionId: v.id, version: v.version, position: v.position, direction: v.direction, effectiveFrom: app.formatInstant(v.from_us), recordedAt: app.formatInstant(v.at_us),
      author: personRef(people, v.author, 'QA_MBR_APPROVER'), approver: v.approver ? personRef(people, v.approver, 'QA_REVIEWER') : null, changeRef: v.change_ref, reason: v.reason,
    })),
  }));
}

async function onePolicy(app: AppContext, db: Db, code: string): Promise<MarketPolicyView> {
  const [p] = await policyViews(app, db, code);
  if (!p) throw refusal(404, { code: 'EBMR-MKT-071', kind: 'INVALID_INPUT', whatHappened: 'There is no market policy with this code.', why: `Policy ${code} is not defined.`, whatYouCanDo: ['Reload the list of policies.'], whoCanHelp: ['QA'], controls: ['INV-47'] });
  return p;
}

export async function batchPoliciesView(app: AppContext, db: Db, batchId: string): Promise<BatchPoliciesView> {
  const { rows } = await db.query<{ policy: string; pin_kind: 'ISSUE' | 'TIGHTENING'; version: number; position: string; issue_us: string; at_us: string; change_ref: string | null; reason: string | null }>(
    `select p.policy_code as policy, p.pin_kind, v.version, v.position, ${usOf('p.issue_instant')} as issue_us, ${usOf('p.recorded_at')} as at_us, p.change_ref, p.reason
       from market.batch_policy_pin p join market.policy_version v on v.id = p.policy_version_id
      where p.batch_id = $1 order by p.policy_code, p.recorded_at, p.id`,
    [batchId],
  );
  return {
    batchId,
    pins: rows.map((r) => ({ policy: r.policy, pinKind: r.pin_kind, version: r.version, position: r.position, issueInstant: app.formatInstant(r.issue_us), recordedAt: app.formatInstant(r.at_us), changeRef: r.change_ref, reason: r.reason })),
  };
}

export async function siteValuesView(app: AppContext, db: Db): Promise<SiteValuesView> {
  const { rows: sites } = await db.query<{ id: string; code: string; markets: string[] }>('select id, code, markets from market.stub_site order by code');
  const { rows } = await db.query<{ id: string; site: string; key: string; value: unknown; unit: string; effective_from: string; outcome: SiteValuesView['values'][number]['outcome']; justification_ref: string | null; qa: string | null; by: string; at_us: string }>(
    `select v.id, s.code as site, v.key, v.value, v.unit, to_char(v.effective_from, 'YYYY-MM-DD') as effective_from, v.outcome, v.justification_ref, v.qa_approver_id as qa,
            v.recorded_by as by, ${usOf('v.recorded_at')} as at_us
       from market.site_value v join market.stub_site s on s.id = v.site_id order by s.code, v.key, v.effective_from desc, v.recorded_at desc limit 500`,
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.by, r.qa]));
  return {
    sites: sites.map((s) => ({ siteId: s.id, code: s.code, markets: s.markets })),
    values: rows.map((r) => ({
      siteValueId: r.id, site: r.site, key: r.key, value: valueText(r.value), unit: r.unit, effectiveFrom: r.effective_from, outcome: r.outcome, justificationRef: r.justification_ref,
      qaApprover: r.qa ? personRef(people, r.qa, 'QA_MBR_APPROVER') : null, recordedBy: personRef(people, r.by, 'MASTER_DATA_STEWARD'), recordedAt: app.formatInstant(r.at_us),
    })),
  };
}

/** The person's own reason and the change record the configuration change is made under (DI-09, DI-22). */
const underChange = (actor: (extras?: { reasonCode?: string; reasonText?: string }) => ActorContext, reasonCode: string, body: { changeRecord: string; reason: string }): ActorContext => ({
  ...actor({ reasonCode, reasonText: body.reason }),
  changeRecord: body.changeRecord,
});

type PolicyRoutes = 'policies' | 'definePolicy' | 'setPolicyVersion' | 'batchPolicies' | 'applyPolicyTightening' | 'siteValues' | 'previewSiteValue' | 'setSiteValue';

export function policyHandlers(app: AppContext): Pick<Handlers<Routes['marketConfig']>, PolicyRoutes> {
  const pool = app.pools.app;
  return {
    policies: async ({ requireSession }) => {
      requireSession();
      return { policies: await policyViews(app, pool) };
    },
    definePolicy: async ({ body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, underChange(actor, 'MARKET_POLICY', body), idempotencyKey ?? '', requestHash, async (c) => {
        const v = await market.definePolicy(c, {
          code: body.code, title: body.title, level: 'TENANT', controls: body.controls, positions: body.positions, defaultPosition: body.defaultPosition,
          looseningRequires: body.looseningRequires, reason: body.reason,
        });
        return v.id;
      });
      return onePolicy(app, pool, body.code);
    },
    setPolicyVersion: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      // The approver's POLICY_LOOSENING_APPROVED signature of exactly this version, when one is on its record; the database
      // asks for it only for a loosening and checks it (INV-47, DI-09).
      const target = await policyTarget(pool, params.code, body.position);
      const approvalId = target ? await latestApproval(pool, POLICY_AGGREGATE, target.aggregateId, 'POLICY_LOOSENING_APPROVED') : undefined;
      await withIdempotentActorCommand(pool, underChange(actor, 'MARKET_POLICY', body), idempotencyKey ?? '', requestHash, async (c) => {
        const v = await market.setPolicyVersion(c, params.code, body.position, {
          ...(body.effectiveFrom ? { effectiveFrom: body.effectiveFrom } : {}), ...(approvalId ? { approvalId } : {}), changeRef: body.changeRef, reason: body.reason,
        });
        return v.id;
      });
      return onePolicy(app, pool, params.code);
    },
    batchPolicies: async ({ params, requireSession }) => {
      requireSession();
      return batchPoliciesView(app, pool, params.batchId);
    },
    applyPolicyTightening: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor({ reasonCode: 'POLICY_TIGHTENING', reasonText: body.reason }), idempotencyKey ?? '', requestHash, async (c) => {
        await market.applyPolicyTightening(c, params.batchId, params.code, body.versionId, body.changeRef, body.reason);
        return params.batchId;
      });
      return batchPoliciesView(app, pool, params.batchId);
    },
    siteValues: async ({ requireSession }) => {
      requireSession();
      return siteValuesView(app, pool);
    },
    previewSiteValue: async ({ query, requireSession }): Promise<SiteValuePreviewView> => {
      requireSession();
      const { preview } = await sitePreview(pool, query);
      const approvalSigned = preview.approval ? (await latestApproval(pool, SITE_LOOSENING_AGGREGATE, preview.approval.aggregateId, 'SITE_VALUE_LOOSENING_APPROVED')) !== undefined : false;
      const r = preview.resolution as { value?: unknown; floorType?: unknown };
      return {
        outcome: preview.outcome, code: preview.code ?? null, message: preview.message ?? null,
        resolvedValue: r.value === undefined || r.value === null ? null : valueText(r.value), floorType: typeof r.floorType === 'string' ? r.floorType : null, approvalSigned,
      };
    },
    setSiteValue: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { preview, siteId } = await sitePreview(pool, body);
      const qaApprovalId = preview.approval ? await latestApproval(pool, SITE_LOOSENING_AGGREGATE, preview.approval.aggregateId, 'SITE_VALUE_LOOSENING_APPROVED') : undefined;
      await withIdempotentActorCommand(pool, underChange(actor, 'SITE_VALUE', body), idempotencyKey ?? '', requestHash, async (c) => {
        const sv = await market.setSiteValue(c, {
          siteId, key: body.key, value: ruleValueOf(body.value), effectiveFrom: body.effectiveFrom,
          ...(body.justificationRef ? { justificationRef: body.justificationRef } : {}), ...(qaApprovalId ? { qaApprovalId } : {}),
        });
        return sv.id;
      });
      return siteValuesView(app, pool);
    },
  };
}
