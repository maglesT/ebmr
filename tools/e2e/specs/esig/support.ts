/**
 * E2E support for module C1's specs: kernel stub entries (aggregate esig_stub) created directly in the E2E
 * database by an office persona of this worker (a validated command through kernel.begin_command), and small
 * page helpers for the PIN pads of the signing and lock dialogs.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type pg from 'pg';
import { openDatabase, openPersonaSession, type SiteSeed } from '@ebmr/test-kit';
import { readerTap } from '../../fixtures/index.ts';
import type { E2eState } from '../../fixtures/state.ts';

type Installation = 'GMP' | 'SANDBOX';

export interface StubInput {
  kind?: 'STEP' | 'CLEANING_LOG' | 'MASTER_DOCUMENT';
  title?: string;
  value?: string;
  unit?: string;
}

/** Runs one command of an office persona (kernel.begin_command), then ends the persona's session. */
async function asPersona<T>(state: E2eState, seed: SiteSeed, installation: Installation, personaKey: string, reason: { code: string; text: string } | null, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = openDatabase(state.databases[installation], installation);
  try {
    const actor = await openPersonaSession(db, seed, personaKey);
    const ctx = {
      person_id: actor.personId,
      account_id: actor.accountId,
      role_code: actor.roleCode,
      session_id: actor.sessionId,
      source: 'UI',
      site_zone: actor.siteZone,
      correlation_id: randomUUID(),
      legal_name: actor.legalName ?? '',
      device_id: actor.deviceId,
      ...(reason ? { reason_code: reason.code, reason_text: reason.text } : {}),
    };
    const c = await db.app.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(ctx)]);
      const out = await work(c);
      await c.query('commit');
      return out;
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
      await db.app.query('select iam.end_session($1)', [actor.sessionId]);
    }
  } finally {
    await db.close();
  }
}

/** A stub entry entered by an office persona (that person entered its data). */
export async function createStub(state: E2eState, seed: SiteSeed, installation: Installation, personaKey: string, input: StubInput = {}): Promise<string> {
  return asPersona(state, seed, installation, personaKey, null, async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into esig.stub_signable (kind, title, value, unit) values ($1, $2, $3, $4) returning id', [
      input.kind ?? 'STEP',
      input.title ?? 'Granulation: binder solution added',
      input.value ?? '12.503',
      input.unit ?? 'kg',
    ]);
    return rows[0]?.id ?? '';
  });
}

/** A correction of the stub's value with a reason (DI-24). */
export async function correctStub(state: E2eState, seed: SiteSeed, installation: Installation, personaKey: string, id: string, value: string): Promise<void> {
  await asPersona(state, seed, installation, personaKey, { code: 'ENTRY_ERROR', text: 'transcription error corrected' }, (c) => c.query('update esig.stub_signable set value = $2 where id = $1', [id, value]));
}

/** Signatures on a stub entry, read by the superuser (evidence for the test). */
export async function stubSignatures(state: E2eState, installation: Installation, id: string): Promise<{ meaning_code: string; signer_login: string }[]> {
  const db = openDatabase(state.databases[installation], installation);
  try {
    const { rows } = await db.admin.query<{ meaning_code: string; signer_login: string }>("select meaning_code, signer_login from esig.signature where aggregate_ref = 'esig_stub:' || $1 order by recorded_at", [id]);
    return rows;
  } finally {
    await db.close();
  }
}

/** What the database holds about a stub entry and a person, read by the superuser (evidence that a request recorded nothing). */
export interface StubRecords {
  /** Challenges on the stub entry. */
  challenges: number;
  /** Audit entries whose actor is the person. */
  auditEntries: number;
  /** Authentication events of the person (sign-in, taps, unlocks, signatures). */
  authEvents: number;
}

export async function stubRecords(state: E2eState, installation: Installation, stubId: string, personId: string): Promise<StubRecords> {
  const db = openDatabase(state.databases[installation], installation);
  try {
    const { rows } = await db.admin.query<StubRecords>(
      `select (select count(*) from esig.challenge where aggregate_ref = 'esig_stub:' || $1)::int as "challenges",
              (select count(*) from kernel.audit_event where payload -> 'actor' ->> 'person_id' = $2)::int as "auditEntries",
              (select count(*) from iam.auth_event where person_id = $2::uuid)::int as "authEvents"`,
      [stubId, personId],
    );
    const r = rows[0];
    if (!r) throw new Error('no counts');
    return r;
  } finally {
    await db.close();
  }
}

/** Types a PIN on the keypad whose group has this accessible name, then OK. */
export async function enterPinOn(page: Page, padName: string, value: string): Promise<void> {
  const pad = page.getByRole('group', { name: padName });
  for (const digit of value) await pad.getByRole('button', { name: digit, exact: true }).click();
  await pad.getByRole('button', { name: 'OK', exact: true }).click();
}

/** A badge tap into the focused badge prompt (keyboard wedge: the UID as a burst of keys, then Enter). */
export async function tapInto(page: Page, badgeUid: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Badge', exact: true });
  await field.focus();
  await readerTap(page, badgeUid);
}
