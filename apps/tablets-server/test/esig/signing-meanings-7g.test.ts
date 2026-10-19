/**
 * Slice 7g integration of the four work packages (decision 0025):
 *  - tab.kernel_signing_meanings was re-created from tablets 1479 by 1491 (WP1), 1493 (WP3), 1496 (WP4) and 1525 (WP2);
 *    each copied the whole function, so only the highest-numbered one is in force. Every meaning any of them added must
 *    resolve, or the ceremony refuses the act's content (EBMR-TAB-019).
 *  - Decision D-P7R-6: a compendial rule set and a qualified person's registration stay GOVERNANCE class (tablets 1161);
 *    WP3's reclassification to RECORD was rejected. The signer reads them in their own session (tablets 1493,
 *    tab.record_read_problem); a role with only RECORD.READ reads neither.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { asSetup } from '../blocks/compression/plant-support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import type { TestServer } from '../support/harness.ts';
import { startSigningServer } from './support.ts';

let gmp: TestServer;

const outcome = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error.kind === 'REFUSAL' ? `${r.error.status}:${r.error.envelope.refusal.code}` : r.error.kind);

/** What each slice 7g work package added to tab.kernel_signing_meanings (diffed against the 1479 definition). */
const ADDED_7G: ReadonlyArray<readonly [migration: string, aggregateType: string, meaning: string]> = [
  ['1491 WP1', 'validation_summary', 'VALIDATION_SUMMARY_APPROVED'],
  ['1491 WP1', 'evaluation_pack', 'PERIODIC_EVALUATION_APPROVED'],
  ['1491 WP1', 'record_type_version', 'RECORD_TYPE_APPROVED'],
  ['1491 WP1', 'record_disposal', 'RECORD_DISPOSAL_APPROVED'],
  ['1491 WP1', 'di_investigation', 'DI_INVESTIGATION_CLOSED'],
  ['1493 WP3', 'market_policy_version', 'POLICY_LOOSENING_APPROVED'],
  ['1493 WP3', 'market_site_loosening', 'SITE_VALUE_LOOSENING_APPROVED'],
  ['1496 WP4', 'material_lot', 'MATERIAL_DESTRUCTION_WITNESSED'],
  ['1525 WP2', 'restore_event', 'RESTORE_APPROVED'],
];

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('the signing meanings of slice 7g (tablets 1491, 1493, 1496, 1525)', () => {
  it('[DI-37] every meaning a slice 7g work package added resolves for its record type, and is an active meaning type of the catalogue', async () => {
    for (const [migration, type, meaning] of ADDED_7G) {
      const { rows } = await gmp.db.admin.query<{ resolves: boolean; active: boolean }>(
        `select $2 = any (tab.kernel_signing_meanings($1)) as resolves,
                exists (select 1 from esig.meaning_type m where m.code = $2 and m.status = 'ACTIVE') as active`,
        [type, meaning],
      );
      expect({ migration, type, meaning, ...rows[0] }).toEqual({ migration, type, meaning, resolves: true, active: true });
    }
    // The meanings the lot already had before WP4 still resolve beside the witness's.
    const lot = await gmp.db.admin.query<{ m: string[] }>("select tab.kernel_signing_meanings('material_lot') as m");
    expect(lot.rows[0]?.m).toEqual(['MATERIAL_LOT_RELEASED', 'MATERIAL_LOT_REJECTED', 'MATERIAL_LOT_STATUS_DECIDED', 'MATERIAL_DESTRUCTION_WITNESSED']);
  });
});

describe('decision D-P7R-6: the QP register and the compendial rule sets stay GOVERNANCE class', () => {
  it('[DI-17][DI-37] a role with only RECORD.READ reads neither a qp_register nor a compendial_rule_set record; the QA MBR approver who signs a rule set reads it', async () => {
    const classes = await gmp.db.admin.query<{ rs: string; qp: string }>("select tab.aggregate_read_class('compendial_rule_set') as rs, tab.aggregate_read_class('qp_register') as qp");
    expect(classes.rows[0]).toEqual({ rs: 'GOVERNANCE', qp: 'GOVERNANCE' });

    const role = 'RECORD_READER_7G';
    await asSetup(gmp, `insert into iam.role (code, name, role_group, description, account_kinds)
                        values ($1, 'Record reader (test)', 'QUALITY_RELEASE', 'Holds RECORD.READ only (D-P7R-6 test)', '{HUMAN}') on conflict do nothing`, [role]);
    await asSetup(gmp, "insert into iam.role_permission (role_code, permission_code) values ($1, 'RECORD.READ') on conflict do nothing", [role]);
    const perms = await gmp.db.admin.query<{ p: string[] }>('select iam.role_permissions_at($1, clock_timestamp()) as p', [role]);
    expect(perms.rows[0]?.p).toEqual(['RECORD.READ']);

    const { rows: sets } = await gmp.db.admin.query<{ id: string }>("select code || ':' || version as id from tab.compendial_rule_set order by code, version limit 1");
    const ruleSet = sets[0]?.id ?? '';
    expect(ruleSet).not.toBe('');
    const qpRecord = `${gmp.seed.personas.find((p) => p.key === 'author')?.personId ?? ''}/REGISTER/EUIMP-TEST/DE-MIA-2026-001`;

    const reader = await loginOf(gmp, await grantedPerson(gmp, role, 'Rita Reader (record reader)'));
    const read = (type: string, id: string, intent: string) => reader.call(routes.esig.content, { query: { aggregateType: type, aggregateId: id, intent } });
    expect(outcome(await read('compendial_rule_set', ruleSet, 'COMPENDIAL_RULE_SET_VERIFIED'))).toMatch(/^403:/);
    expect(outcome(await read('qp_register', qpRecord, 'QP_REGISTERED'))).toMatch(/^403:/);
    // In the database: the read check refuses that role for both, whatever the record.
    const { rows: problems } = await gmp.db.admin.query<{ rs: string | null; qp: string | null }>(
      `select tab.record_read_problem(row(null, null, null, $1, false)::tab.reader, 'compendial_rule_set', $2) as rs,
              tab.record_read_problem(row(null, null, null, $1, false)::tab.reader, 'qp_register', $3) as qp`,
      [role, ruleSet, qpRecord],
    );
    expect(problems[0]?.rs).toContain('D-P7R-6');
    expect(problems[0]?.qp).toContain('D-P7R-6');

    // The signer reads what they sign, in their own session: the QA MBR approver (MBR.APPROVE) previews the rule set.
    const approver = await gmp.asPersona('approver');
    expect(outcome(await approver.call(routes.esig.content, { query: { aggregateType: 'compendial_rule_set', aggregateId: ruleSet, intent: 'COMPENDIAL_RULE_SET_VERIFIED' } }))).toBe('ok');
  }, 180_000);
});
