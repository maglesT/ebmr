/**
 * [meta] Every act a person performs has a screen (decision 0025, point 2): completeness is tested, not asserted.
 *
 * Every route of the API contract is called by a screen of the web app (a reference `routes.<namespace>.<name>` in
 * apps/tablets-web/src, other than as a read's `.id` to refresh), unless it is listed below:
 *  - SERVICE_ONLY: a route only a service identity or another installation calls, with the reason;
 *  - PENDING_7G2 / PENDING_7G3: person-facing acts whose screens the later parts of slice 7g build (each entry is removed
 *    by the slice that builds its screen);
 *  - NO_SLICE_YET: person-facing routes this test found without a screen that no part of slice 7g names yet (reported to
 *    the lead by slice 7g-1, to be given a slice or a screen).
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
  'plantRules.setFacilityRule': 'the steward proposes the penicillin facility rule; QA approves (slice 7a)',
  'plantRules.classifyBetaLactam': 'the steward proposes a beta-lactam classification; QA approves (slice 7a)',
  'labels.masterLabelling': 'the labelling of an MBR version (labelling specimens)',
  'labels.declareLabelling': 'the declaration of an MBR version\'s labelling (labelling specimens)',
};

/** Slice 7g-3 (system description, validation summary, full export, evaluation pack): their routes join the contract with 7b-2 and 7c. */
const PENDING_7G3: Readonly<Record<string, string>> = {};

/** Person-facing routes without a screen that no part of slice 7g names yet (found by this test in slice 7g-1). */
const NO_SLICE_YET: Readonly<Record<string, string>> = {
  'access.keepAlive': 'a kiosk badge tap that extends the session before the idle lock',
  'designer.referenceDocuments': 'the list of reference documents (master-data steward)',
  'quality.registerEvidenceDocument': 'storing an evidence document (investigation report, certificate)',
  'batches.workQueue': 'the GMP batch work queue of one batch',
  'erpShipping.lot': 'the shipments of a finished lot with the interlock states',
  'india.shelfLifeBases': 'the shelf-life bases (IN-27 area)',
  'india.recordShelfLifeBasis': 'recording a shelf-life basis',
  'india.hazards': 'the hazard classes of products and rooms (IN-27)',
  'india.recordHazard': 'recording a hazard class (QA)',
  'capa.scheduleCheck': 'scheduling another CAPA effectiveness check',
  'alarms.alarm': 'one plant alarm in detail',
  'equipmentData.events': 'equipment events',
  'equipmentData.originals': 'the original equipment records of a batch',
  'plantRules.setRoomRule': 'a room rule',
  'plantRules.adjacencies': 'room adjacencies',
  'plantRules.defineAdjacency': 'defining a room adjacency',
  'plantRules.reagentLots': 'reagent lots',
  'plantRules.recordReagentLot': 'recording a reagent lot',
  'plantRules.withdrawReagentLot': 'withdrawing a reagent lot',
  'plantRules.recordReagentUse': 'recording a reagent use',
  'labels.template': 'one label template in detail',
  'transfers.proposePeer': 'the administrator proposes a peer installation; QA approves its key (DI-31)',
  'dashboards.catalog': 'the catalogue of report views',
  'dashboards.export': 'the documented export of a report view',
  'analytics.flag': 'one analytics flag in detail',
};

/** Signable actions not yet sent by a screen. */
const SIGNABLE_PENDING_7G2: Readonly<Record<string, string>> = {
  MBR_TRANSITION: 'the Prepared, Checked, regulatory-confirmation and Approved signatures of an MBR version',
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

  it('[meta] the people and device administration of slice 7g-1 is called by a screen, every route of both namespaces', () => {
    for (const ns of ['people', 'deviceRegistry'] as const) {
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
