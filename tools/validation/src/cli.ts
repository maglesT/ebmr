/**
 * The validation pack commands (Phase 7 slice 7c; interfaces section 1d):
 *   bundle    --results .reports --db <url> [--records <dir>] --out .reports/validation/bundle.json
 *             builds the evidence bundle (and the SBOM beside it, sbom.cdx.json); the database is read read-only
 *   generate  --bundle <file> [--previous <file>] --out .reports/validation/pack
 *             writes the pack (Markdown and HTML per document) and manifest.json
 *   iq        --db <url> [--server <url>] --bundle <file> [--out .reports/validation/iq-record.json]
 *             the IQ checks of an installation and their record; exits 1 when a check fails
 *   oq        --server <url> [--out .reports/validation/oq-record.json] [--no-run]
 *             runs the regression, golden and browser suites and writes the OQ record from their reports
 * The pack is not committed (D-P7-13): it is rebuilt from the bundle.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { canonicalJson, generatePack, parseBundle } from '@ebmr/validation-kit';
import { buildBundle, hostOfThisMachine } from './bundle.ts';
import { runIq } from './iq.ts';
import { oqRecord, runSuites } from './oq.ts';
import { cycloneDx } from './sbom.ts';
import { commitOf, productVersion, ROOT } from './sources.ts';

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  // Read only for the whole session: the bundle and the IQ never write to the installation.
  const c = new pg.Client({ connectionString: url, options: '-c default_transaction_read_only=on' });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      results: { type: 'string', default: '.reports' },
      db: { type: 'string' },
      records: { type: 'string' },
      out: { type: 'string' },
      bundle: { type: 'string' },
      previous: { type: 'string' },
      server: { type: 'string' },
      'no-run': { type: 'boolean', default: false },
    },
  });
  switch (command) {
    case 'bundle': {
      if (!values.db) throw new Error('--db <url> is required (a database migrated to the release; read only)');
      const out = resolve(values.out ?? '.reports/validation/bundle.json');
      const sbomFile = join(dirname(out), 'sbom.cdx.json');
      write(sbomFile, `${canonicalJson(cycloneDx(productVersion()))}\n`);
      const bundle = await withClient(values.db, (c) =>
        buildBundle({ resultsDir: resolve(values.results), db: c, sbomFile: relative(ROOT, sbomFile), ...(values.records ? { recordsDir: resolve(values.records) } : {}) }),
      );
      write(out, `${canonicalJson(bundle)}\n`);
      console.log(`bundle written: ${out} (${String(bundle.register.controls.length)} controls, ${String(bundle.results.length)} results, ${String(bundle.runs.length)} runs)`);
      return 0;
    }
    case 'generate': {
      if (!values.bundle) throw new Error('--bundle <file> is required');
      const out = resolve(values.out ?? '.reports/validation/pack');
      const prev = values.previous ? (JSON.parse(readFileSync(values.previous, 'utf8')) as unknown) : undefined;
      const pack = generatePack(JSON.parse(readFileSync(values.bundle, 'utf8')) as unknown, prev);
      for (const f of pack.files) write(join(out, f.path), f.content);
      console.log(`pack written: ${out} (${String(pack.manifest.documents.length)} documents, bundle ${pack.manifest.bundleSha256})`);
      return 0;
    }
    case 'iq': {
      if (!values.db || !values.bundle) throw new Error('--db <url> and --bundle <file> are required');
      const bundle = parseBundle(JSON.parse(readFileSync(values.bundle, 'utf8')) as unknown);
      const record = await withClient(values.db, async (c) =>
        runIq({ db: c, bundle, server: values.server ?? null, host: hostOfThisMachine((await c.query<{ v: string }>('show server_version')).rows[0]?.v ?? null) }),
      );
      const out = resolve(values.out ?? '.reports/validation/iq-record.json');
      write(out, `${JSON.stringify(record, null, 2)}\n`);
      for (const ch of record.checks) console.log(`${ch.passed ? 'PASS' : 'FAIL'} ${ch.id} ${ch.name}${ch.passed ? '' : `: ${ch.problems.slice(0, 3).join('; ')}`}`);
      console.log(`IQ record written: ${out}: ${record.summary}`);
      return record.passed ? 0 : 1;
    }
    case 'oq': {
      if (!values.server) throw new Error('--server <url> is required');
      if (!values['no-run']) runSuites(values.server);
      const record = oqRecord(resolve(values.results), commitOf().commit, hostOfThisMachine(null), values.server);
      const out = resolve(values.out ?? '.reports/validation/oq-record.json');
      write(out, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`OQ record written: ${out}: ${record.summary}`);
      return record.passed ? 0 : 1;
    }
    default:
      console.error('usage: validation <bundle|generate|iq|oq> [options] (tools/validation/src/cli.ts)');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`validation: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
