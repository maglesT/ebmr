/**
 * Phase B slice 6: the move of a standalone Batchwright onto the platform (move.ts). A dry run unless --commit.
 *
 *   node --import tsx tools/platform/src/cli.ts --source-url postgres://postgres:...@host/ebmr_tablets_demo \
 *     --platform-url "$PLATFORM_DATABASE_URL" --by <core login> --verified-by <name> --verified-how <how> \
 *     [--link login,login] [--code-map tools/platform/demo-code-map.json] [--report-dir DIR] [--commit]
 *
 * Exit 0 PASS, 1 FAIL, 2 usage.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runMove, type CodeMap } from './move.ts';

const { values } = parseArgs({
  options: {
    'source-url': { type: 'string' }, 'platform-url': { type: 'string' }, by: { type: 'string' }, 'verified-by': { type: 'string' },
    'verified-how': { type: 'string' }, link: { type: 'string' }, 'code-map': { type: 'string' }, 'report-dir': { type: 'string' },
    commit: { type: 'boolean', default: false },
  },
});
const need = (k: keyof typeof values): string => {
  const v = values[k];
  if (typeof v !== 'string' || v === '') {
    console.error(`--${k} is required`);
    process.exit(2);
  }
  return v;
};
const codeMap = values['code-map'] ? (JSON.parse(readFileSync(values['code-map'], 'utf8')) as CodeMap) : {};
const report = await runMove({
  sourceUrl: need('source-url'), platformUrl: need('platform-url'), by: need('by'), verifiedBy: need('verified-by'), verifiedHow: need('verified-how'),
  link: values.link ? values.link.split(',').map((s) => s.trim()).filter(Boolean) : [], codeMap, commit: values.commit === true,
  reportDir: values['report-dir'] ?? 'var/platform-move',
});
console.log(`platform move: ${report.result}${report.committed ? ' (committed)' : ' (nothing written)'}; ${String(report.people.length)} people, ${String(report.items.length)} master items`);
for (const f of report.failures) console.log(`  - ${f}`);
process.exit(report.result === 'PASS' ? 0 : 1);
