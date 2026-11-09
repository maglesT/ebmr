/**
 * MEDHANTA slice 2: the release of a batch's output is refused by the database while a Deviations number linked to the
 * batch is not closed or rejected in the Deviations product (apps/tablets-server/sql/1907: dv.release_problem on the
 * release state rows, as site-services 0822 does for local records). The server reads the number through
 * report.deviation_v1 in the releasing transaction (the kernel's fact resolver; platform/deviations.ts) and records the
 * read (dv.status_fact); an unreadable view stops the release with DEVIATIONS_OFF.
 *
 * Proven on the real release path of an output container (plant.release_container, QA's signature) of a dc-mini run, as
 * the application role. The number is linked as set-up (its command and the GMP checks are proven over HTTP in
 * platform-deviations.test.ts); the stand-in Deviations database is test/support/fake-deviations.ts.
 *
 * Controls: PR-49 and IN-05 (21 CFR 211.192: release only once deviations are investigated and resolved), PL-08.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { registerFactResolver, withCommand } from '@ebmr/kernel';
import { Deviations } from '../../src/platform/deviations.ts';
import { actorOfBrowser } from '../esig/support.ts';
import { prepareSignature, verifyTypedNet } from '../execution/db-guards-support.ts';
import { dcMini, importAndIssue, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';
import { fakeTimers } from '../blocks/granulation/db-support.ts';
import { cleanUnit } from '../blocks/compression/plant-support.ts';
import { FakeDeviations } from '../support/fake-deviations.ts';

const dv = new FakeDeviations();
let sbx: ExecServer;
let run: RunDriver;
let reader: Deviations;
const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};

async function as<T>(persona: string, text: string, params: unknown[]): Promise<T> {
  advance();
  const actor = await actorOfBrowser(sbx, run.browser(persona), persona);
  return withCommand(sbx.db.app, actor, async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}

/** A closed container on a press held by a failed in-process check, as a container QA releases from hold (recipe-core 0741). */
async function heldContainer(): Promise<string> {
  const press = (await cleanUnit(sbx, run.runId)).code;
  const o = await as<{ container_id: string; version: number }>('operator1', 'select plant.open_container($1, $2, $3, $4) as r', [run.runId, 'COMPRESSION', 'kg', press]);
  await as('operator1', 'select plant.close_container($1, $2, $3) as r', [o.container_id, '5.000', o.version]);
  await verifyTypedNet(sbx, run.browser('verifier1'), o.container_id);
  await as('operator1', 'select plant.record_ipc_check($1, $2, $3, $4, $5) as r', [run.runId, press, null, 'FAIL', `TEST-IPC-${randomUUID().slice(0, 4)}`]);
  return o.container_id;
}

/** QA releases the container; the refusal's message, or 'released'. */
async function release(containerId: string): Promise<string> {
  const version = (await sbx.db.admin.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [containerId])).rows[0]?.v;
  const p = await prepareSignature(sbx, run.browser('qa1'), 'qa1', 'output_container', containerId, 'OUTPUT_CONTAINER_RELEASED');
  try {
    await withCommand(sbx.db.app, await p.actor(), async (c) => c.query('select plant.release_container($1, $2, $3)', [containerId, Number(version), await p.sign(c)]));
    return 'released';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function link(number: string): Promise<void> {
  await sbx.db.admin.query(
    "insert into dv.batch_number_link (batch_id, batch_number, number, linked_by_person, linked_by_account) values ($1, 'TEST-RUN', $2, $3, $3)",
    [run.runId, number, randomUUID()],
  );
}

beforeAll(async () => {
  await dv.create();
  sbx = await startExecServer();
  fakeTimers();
  reader = Deviations.open(dv.url);
  // As the server registers it on its own pool where the link is configured (app.ts).
  registerFactResolver(sbx.db.app, reader.resolver(null));
  const browsers = {
    issuer: await sbx.asPersona('issuer'),
    operator1: await sbx.asPersona('operator1'),
    verifier1: await sbx.asPersona('verifier1'),
    qa1: await sbx.asPersona('qa1'),
  };
  run = new RunDriver(sbx, await importAndIssue(sbx, browsers.issuer, writePackage(sbx, dcMini())), browsers);
  run.beforeTap = advance;
}, 600_000);
afterAll(async () => {
  vi.useRealTimers();
  await reader?.close();
  await sbx?.close();
  await dv.drop();
});

describe('release waits for the linked Deviations numbers (PR-49, IN-05)', () => {
  it('[PR-49][IN-05][PL-08] a container is not released while a linked number is open, nor while Deviations cannot be read; once every number is closed or rejected it is, with each read recorded', async () => {
    const container = await heldContainer();
    const [a, b] = [`DEV-${randomUUID().slice(0, 6)}`, `DEV-${randomUUID().slice(0, 6)}`];
    await dv.put(a, 'investigation');
    await dv.put(b, 'rejected');
    await link(a);
    await link(b);

    expect(await release(container)).toMatch(new RegExp(`The output container cannot be released: deviation ${a} linked to batch .* is investigation in the Deviations product; release waits until it is closed or rejected\\. \\[EBMR-DV-001\\]`));
    await dv.put(a, 'closure');
    expect(await release(container)).toMatch(/is closure in the Deviations product.*\[EBMR-DV-001\]/);

    await dv.put(a, 'closed');
    await dv.cut();
    try {
      expect(await release(container)).toBe('DEVIATIONS_OFF: Connection to Deviations is off. Release is blocked. Ask your administrator.');
    } finally {
      await dv.restore();
    }
    expect((await sbx.db.admin.query('select count(*)::int as n from dv.status_fact')).rows[0]).toEqual({ n: 0 });

    expect(await release(container)).toBe('released');
    // The read each release rested on, in its transaction (one per number), with the person who released.
    const facts = (await sbx.db.admin.query<{ number: string; status: string; person_id: string }>('select number, status, person_id::text from dv.status_fact order by number')).rows;
    expect(Object.fromEntries(facts.map((f) => [f.number, f.status]))).toEqual({ [a]: 'closed', [b]: 'rejected' });
    expect(new Set(facts.map((f) => f.person_id)).size).toBe(1);
  });

  it('[PR-49] a number Deviations does not publish keeps release blocked', async () => {
    const container = await heldContainer();
    await link(`DEV-GONE-${randomUUID().slice(0, 4)}`);
    expect(await release(container)).toMatch(/is not in the Deviations product\. \[EBMR-DV-001\]/);
  });
});
