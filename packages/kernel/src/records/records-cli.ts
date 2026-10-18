/**
 * Command line for the full export of the installation and the periodic evaluation pack (Phase 7 slice 7b-2; DI-08,
 * DI-11, DI-44; kernel 1335, 1336). Run directly: `tsx packages/kernel/src/records/records-cli.ts <command> ...`.
 *
 *   full-export      --url URL --actor-json JSON|@FILE --out DIR [--seal-key-file FILE]
 *       The full export into the empty folder DIR, registered with its SHA-256 (printed). The actor is an open session
 *       of a person holding RECORD.EXPORT (the CSV / DI lead). With --seal-key-file (the installation's key file,
 *       {keyId, secret} in base64, as the server reads it) the installation's own check of each HMAC seal is recorded.
 *   evaluation-pack  --url URL --report-url URL --actor-json JSON|@FILE --from TIME --to TIME --seed TEXT [--sample N]
 *                    [--out FILE]
 *       Generates and stores the periodic evaluation pack of the period [from, to): the entries read through
 *       --report-url (a connection as the reporting role ebmr_report), the readability sample through --url. The
 *       actor holds VALIDATION.MANAGE and RECORD.EXPORT. Prints the pack id and SHA-256; --out writes the pack text.
 *       QA then signs the pack off (PERIODIC_EVALUATION_APPROVED, records.approve_evaluation_pack).
 *
 * Exit codes: 0 done; 1 the database refused (message printed); 2 usage error.
 * Credentials: prefer URLs without passwords plus PGPASSWORD or a password file, so secrets do not appear in process
 * lists.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import type { ActorContext } from '../db/command.ts';
import { createSealKeyRing, type SealKeyRing } from '../esig/keys.ts';
import { runPeriodicEvaluation } from './evaluation-pack.ts';
import { buildFullExport } from './full-export.ts';

const USAGE = `usage:
  full-export     --url URL --actor-json JSON|@FILE --out DIR [--seal-key-file FILE]
  evaluation-pack --url URL --report-url URL --actor-json JSON|@FILE --from TIME --to TIME --seed TEXT [--sample N] [--out FILE]`;

function parseArgs(argv: string[]): { command: string; opts: Map<string, string> } {
  const [command = '', ...rest] = argv;
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    opts.set(a, v);
    i++;
  }
  return { command, opts };
}

function required(opts: Map<string, string>, key: string): string {
  const v = opts.get(key);
  if (v === undefined) throw new Error(`${key} is required`);
  return v;
}

function actorFrom(text: string): ActorContext {
  const json = text.startsWith('@') ? readFileSync(text.slice(1), 'utf8') : text;
  const a = JSON.parse(json) as Partial<ActorContext>;
  for (const k of ['personId', 'accountId', 'roleCode', 'sessionId', 'source', 'siteZone'] as const) {
    if (typeof a[k] !== 'string' || a[k] === '') throw new Error(`--actor-json needs ${k}`);
  }
  return a as ActorContext;
}

function keyRingFrom(file: string): SealKeyRing {
  const k = JSON.parse(readFileSync(file, 'utf8')) as { keyId?: string; secret?: string };
  if (!k.keyId || !k.secret) throw new Error(`${file} is no seal key file ({keyId, secret})`);
  return createSealKeyRing([{ keyId: k.keyId, algorithm: 'HMAC-SHA256', secret: Buffer.from(k.secret, 'base64') }]);
}

/** A reader on the reporting path from a connection URL of the role ebmr_report. */
function reportReader(pool: pg.Pool) {
  return { query: <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<R>(sql, params) };
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  let actor: ActorContext;
  try {
    parsed = parseArgs(argv);
    if (parsed.command !== 'full-export' && parsed.command !== 'evaluation-pack') throw new Error(`unknown command ${parsed.command || '(none)'}`);
    actor = actorFrom(required(parsed.opts, '--actor-json'));
    required(parsed.opts, '--url');
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const { command, opts } = parsed;
  const app = new pg.Pool({ connectionString: required(opts, '--url'), max: 2 });
  try {
    if (command === 'full-export') {
      const out = required(opts, '--out');
      const keyFile = opts.get('--seal-key-file');
      const exp = await buildFullExport(app, actor, out, keyFile ? { keyRing: keyRingFrom(keyFile) } : {});
      const m = JSON.parse(exp.manifest) as { records: unknown[]; files: unknown[] };
      console.log(`full export ${exp.exportId}: ${m.records.length} closed records, ${m.files.length} files in ${out}`);
      console.log(`export SHA-256 (registered; give it with the export: the viewer checks the export against it): ${exp.manifestSha256}`);
      return 0;
    }
    const report = new pg.Pool({ connectionString: required(opts, '--report-url'), max: 2 });
    try {
      const sample = opts.get('--sample');
      if (sample !== undefined && !/^[1-9][0-9]{0,3}$/.test(sample)) throw new Error('--sample must be a whole number from 1 to 1000');
      const res = await runPeriodicEvaluation(reportReader(report), app, actor, {
        from: required(opts, '--from'),
        to: required(opts, '--to'),
        seed: required(opts, '--seed'),
        ...(sample !== undefined ? { sampleSize: Number(sample) } : {}),
      });
      const out = opts.get('--out');
      if (out) writeFileSync(out, res.text, { flag: 'wx' });
      console.log(`evaluation pack ${res.packId} of ${res.pack.period.from} to ${res.pack.period.to}: ${res.pack.summary.entries} entries, ${res.pack.summary.sampled} records sampled, ${res.pack.summary.unreadable} unreadable`);
      for (const t of res.pack.summary.perTopic) console.log(`  ${t.topic}: ${t.entries}`);
      console.log(`pack SHA-256: ${res.packSha256}`);
      return 0;
    } finally {
      await report.end();
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  } finally {
    await app.end();
  }
}

if (process.argv[1]?.endsWith('records-cli.ts')) process.exitCode = await main(process.argv.slice(2));
