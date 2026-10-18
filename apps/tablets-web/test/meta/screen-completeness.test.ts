/**
 * [meta] Every act a person performs has a screen (decision 0025, point 2): completeness is tested, not asserted.
 *
 * Every route of the API contract is called by a screen of the web app (a reference `routes.<namespace>.<name>` in
 * apps/tablets-web/src, other than as a read's `.id` to refresh), unless it is listed below:
 *  - SERVICE_ONLY: a route only a service identity or another installation calls, with the reason;
 *  - PENDING_7G2 / PENDING_7G3: person-facing acts whose screens the later parts of slice 7g build (each entry is removed
 *    by the slice that builds its screen);
 *  - NO_SLICE_YET: person-facing routes this test found without a screen that no part of slice 7g names yet (reported to
 *    the lead by slice 7g-1; slice 7g-5 gave every one a screen, so it is empty).
 * The acts that had a database function and no route at all (role-permission requests, delegations, the US e-signature
 * certification) got their routes in slice 7g-5 (ns/access-governance.ts); the server's [meta] test
 * apps/tablets-server/test/meta/db-acts-have-routes.test.ts lists the database functions a person executes that no route
 * calls.
 * Every signable action of the ceremony is likewise sent by a screen, unless it is listed.
 *
 * The test fails on a new person-facing route without a screen, on a listed route that now has a screen (remove it from
 * the list), and on a listed id the contract does not have.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allRoutes, routes, SignableAction } from '@ebmr/api-contract';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Called only by a service identity or another installation, never by a person at a screen. */
const SERVICE_ONLY: Readonly<Record<string, string>> = {
  'quality.erpImport': 'the ERP interface posts masters and orders under its own service identity (auth NONE, SERVICE_KEY; DI-17)',
  'erpShipping.check': 'the ERP asks the shipping interlock before it ships, under its own service identity (INV-42)',
  'erpShipping.record': 'the ERP records a shipment under its own service identity; the database applies the interlock (INV-42)',
  'federation.genealogy': 'site to site: another installation asks, sealed by installation keys (L-41); no person session',
};

/** Slice 7g-2 (MBR signing, market authorisations and labelling, plant-rule proposals and approval, incidents). */
const PENDING_7G2: Readonly<Record<string, string>> = {
  // WP1 (validation, export, records): none
  // WP2 (continuity, platform, access configuration): none
  // WP3 (master record, market and plant configuration)
  'labels.masterLabelling': 'the labelling of an MBR version (labelling specimens)',
  'labels.declareLabelling': 'the declaration of an MBR version\'s labelling (labelling specimens)',
  // WP4 (floor, materials, batch numbers): none
};

/** Slice 7g-3 (system description, validation summary, full export, evaluation pack): their routes join the contract with 7b-2 and 7c. */
const PENDING_7G3: Readonly<Record<string, string>> = {};

/**
 * Person-facing routes without a screen that no part of slice 7g names yet. Slice 7g-1 found 25 (defect log 7g1-1);
 * slice 7g-5 gave each a screen, so the list is empty and stays so: a new person-facing route needs its screen.
 */
const NO_SLICE_YET: Readonly<Record<string, string>> = {};

/** Signable actions not yet sent by a screen (the kinds the 7g work packages reserved; each removed with its screen). */
const SIGNABLE_PENDING_7G2: Readonly<Record<string, string>> = {
  // WP1 (validation, export, records)
  VALIDATION_SUMMARY_APPROVE: 'the approval of a validation summary',
  EVALUATION_PACK_APPROVE: 'the approval of a periodic evaluation pack',
  RECORDS_ACT: 'the signed acts of the records register',
  // WP2 (continuity, platform, access configuration)
  RESTORE_APPROVE: 'the second person\'s approval of a restore',
  // WP3 (master record, market and plant configuration)
  QP_REGISTER: 'registering an EU qualified person',
  RULE_SET_VERIFY: 'QA\'s verification of a compendial rule set version',
  MARKET_LOOSENING: 'the approver\'s signature on a loosened market policy version',
  // WP4 (floor, materials, batch numbers)
  LOT_DESTRUCTION_WITNESS: 'the witness\'s signature on a lot destruction',
};

function sourceText(): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(p)) files.push(p);
    }
  };
  walk(SRC);
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}

/** `<namespace>.<name>` of every route the web source calls (also through `routes as X` aliases); a `.id` or `.path` is not a call. */
function calledRoutes(text: string): Set<string> {
  const aliases = new Set(['routes', ...[...text.matchAll(/\broutes as ([A-Za-z_$][\w$]*)/g)].map((m) => m[1] ?? '')]);
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z][\w]*)\.([A-Za-z][\w]*)\b(?!\.(id|path)\b)/g)) {
    if (aliases.has(m[1] ?? '')) out.add(`${m[2] ?? ''}.${m[3] ?? ''}`);
  }
  return out;
}

const keyOf = (ns: string, name: string) => `${ns}.${name}`;
const LISTS = { SERVICE_ONLY, PENDING_7G2, PENDING_7G3, NO_SLICE_YET };

describe('[meta] every act a person performs has a screen (decision 0025)', () => {
  const text = sourceText();
  const called = calledRoutes(text);
  const contract = Object.entries(routes).flatMap(([ns, group]) => Object.keys(group as Record<string, unknown>).map((name) => keyOf(ns, name)));

  it('[meta] every route of the contract is called by a screen, or listed as service-only or pending with its reason', () => {
    const listed = new Set(Object.values(LISTS).flatMap((l) => Object.keys(l)));
    const missing = contract.filter((k) => !called.has(k) && !listed.has(k));
    expect(missing, 'person-facing routes without a screen: build the screen, or list the route with its reason').toEqual([]);
  });

  it('[meta] a listed route is in the contract, in one list only, and not yet called by a screen (remove it once its screen exists)', () => {
    const all = Object.values(LISTS).flatMap((l) => Object.keys(l));
    expect(all.filter((k) => !contract.includes(k)), 'listed but not in the contract').toEqual([]);
    expect(all.filter((k, i) => all.indexOf(k) !== i), 'listed twice').toEqual([]);
    expect(all.filter((k) => called.has(k)), 'listed but now called by a screen: remove it from the list').toEqual([]);
    for (const [name, list] of Object.entries(LISTS)) for (const [k, why] of Object.entries(list)) expect(why.trim(), `${name} ${k} gives its reason`).not.toBe('');
    // The contract's route count is what the lists are checked against (allRoutes walks the same table).
    expect(allRoutes(routes).length).toBe(contract.length);
  });

  it('[meta] the people and device administration of slice 7g-1 and the access governance of slice 7g-5 are called by a screen, every route of each namespace', () => {
    for (const ns of ['people', 'deviceRegistry', 'accessGovernance'] as const) {
      for (const name of Object.keys(routes[ns])) expect(called.has(keyOf(ns, name)), `${ns}.${name}`).toBe(true);
    }
  });

  it('[meta] every signable action of the ceremony is sent by a screen, or listed as pending', () => {
    const kinds = SignableAction.options.map((o) => o.shape.kind.value as string);
    const sent = kinds.filter((k) => new RegExp(`kind: '${k}'`).test(text));
    expect(kinds.filter((k) => !sent.includes(k) && !(k in SIGNABLE_PENDING_7G2)), 'signable actions no screen sends').toEqual([]);
    expect(Object.keys(SIGNABLE_PENDING_7G2).filter((k) => sent.includes(k) || !kinds.includes(k)), 'pending but sent, or not a signable action').toEqual([]);
  });
});
