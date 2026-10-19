/**
 * [meta] Every database act a person performs is called by a route (decision 0025, point 2; slice 7g-5). The web app's
 * screen-completeness test (apps/tablets-web/test/meta/screen-completeness.test.ts) proves that every route a person
 * calls has a screen; it cannot see an act that has a database function and no route at all (role-permission requests,
 * delegations and the US e-signature certification had none before slice 7g-5). This test closes that gap from the
 * database side.
 *
 * The acts: every SECURITY DEFINER function owned by ebmr_owner, EXECUTE-granted to the application role, not a trigger,
 * whose body asks iam.require_permission for a permission that a role a person holds (account kind HUMAN) has now.
 *
 * Called by a route: the function's name appears in the server's source (apps/tablets-server/src), or in a declaration
 * of a package (kernel, recipe-core, site-services) that the server's source names, directly or through other such
 * declarations; or it is called in the body of a function or view that is so called or read (the closure over the SQL
 * bodies and view definitions, which the code map cannot see). A name in a reached declaration counts even in a comment, so the test is a net, not a proof:
 * what it reports is certainly not called by a route.
 *
 * Every act not called by a route is listed below with its reason. The test fails on an act missing from the lists, on a
 * listed act that a route now calls (remove it), and on a listed name that is not such an act.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Run by a service identity or another component, never by a person at a screen. */
const SERVICE_OR_INTERNAL: Readonly<Record<string, string>> = {
  'iam.escalate_overdue_alerts': 'run by the scheduler under a SERVICE account (kernel 0130: an unanswered security alert escalates); no person runs it',
  'iam.record_mirror_heartbeat': 'the qualification mirror (LMS feed) records its heartbeat under its integration identity, so the freshness of mirrored records is known; no person runs it',
  'market.evaluate_stub_scope': 'the market evaluation of a stub batch (Phase 2 stand-in, recipe.stub_batch)',
  'recipe.create_stub_batch': 'the Phase 2 stand-in for batches (recipe.stub_batch, recipe-core 0170), replaced by the GMP batch issue of Phase 3; kept for the recipe-core tests, no batch of v1.0 is a stub',
  'recipe.issue_stub_batch': 'the Phase 2 stand-in for batches (recipe.stub_batch), replaced by the GMP batch issue of Phase 3',
  'recipe.record_in_flight_disposition': 'the disposition of a stub batch (recipe.in_flight_disposition references recipe.stub_batch) when its MBR is superseded; Phase 2 stand-in',
  'recipe.set_stub_batch_status': 'the Phase 2 stand-in for batches (recipe.stub_batch): its status machine, replaced by the batch record machine of Phase 3',
};

/** Persons' acts whose screens later parts of slice 7g build (each removed by the slice that adds its route and screen). */
const PENDING_7G: Readonly<Record<string, string>> = {
  // WP1 (validation, export, records)
  'platform.describe_interface': '7g-3: the approved system description of slice 7c (an interface described under a change record)',
  // WP2 (continuity, platform, access configuration)
  'continuity.after_restore': '7g-4: backups and restore (the completion of a restore)',
  'continuity.approve_restore_event': '7g-4: backups and restore (the second person\'s approval of a restore)',
  'continuity.record_restore_event': '7g-4: backups and restore (the record of a restore with its external anchors)',
  'continuity.secure_identifiers': '7g-4: backups and restore (identifiers moved past the external high-water marks before work resumes)',
  'iam.set_integration_adapter_status': '7g-4: adapters started and stopped (an integration adapter\'s status)',
  'platform.set_installation_identity': '7g-4: the first-run set-up (this installation\'s code and key)',
  // WP3 (master record, market and plant configuration): none
  // WP4 (floor, materials, batch numbers): none
};

/** Persons' acts this test found with no route and no screen, that no part of slice 7g names yet (defect log 7g5-1). */
const NO_ROUTE_YET: Readonly<Record<string, string>> = {
  // WP1 (validation, export, records)
  'records.approve_evaluation_pack': 'approving a periodic evaluation pack (PERIODIC_EVALUATION_APPROVED; today only the records CLI of slice 7b-2 calls it)',
  'esig.add_meaning_type': 'a customer signature point: a new e-signature meaning type, under change control',
  'esig.configure_meaning_type': 'a new version of an e-signature meaning type (who may sign, independence, re-authentication)',
  'esig.retire_seal_key': 'retiring a record-seal key (SYSTEM.CONFIGURE)',
  'records.approve_purge': 'approving the purge of records past retention (RECORD.DISPOSAL_APPROVE)',
  'records.approve_record_type': 'approving a record type (RECORD.TYPE_APPROVE)',
  'records.close_di_investigation': 'approving the closure of a data-integrity investigation (DI_INVESTIGATION.APPROVE_CLOSURE)',
  'records.define_record_type': 'defining a record type of the records register (RECORD.TYPE_DEFINE)',
  'records.link_di_investigation': 'linking records to a data-integrity investigation (VALIDATION.MANAGE)',
  'records.open_di_investigation': 'opening a data-integrity investigation (VALIDATION.MANAGE)',
  'records.place_legal_hold': 'placing a legal hold on a record (RECORD.LEGAL_HOLD)',
  'records.refresh_di_investigation_scope': 'reading a data-integrity investigation\'s scope again (VALIDATION.MANAGE)',
  'records.release_legal_hold': 'releasing a legal hold (RECORD.LEGAL_HOLD)',
  // WP2 (continuity, platform, access configuration)
  'continuity.acknowledge_alarm': 'acknowledging a continuity alarm (backup, clock and audit-chain alarms; CONTINUITY.ALARM_ACKNOWLEDGE)',
  'continuity.revoke_hardening_attestation': 'revoking a kiosk hardening attestation (the device screen of 7g-1 records one)',
  'iam.acknowledge_alert': 'acknowledging a security alert (DI-19: acknowledgement tracked, unanswered alerts escalate)',
  'iam.add_qualification_requirement': 'a qualification an act or role requires (TRAINING.MANAGE)',
  'iam.create_qualification_type': 'a qualification type of the matrix (TRAINING.MANAGE; area authorisations have their own route)',
  'iam.create_role': 'a customer role (IAM.ROLE_MANAGE); its permissions then follow the role-permission requests of slice 7g-5',
  'iam.end_qualification_requirement': 'ending a qualification requirement (TRAINING.MANAGE)',
  'iam.rehire_person': 'rehiring a person who left (IAM.PERSON_MANAGE; a new identity check follows)',
  'plant.enrol_opcua_endpoint': 'enrolling an OPC UA endpoint\'s identity (IAM.DEVICE_MANAGE)',
  'plant.retire_opcua_endpoint': 'retiring an OPC UA endpoint (IAM.DEVICE_MANAGE)',
  'platform.revoke_peer_installation': 'revoking a trusted peer installation (TRANSFER.PEER_APPROVE); the proposal and approval have screens',
  'tab.link_process_device_unit': 'linking a process device to its plant unit',
  'tab.set_attribution_method': 'the per-entry attribution of a device class (IAM.POLICY_MANAGE; decision D8)',
  // WP3 (master record, market and plant configuration)
  'market.apply_policy_tightening': 'applying a tightened market policy to an issued batch (MARKET.POLICY_TIGHTEN_BATCH)',
  'market.define_policy': 'defining a market policy (the kernel\'s market policies)',
  'market.pin_policies_for_batch': 'pinning the market policies of a batch at issue; no GMP batch issue calls it (to be decided whether v1.0 uses the kernel\'s market policies)',
  'market.set_policy_version': 'a new version of a market policy (a loosening needs an approver\'s signature)',
  'market.set_site_value': 'a site value of the market configuration (area SITE_VALUE, under change control)',
  'plant.close_campaign': 'closing an equipment campaign (MASTERDATA.CHANGE)',
  'plant.define_alarm_code': 'configuring a plant alarm code (GMP-critical, deviation required; MASTERDATA.CHANGE)',
  'plant.open_campaign': 'opening an equipment campaign (MASTERDATA.CHANGE)',
  'plant.set_utility_feed_age': 'the maximum age of a utility feed\'s reading',
  'recipe.add_change_regulatory': 'the regulatory assessment of an MBR change per market (MBR.CHANGE_RECORD; PR-04)',
  'recipe.add_change_validation': 'the validation assessment of an MBR change (MBR.CHANGE_RECORD)',
  'recipe.record_periodic_review': 'the periodic review of an approved MBR version (MBR.APPROVE; PR-05)',
  'recipe.register_qp': 'registering an EU qualified person (RECORD.QA_REVIEW)',
  'recipe.unlink_risk_assessment': 'unlinking a risk assessment from an MBR version (MBR.AUTHOR)',
  'tab.record_line_isolation': 'a line isolation of the blister register',
  'tab.record_rule_set_verification': 'QA\'s verification of a compendial rule set version (MBR.APPROVE)',
  'tab.retire_reference_document': 'retiring or withdrawing a reference document version (MASTERDATA.CHANGE); the list has a screen since slice 7g-5',
  'tab.sign_rule_set_verification': 'binding QA\'s signature to a rule-set verification (MBR.APPROVE)',
  // WP4 (floor, materials, batch numbers): none (slice 7g WP4 gave every one its route and screen)
};

const LISTS = { SERVICE_OR_INTERNAL, PENDING_7G, NO_ROUTE_YET };

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== 'node_modules') walk(p);
      } else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

/** The top-level declarations of the packages' sources, each with its text (up to the next declaration). */
function declarations(): { name: string; body: string }[] {
  const units: { name: string; body: string }[] = [];
  for (const pkg of ['kernel', 'recipe-core', 'site-services']) {
    for (const t of sources(join(ROOT, 'packages', pkg, 'src'))) {
      const starts = [...t.matchAll(/^(?:export )?(?:async )?(?:function\*? (\w+)|const (\w+)\s*[:=]|class (\w+))/gm)];
      starts.forEach((m, i) => units.push({ name: m[1] ?? m[2] ?? m[3] ?? '', body: t.slice(m.index, starts[i + 1]?.index ?? t.length) }));
    }
  }
  return units;
}

const named = (name: string, text: string): boolean => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(text);

let server: TestServer;
let acts: string[] = [];
let unreached: string[] = [];

beforeAll(async () => {
  server = await startServer('GMP');
  const { rows: actRows } = await server.db.admin.query<{ fn: string }>(`
    with f as (
      select n.nspname || '.' || p.proname as fn, p.prosrc
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace join pg_catalog.pg_roles r on r.oid = p.proowner
       where p.prosecdef and r.rolname = 'ebmr_owner' and has_function_privilege('ebmr_app', p.oid, 'EXECUTE') and p.prorettype <> 'trigger'::regtype
    ), perms as (
      select f.fn, (regexp_matches(f.prosrc, $$require_permission\\(\\s*'([A-Z_.]+)'$$, 'g'))[1] as perm from f
    )
    select distinct perms.fn from perms
     where exists (select 1 from iam.role_permission rp join iam.role ro on ro.code = rp.role_code
                    where rp.permission_code = perms.perm and rp.removed_at is null and 'HUMAN' = any (ro.account_kinds))
     order by 1`);
  acts = actRows.map((r) => r.fn);
  const { rows: all } = await server.db.admin.query<{ fn: string; src: string }>(`
    select n.nspname || '.' || p.proname as fn, string_agg(p.prosrc, E'\\n') as src
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
     group by 1
    union all
    select schemaname || '.' || viewname, definition from pg_catalog.pg_views
     where schemaname not in ('pg_catalog', 'information_schema')`);
  const bodyOf = new Map(all.map((r) => [r.fn, r.src]));

  // The TypeScript the routes run: the server's source and the package declarations it reaches.
  const server_ = sources(join(ROOT, 'apps', 'tablets-server', 'src')).join('\n');
  const units = declarations().filter((u) => u.name !== '');
  const reachedUnits = new Set(units.filter((u) => named(u.name, server_)));
  for (let grew = true; grew; ) {
    grew = false;
    const text = [...reachedUnits].map((u) => u.body).join('\n');
    for (const u of units) {
      if (!reachedUnits.has(u) && named(u.name, text)) {
        reachedUnits.add(u);
        grew = true;
      }
    }
  }
  const ts = `${server_}\n${[...reachedUnits].map((u) => u.body).join('\n')}`;
  // Then the SQL functions those call, and every function their bodies call.
  const reached = new Set([...bodyOf.keys()].filter((fn) => ts.includes(fn)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of [...reached]) {
      const body = bodyOf.get(f) ?? '';
      for (const g of bodyOf.keys()) {
        if (!reached.has(g) && body.includes(`${g}(`)) {
          reached.add(g);
          grew = true;
        }
      }
    }
  }
  unreached = acts.filter((fn) => !reached.has(fn));
}, 300_000);

afterAll(async () => {
  await server?.close();
});

describe('[meta] every database act a person performs is called by a route (decision 0025)', () => {
  it('[meta] finds the acts of the database, among them the three slice 7g-5 gave routes', () => {
    expect(acts.length).toBeGreaterThan(100);
    for (const fn of ['iam.add_role_permission', 'iam.decide_role_permission', 'iam.remove_role_permission', 'iam.decide_delegation', 'iam.revoke_delegation', 'iam.record_us_esig_certification']) {
      expect(acts, fn).toContain(fn);
      expect(unreached, `${fn} is called by a route (slice 7g-5)`).not.toContain(fn);
    }
  });

  it('[meta] every act a person performs is called by a route, or listed with its reason', () => {
    const listed = new Set(Object.values(LISTS).flatMap((l) => Object.keys(l)));
    expect(unreached.filter((fn) => !listed.has(fn)), 'database acts no route calls: add the route and its screen, or list the act with its reason').toEqual([]);
  });

  it('[meta] a listed act is an act of the database, in one list only, with its reason, and still not called by a route', () => {
    const all = Object.values(LISTS).flatMap((l) => Object.keys(l));
    expect(all.filter((fn) => !acts.includes(fn)), 'listed but not a person\'s database act').toEqual([]);
    expect(all.filter((fn, i) => all.indexOf(fn) !== i), 'listed twice').toEqual([]);
    expect(all.filter((fn) => !unreached.includes(fn)), 'listed but now called by a route: remove it from the list').toEqual([]);
    for (const [name, list] of Object.entries(LISTS)) for (const [fn, why] of Object.entries(list)) expect(why.trim(), `${name} ${fn} gives its reason`).not.toBe('');
  });
});
