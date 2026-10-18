/**
 * Phase 7 slice 7b-1 (review residual 6jc-R7): the authorization meta scan of the Tablets schema `tab` on a Tablets GMP
 * database (the kernel's scan covers iam, esig and sandbox, recipe-core's covers plant; the scan itself is
 * packages/kernel/test/support/authorization-scan.ts). Every function the application role may execute that can write
 * checks a known permission, is a proven delegate of one that does, or is listed here with its reason: the session and
 * device plumbing of the person's own session, and the reads of the signing ceremony, which check the reader through
 * tab.record_read_problem and its kin rather than a permission of their own.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { copyDatabase, dropDatabase, openDatabase, uniqueSuffix, type DatabaseHandle } from '@ebmr/test-kit';
import { authorizationScan, type ScanRules } from '../../../../packages/kernel/test/support/authorization-scan.ts';

let db: DatabaseHandle;

beforeAll(async () => {
  const name = `ebmr_t_${uniqueSuffix()}`;
  await copyDatabase(inject('serverTemplates').gmp.template, name);
  db = openDatabase(name, 'GMP');
});

afterAll(async () => {
  if (!db) return;
  await db.close();
  await dropDatabase(db.name);
});

const READ = 'a read of the signing ceremony; writes nothing';
const TAB: ScanRules = {
  ungated: {
    // The person's own session and terminal (DI-19, DI-20).
    'tab.bind_session(uuid,text,text)': 'login plumbing: binds a person\'s session opened in the last 10 s to its cookie (EBMR-TAB-010, -011)',
    'tab.unbind_session(text)': 'logout plumbing: unbinds the caller\'s own cookie',
    'tab.set_session_role(text,text)': 'declares, once, the role the session acts in, which its account must hold now (EBMR-TAB-013 to -015)',
    'tab.keep_session_alive(text,uuid)': 'the session\'s own keep-alive, with a fresh authentication (iam.keep_session_alive)',
    'tab.unlock_session(text,uuid)': 'the session\'s own unlock, with a fresh authentication (iam.unlock_session)',
    'tab.end_withdrawn_session(text)': 'ends a session whose declared role was withdrawn; it only takes away what the session already lost',
    'tab.engine_roles()': 'which engine roles the actor\'s kernel role gives in its scope (stored iam.evaluate_authority evaluations); writes nothing else',
    'tab.engine_roles(uuid)': 'as tab.engine_roles() in a batch\'s scope; writes nothing else',
    'tab.mint_device_nonce(text,integer)': 'request plumbing: a device nonce valid at most 5 minutes; no record content',
    'tab.consume_device_nonce(text)': 'request plumbing: uses a device nonce once; no record content',
    // The gateway's own session and its refusals (DI-31).
    'tab.bind_gateway_session(uuid,text,text)': 'gateway login plumbing: binds a gateway session opened in the last 10 s to its token (EBMR-DEV-020, -021)',
    'tab.unbind_gateway_session(text)': 'gateway logout plumbing: unbinds the caller\'s own token',
    'tab.record_gateway_refusal(text,text,text,text,text,text,jsonb)': 'raises the device alarm of a refused reading or gateway login; changes no record',
    'tab.scale_status(text)': 'reads the scales\' status for a room; writes nothing',
    // The reads of the signing ceremony: each checks the reader itself.
    'tab.content_for_signing(text,text,text,text)': `${READ} (a kernel signing meaning of the type, the reader passes tab.signing_preview_problem_for)`,
    'tab.controlled_preview(text,text,text,text)': `${READ} (the reader's role may sign the meaning and holds CONTROLLED.READ in scope, tablets 1414)`,
    'tab.support_grant_preview(text,uuid,text)': `${READ} (the reader's role may sign the meaning, tablets 1276)`,
    'tab.record_signatures(text,text,text)': `${READ} (the reader passes tab.record_read_problem)`,
    'tab.record_content_for_signing(text,text)': 'RECORD-class content only, read by the server inside its commands (tablets 0410); writes nothing',
    'tab.signatures_of(text,text)': 'RECORD-class signatures only, read by the server for its screens (tablets 0410); writes nothing',
    'tab.record_signing_failure(text,uuid,uuid,text,text)': 'logs a failed signing against the session\'s own challenge (EBMR-ESIG-031); records the failure only',
  },
  delegates: {
    'tab.define_detector(jsonb)': 'plant.define_equipment',
    'tab.peek_weighing_readings(uuid,uuid,text,bigint)': 'tab.claim_readings',
    'tab.record_serial_events(text,jsonb)': 'tab.acting_pool',
    'tab.record_serial_report(text,jsonb)': 'tab.acting_pool',
    'tab.take_qp_certification_message(text,text)': 'recipe.take_qp_message',
  },
  adminAfterPermission: {
    'tab.ingest_reading(jsonb,bigint,uuid,text)': 'asks INTERFACE.WRITE in its declarations, then refuses administrators before it reads or writes anything',
    'tab.issue_ingest_challenge()': 'asks INTERFACE.WRITE in its declarations, then refuses administrators before it reads or writes anything',
    'tab.record_gateway_api_contact(text,boolean,text)': 'asks its permission in its declarations, then refuses administrators before it reads or writes anything',
    'tab.record_heartbeat(jsonb)': 'asks INTERFACE.WRITE in its declarations, then refuses administrators before it reads or writes anything',
    'tab.register_sandbox_lot(jsonb)': 'asks MASTERDATA.CHANGE in its declarations, then refuses administrators before it reads or writes anything',
  },
};

describe('the authorization scan of the Tablets schema (6jc-R7)', () => {
  it('[DI-17][DI-18] every app-callable writer of tab checks a known permission or is listed with its reason, refuses administrators first when it names a GMP permission, and no tab table is app-writable', async () => {
    const r = await authorizationScan(db.admin, ['tab'], TAB);
    expect(r.functions).toBeGreaterThanOrEqual(60);
    expect(r.ungated).toEqual([]);
    expect(r.unknownPermissions).toEqual([]);
    expect(r.adminNotFirst).toEqual([]);
    expect(r.staleEntries).toEqual([]);
    expect(r.appWritableTables).toEqual([]);
  });
});
