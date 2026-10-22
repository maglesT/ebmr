/**
 * [meta] R3.13 (hosted-demo trials, October 2026): the demo is complete for a presenter who has only the site and the
 * credential card.
 *  1. Every role a screen needs has a seeded persona on the card: each home tile whose screen opens with a read a role can
 *     be refused (the web app's TILE_READS and READ_REFUSED, kept equal to the reviewed route-by-role matrix) is usable by
 *     at least one demo persona or set-up administrator of its installation, or listed here with the reason it is not.
 *  2. Every kiosk offers a Tap button for every kiosk persona of its installation: the demo device list (the set-up's
 *     demoDevicesOf and the server's demoDevicesView, which the badge reader shows) names every badge holder on every
 *     shop-floor terminal.
 *  3. Every office persona signs in at a listed PC: its home terminal is an office PC of the demo device picker.
 *  4. The card `pnpm demo` prints names everyone of persona set 0 and both administrators, each with how they sign in.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allRoutes, routes } from '../../../packages/api-contract/src/index.ts';
import { BOOTSTRAP_NAMES, PERSONAS, TERMINALS, type SiteSeed } from '@ebmr/test-kit';
import { demoDevicesOf } from '../../../apps/tablets-server/src/cli/installation.ts';
import { demoDevicesView } from '../../../apps/tablets-server/src/features/session/demo-devices.ts';
import { READ_REFUSED, TILE_READS } from '../../../apps/tablets-web/src/app/tile-access.ts';
import MATRIX from '../../../apps/tablets-server/test/security/fixtures/route-role-matrix.json' with { type: 'json' };
import { credentialCard } from '../src/stack.ts';

type Kind = 'GMP' | 'SANDBOX';
const KINDS: readonly Kind[] = ['GMP', 'SANDBOX'];

/** Tiles no demo persona can use, each with why that is right. */
const NO_PERSONA: Readonly<Record<string, string>> = {
  'contract-giver-batches':
    "the contract giver's reviewer is no standing demo persona: the account is made on the contract givers screen when QA grants a contract giver access, scoped to its loan licence (IN-30), and is shown its batches there",
};

/** The roles of the demo personas and the set-up's administrators of an installation. */
function seededRoles(kind: Kind): Set<string> {
  return new Set([...PERSONAS.filter((p) => p.installation === kind).flatMap((p) => [p.roleCode, ...(p.alsoRoles ?? [])]), 'SYSTEM_ADMINISTRATOR', 'PROCESS_OWNER']);
}

/** A seed of the demo set (persona set 0) as the set-up writes it, with what demoDevicesOf and the card read. */
function demoSeed(kind: Kind): SiteSeed {
  const terminals = TERMINALS.filter((t) => t.installation === kind).map((t) => ({
    code: t.code, deviceClass: t.deviceClass, room: t.room ?? null, description: t.description, fingerprint: `fp-${t.code}`,
    key: t.key === 'BROWSER' ? { algorithm: 'ECDSA_P256', privateKeyPkcs8: 'k', publicKeySpki: 's' } : null,
  }));
  const personas = PERSONAS.filter((p) => p.installation === kind).map((p) => ({
    key: p.key, set: 0, legalName: p.legalName, loginName: p.loginName, roleCode: p.roleCode, ...(p.alsoRoles ? { alsoRoles: [...p.alsoRoles] } : {}), title: p.title, kiosk: p.kiosk,
    homeTerminal: p.homeTerminal, personId: p.key, accountId: p.key, password: p.demo.password, pin: p.demo.pin ?? null, badgeUid: p.demo.badgeUid ?? null,
  }));
  const names = BOOTSTRAP_NAMES[kind];
  const boot = (n: [string, string], roleCode: string) => ({ personId: n[1], accountId: n[1], legalName: n[0], loginName: n[1], roleCode, password: `pw-${n[1]}`, fingerprint: 'fp' });
  return { installation: kind, database: `ebmr_${kind.toLowerCase()}_demo`, siteCode: 'SITE-1', zone: 'Asia/Kolkata', bootstrap: { admin: boot(names.admin, 'SYSTEM_ADMINISTRATOR'), owner: boot(names.owner, 'PROCESS_OWNER') }, terminals, personas, services: [] } as unknown as SiteSeed;
}

const dir = mkdtempSync(join(tmpdir(), 'ebmr-7k-card-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('[meta] R3.13: the demo is complete for a presenter with the site and the credential card', () => {
  it('every home screen\'s read is usable by a seeded persona or administrator of its installation, or listed with its reason', () => {
    const roleLists = (MATRIX as { roles: Record<Kind, string[]> }).roles;
    const byId = new Map(allRoutes(routes).map((r) => [r.id, r]));
    const uncovered: string[] = [];
    for (const [tile, read] of Object.entries(TILE_READS)) {
      if (read === null || tile in NO_PERSONA) continue;
      const route = byId.get(read);
      expect(route, `${tile}: ${read} is a route of the contract`).toBeDefined();
      for (const kind of KINDS.filter((k) => route?.installation === 'ANY' || route?.installation === k)) {
        const refused = new Set(READ_REFUSED[kind][read] ?? []);
        // A role the matrix does not list (the set-up's administrators on a sandbox) is refused nothing by it.
        const allowed = [...roleLists[kind].filter((r) => !refused.has(r)), ...[...seededRoles(kind)].filter((r) => !roleLists[kind].includes(r))];
        if (!allowed.some((r) => seededRoles(kind).has(r))) uncovered.push(`${kind} ${tile} (${read}): only ${allowed.join(', ') || 'no role'}`);
      }
    }
    expect(uncovered).toEqual([]);
    expect(Object.keys(NO_PERSONA).filter((t) => !(t in TILE_READS))).toEqual([]);
  });

  it('every shop-floor terminal\'s demo reader offers a Tap button for every kiosk persona; every kiosk persona works at a listed kiosk', () => {
    for (const kind of KINDS) {
      const devices = demoDevicesView(demoDevicesOf(demoSeed(kind)).devices);
      const kiosks = devices.filter((d) => d.deviceClass === 'SHARED' || d.deviceClass === 'GRADE_A_B');
      const kioskPersonas = PERSONAS.filter((p) => p.installation === kind && p.kiosk);
      expect(kiosks.length, kind).toBeGreaterThan(0);
      for (const p of kioskPersonas) expect(kiosks.map((d) => d.deviceCode), `${kind} ${p.key}'s home kiosk`).toContain(p.homeTerminal);
      for (const d of kiosks) {
        const offered = new Set([...d.personas, ...(d.otherPersonas ?? [])].filter((x) => x.badgeUid).map((x) => x.loginName));
        expect(kioskPersonas.filter((p) => !offered.has(p.loginName)).map((p) => p.key), `${kind} ${d.deviceCode}`).toEqual([]);
      }
    }
  });

  it('every office persona signs in at an office PC of the demo device picker', () => {
    for (const kind of KINDS) {
      const pcs = demoDevicesOf(demoSeed(kind)).devices.filter((d) => d.deviceClass === 'PERSONAL').map((d) => d.deviceCode);
      const missing = PERSONAS.filter((p) => p.installation === kind && !p.kiosk && !pcs.includes(p.homeTerminal)).map((p) => `${p.key} at ${p.homeTerminal}`);
      expect(missing, kind).toEqual([]);
    }
  });

  it('the card pnpm demo prints names both administrators with this set-up\'s passwords and every demo persona with how they sign in', () => {
    for (const kind of KINDS) writeFileSync(join(dir, `${kind === 'GMP' ? 'gmp' : 'sandbox'}-seed.json`), JSON.stringify(demoSeed(kind)));
    const card = credentialCard(dir);
    for (const kind of KINDS) {
      const seed = demoSeed(kind);
      for (const a of [seed.bootstrap.admin, seed.bootstrap.owner]) expect(card).toContain(`user ID ${a.loginName}  password ${a.password}`);
      for (const p of seed.personas) expect(card).toContain(p.kiosk ? `badge ${p.badgeUid ?? '?'}  PIN ${p.pin ?? '?'}   (kiosk ${p.homeTerminal})` : `user ID ${p.loginName}  password ${p.password}   (${p.homeTerminal})`);
    }
  });
});
