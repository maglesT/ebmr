/**
 * The demo and E2E stacks keep each child's last output lines even when echo is off (CI), so a server that does not
 * answer its health check fails with its own account of why (PR #37: CI showed only "did not answer within 60000 ms").
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnNode, TAIL_LINES, waitForHttp } from '../src/processes.ts';

const dir = mkdtempSync(join(tmpdir(), 'ebmr-demo-processes-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('demo child processes', () => {
  it('keep the last output lines of stdout and stderr with echo off', async () => {
    const entry = join(dir, 'chatty.mjs');
    writeFileSync(entry, "for (let i = 1; i <= 50; i++) console.log('line ' + i);\nconsole.error('refused to start: the reason');\n");
    const p = spawnNode({ name: 'chatty', entry, env: {}, echo: false });
    await new Promise<void>((resolve) => p.child.once('close', () => resolve()));
    const tail = p.tail();
    expect(tail).toHaveLength(TAIL_LINES);
    expect(tail).toContain('refused to start: the reason');
    expect(tail).toContain('line 50');
    expect(tail).not.toContain('line 1');
  });

  it('a health check of a process that exits fails at once, naming the exit', async () => {
    const entry = join(dir, 'exits.mjs');
    writeFileSync(entry, 'process.exit(3);\n');
    const p = spawnNode({ name: 'exits', entry, env: {}, echo: false });
    await new Promise<void>((resolve) => p.child.once('exit', () => resolve()));
    await expect(waitForHttp('http://127.0.0.1:9/api/meta', 5_000, p.child)).rejects.toThrow(/exited \(3\)/);
  });
});
