/**
 * The signed acts of slice 7g WP3 through C1's ceremony (decision 0025). Each signs a record the database names and runs
 * the database's own command with the signature in the same command; when the database refuses, nothing is signed.
 *
 *   action            aggregate                                         meaning                          command
 *   QP_REGISTER       qp_register <person>/<action>/<importer>/<MIA>    QP_REGISTERED                    recipe.register_qp
 *   RULE_SET_VERIFY   compendial_rule_set <CODE>:<version>              COMPENDIAL_RULE_SET_VERIFIED     tab.sign_rule_set_verification
 *   MARKET_LOOSENING  market_policy_version <policy>@<n>@<position>     POLICY_LOOSENING_APPROVED        none: the signature is the
 *                     market_site_loosening <site>@<key>@...            SITE_VALUE_LOOSENING_APPROVED    approval the change carries
 *
 * A loosening is signed before it is made (kernel 0360): the record's state is PROPOSED, and the change that follows
 * (marketConfig.setPolicyVersion, marketConfig.setSiteValue) carries the signature, which the database checks: exactly
 * this change, and never signed by the person who makes it (EBMR-MKT-075, EBMR-MKT-066).
 */
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { dbActHandler, refusedOutcome, type ActTarget } from '../esig/db-acts.ts';
import { POLICY_AGGREGATE, policyTarget, SITE_LOOSENING_AGGREGATE, sitePreview } from './policies.ts';

type QpRegister = Extract<SignableAction, { kind: 'QP_REGISTER' }>;
type RuleSetVerify = Extract<SignableAction, { kind: 'RULE_SET_VERIFY' }>;
type MarketLoosening = Extract<SignableAction, { kind: 'MARKET_LOOSENING' }>;

/** An aggregate id no record has: the dry run then answers that the record to be signed was not found. */
const NO_RECORD = 'none';

export function qpRegisterHandler(app: AppContext): SignableActionHandler<QpRegister> {
  return dbActHandler<QpRegister>(app, {
    kind: 'QP_REGISTER',
    // D-P7R-6: GOVERNANCE class (tablets 1161); the signer reads it in their own session (tablets 1493).
    readForSigner: true,
    aggregateTypes: ['qp_register'],
    target: (a) => ({ aggregateType: 'qp_register', aggregateId: `${a.personId}/${a.action}/${a.importerCode}/${a.miaNumber}`, meaning: 'QP_REGISTERED' }),
    async apply(client, _ctx, a, signatureId) {
      const { rows } = await client.query<{ id: string }>('select recipe.register_qp($1, $2, $3, $4, $5) as id', [a.personId, a.action, a.importerCode, a.miaNumber, signatureId]);
      return { entryId: rows[0]?.id ?? null, action: a.action };
    },
  });
}

export function ruleSetVerifyHandler(app: AppContext): SignableActionHandler<RuleSetVerify> {
  return dbActHandler<RuleSetVerify>(app, {
    kind: 'RULE_SET_VERIFY',
    // D-P7R-6: GOVERNANCE class (tablets 1161); the signer reads it in their own session (tablets 1493).
    readForSigner: true,
    aggregateTypes: ['compendial_rule_set'],
    target: (a) => ({ aggregateType: 'compendial_rule_set', aggregateId: `${a.code}:${String(a.version)}`, meaning: 'COMPENDIAL_RULE_SET_VERIFIED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select tab.sign_rule_set_verification($1, $2, $3)', [a.code, a.version, signatureId]);
      return { code: a.code, version: a.version, signed: 'COMPENDIAL_RULE_SET_VERIFIED' };
    },
  });
}

function looseningTarget(a: MarketLoosening, aggregateId: string): ActTarget {
  return a.target.subject === 'POLICY_VERSION'
    ? { aggregateType: POLICY_AGGREGATE, aggregateId, meaning: 'POLICY_LOOSENING_APPROVED', expectedState: 'PROPOSED' }
    : { aggregateType: SITE_LOOSENING_AGGREGATE, aggregateId, meaning: 'SITE_VALUE_LOOSENING_APPROVED', expectedState: 'PROPOSED' };
}

export function marketLooseningHandler(app: AppContext): SignableActionHandler<MarketLoosening> {
  return dbActHandler<MarketLoosening>(app, {
    kind: 'MARKET_LOOSENING',
    aggregateTypes: [POLICY_AGGREGATE, SITE_LOOSENING_AGGREGATE],
    target: (a) => looseningTarget(a, NO_RECORD),
    // The database names the record (the policy's next version number; the value a site departs from). Read on the pool,
    // outside the signing command, so a refused read (an unknown policy, site or key) cannot abort that command.
    async targetNow(_db, a) {
      const pool = app.pools.app;
      if (a.target.subject === 'POLICY_VERSION') return looseningTarget(a, (await policyTarget(pool, a.target.policy, a.target.position))?.aggregateId ?? NO_RECORD);
      const p = await sitePreview(pool, a.target).catch(() => null);
      return looseningTarget(a, p?.preview.approval?.aggregateId ?? NO_RECORD);
    },
    async precheck(_client, _ctx, a) {
      if (a.target.subject !== 'SITE_VALUE') return null;
      const p = await sitePreview(app.pools.app, a.target).catch(() => null);
      if (p && p.preview.outcome !== 'LOOSENING') {
        return refusedOutcome(
          422, 'EBMR-MKT-065', 'This site value does not loosen a guidance value, so there is nothing to approve. Nothing was signed.',
          `The site value ${a.target.value} for ${a.target.key} is ${p.preview.outcome.toLowerCase()}${p.preview.message ? `: ${p.preview.message}` : ''}.`, ['IN-52', 'ST-01'], ['Check the value and the key.'],
        );
      }
      return null;
    },
    // The signature is the approval; the change itself follows, made by another person, and carries it.
    apply: (_client, _ctx, a, signatureId) => Promise.resolve({ approvalId: signatureId, subject: a.target.subject }),
  });
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(qpRegisterHandler(app));
  registry.register(ruleSetVerifyHandler(app));
  registry.register(marketLooseningHandler(app));
}
