/**
 * The ESIG_STUB signable action (DEMO-ONLY and tests): signs the kernel's stub entries (aggregate esig_stub, kernel
 * 0250), so the whole ceremony runs before the execution store (C3) lands. Registered by the server only on demo
 * installations (EBMR_DEMO=1 and the demo marker); tests register it themselves.
 *
 * It behaves like a small engine:
 *  - dry-run: the entry exists and is OPEN; a completing meaning (VERIFIED or WITNESSED for a STEP,
 *    LOGBOOK_DOUBLE_CHECKED for a cleaning-log entry, APPROVED for a master document) needs the valid
 *    prerequisite signature (PERFORMED, LOGBOOK_PERFORMED, CHECKED) first. A refusal writes nothing.
 *  - apply: a completing signature completes the entry through esig.stub_complete (which re-checks everything).
 */
import type pg from 'pg';
import { esig } from '@ebmr/kernel';
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { DryRunOutcome, SignableActionHandler, SignableContext } from '../../platform/ports.ts';
import { kernelContent, type EsigSignableContext } from './content.ts';

type StubAction = Extract<SignableAction, { kind: 'ESIG_STUB' }>;

const COMPLETING: Readonly<Record<string, { meanings: readonly string[]; prerequisite: string }>> = {
  STEP: { meanings: ['VERIFIED', 'WITNESSED'], prerequisite: 'PERFORMED' },
  CLEANING_LOG: { meanings: ['LOGBOOK_DOUBLE_CHECKED'], prerequisite: 'LOGBOOK_PERFORMED' },
  MASTER_DOCUMENT: { meanings: ['APPROVED'], prerequisite: 'CHECKED' },
};

const meaningOf = (ctx: SignableContext): string => (ctx as Partial<EsigSignableContext>).meaning ?? '';

async function stubRow(client: pg.PoolClient, id: string): Promise<{ kind: string; state: string } | null> {
  const { rows } = await client.query<{ kind: string; state: string }>('select kind, state from esig.stub_signable where id = $1', [id]);
  return rows[0] ?? null;
}

function refused(status: number, code: string, whatHappened: string, why: string, whatYouCanDo: string[]): DryRunOutcome {
  return { accepted: false, status, refusal: { code, kind: 'NOT_ALLOWED', whatHappened, why, controls: ['DI-35'], whatYouCanDo, whoCanHelp: [] } };
}

export function esigStubHandler(app: AppContext): SignableActionHandler<StubAction> {
  return {
    kind: 'ESIG_STUB',
    aggregateTypes: ['esig_stub'],
    // The meaning is the one the challenge names ('' = take the request's).
    describe: (a) => ({ aggregateType: 'esig_stub', aggregateId: a.stubId, meaning: '', expectedState: 'OPEN' }),
    previewContent: (_ctx, query) => kernelContent(app.pools.app, query),
    async prepareForChallenge(client, _ctx, a) {
      const c = await esig.contentForSigning(client, 'esig_stub', a.stubId);
      return { contentVersion: c.contentVersion ?? '0', contentHash: c.contentHash ?? '', changed: false };
    },
    async dryRun(client, ctx, a) {
      const row = await stubRow(client, a.stubId);
      if (!row) return refused(404, 'ESIG_STUB_NOT_FOUND', 'The entry to be signed was not found.', `Entry ${a.stubId} does not exist.`, ['Reload the screen.']);
      if (row.state !== 'OPEN') {
        return refused(409, 'ESIG_STUB_NOT_OPEN', 'This entry is already completed.', `Entry ${a.stubId} is ${row.state}; nothing more is signed on it.`, ['Reload the screen.']);
      }
      const rule = COMPLETING[row.kind];
      const meaning = meaningOf(ctx);
      if (rule && rule.meanings.includes(meaning)) {
        const sigs = await esig.recordSignatures(client, 'esig_stub', a.stubId);
        if (!sigs.some((s) => s.meaningCode === rule.prerequisite && s.valid)) {
          return refused(
            422,
            'ESIG_STUB_ORDER',
            `This entry cannot be signed ${meaning} yet.`,
            `A ${row.kind} entry is signed ${rule.prerequisite} before it is signed ${meaning}.`,
            [`Ask the person who did the work to sign ${rule.prerequisite} first.`],
          );
        }
      }
      const c = await esig.contentForSigning(client, 'esig_stub', a.stubId);
      return { accepted: true, contentHash: c.contentHash ?? '', contentVersion: c.contentVersion ?? '0' };
    },
    async apply(client, ctx, a, signature) {
      const row = await stubRow(client, a.stubId);
      const rule = row ? COMPLETING[row.kind] : undefined;
      if (rule && rule.meanings.includes(signature.meaning)) {
        await client.query('select esig.stub_complete($1, $2)', [a.stubId, signature.signatureId]);
      }
      const after = await stubRow(client, a.stubId);
      void ctx;
      return { stubId: a.stubId, state: after?.state ?? 'UNKNOWN' };
    },
  };
}
