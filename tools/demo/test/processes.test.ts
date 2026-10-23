/**
 * The demo and E2E stacks keep each child's last output lines even when echo is off (CI), so a server that does not
 * answer its health check fails with its own account of why (PR #37: CI showed only "did not answer within 60000 ms").
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnNode, TAIL_LINES, waitForHttp, watchForDeath } from '../src/processes.ts';

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

  it('[meta] R3.12: the demo runner hears of the first child that dies, once, and not after it disarmed', async () => {
    const stays = join(dir, 'stays.mjs');
    writeFileSync(stays, 'setInterval(() => undefined, 1000);\n');
    const dies = join(dir, 'dies.mjs');
    writeFileSync(dies, 'setTimeout(() => process.exit(7), 200);\n');
    const a = spawnNode({ name: 'server', entry: stays, env: {}, echo: false });
    const b = spawnNode({ name: 'gateway', entry: dies, env: {}, echo: false });
    const deaths: string[] = [];
    const heard = new Promise<void>((resolve) => {
      watchForDeath([a, b], (name, how) => {
        deaths.push(`${name}: ${how}`);
        resolve();
      });
    });
    await heard;
    await a.stop();
    expect(deaths).toEqual(['gateway: exit code 7']);

    const c = spawnNode({ name: 'server', entry: stays, env: {}, echo: false });
    const later: string[] = [];
    const watch = watchForDeath([c], (name) => later.push(name));
    watch.disarm();
    await c.stop();
    expect(later).toEqual([]);
  });
});
