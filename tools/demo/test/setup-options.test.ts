/**
 * Slice 7h (gaps E1 and E5): `pnpm demo:setup --with-gmp-samples` asks the GMP set-up for the sample records (the review
 * batch and the packaging-order demo); without the flag neither is loaded. The printed credential card names the
 * installation's first administrator and process owner as well as the personas.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { setupOptions } from '../src/options.ts';
import { credentialCard } from '../src/stack.ts';

const dir = mkdtempSync(join(tmpdir(), 'ebmr-demo-card-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pnpm demo:setup options (slice 7h, E1)', () => {
  it('--with-gmp-samples loads the GMP review batch and the packaging-order demo; without it neither', () => {
    expect(setupOptions(['node', 'cli.ts', 'setup', '--with-gmp-samples'])).toEqual({ gmpReviewBatch: true, gmpPackaging: true, gmpSrProfile: true });
    expect(setupOptions(['node', 'cli.ts', 'setup'])).toEqual({ gmpReviewBatch: false, gmpPackaging: false, gmpSrProfile: false });
  });
});

describe('the DEMO-ONLY credential card (slice 7h, E5)', () => {
  it('names demo.admin and demo.owner with their passwords, then the personas', () => {
    const account = (loginName: string, roleCode: string, legalName: string) => ({ personId: 'p', accountId: 'a', legalName, loginName, roleCode, password: `pw-${loginName}`, fingerprint: 'f' });
    const seed = {
      installation: 'GMP',
      database: 'ebmr_tablets_demo',
      siteCode: 'SITE-1',
      zone: 'Asia/Kolkata',
      bootstrap: { installation: 'GMP', admin: account('demo.admin', 'SYSTEM_ADMINISTRATOR', 'Demo Administrator'), owner: account('demo.owner', 'PROCESS_OWNER', 'Demo Process Owner') },
      terminals: [],
      personas: [{ set: 0, key: 'steward', legalName: 'Neha Joshi', loginName: 'neha.joshi', roleCode: 'MASTER_DATA_STEWARD', kiosk: false, homeTerminal: 'PC-QA-01', password: 'Demo-Steward-2026!' }],
      services: [],
    };
    writeFileSync(join(dir, 'gmp-seed.json'), JSON.stringify(seed));
    const card = credentialCard(dir);
    expect(card).toMatch(/Demo Administrator +SYSTEM_ADMINISTRATOR +user ID demo\.admin +password pw-demo\.admin/);
    expect(card).toMatch(/Demo Process Owner +PROCESS_OWNER +user ID demo\.owner +password pw-demo\.owner/);
    expect(card).toMatch(/Neha Joshi +MASTER_DATA_STEWARD +user ID neha\.joshi/);
  });
});
