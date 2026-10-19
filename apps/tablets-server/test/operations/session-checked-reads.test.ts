/**
 * Review P7G-5: two reads of slice 7g granted to the application role checked nothing inside, so any caller of the
 * application connection could read them without a session. They are now read for the session behind the request:
 *  - tab.installation_contents(token) (tablets 1485): an active session working in a granted role (EBMR-TAB-018);
 *  - tab.disposal_aggregate_id(token, record key, true copy) (tablets 1491): an active session of a records reader, as
 *    tab.record_retention (EBMR-TAB-018, EBMR-TAB-020).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { tokenHash } from '../../src/platform/auth/session.ts';

let server: TestServer;
let reviewer: TestBrowser;
let author: TestBrowser;
const hashOf = (b: TestBrowser): string => tokenHash(b.cookies.get(server.config.cookies.session) ?? '');
const refusal = async (sql: string, args: unknown[]): Promise<string> => {
  try {
    await server.db.app.query(sql, args);
    return 'OK';
  } catch (e) {
    return (e as Error).message;
  }
};

beforeAll(async () => {
  server = await startServer('GMP');
  reviewer = await loginOf(server, await grantedPerson(server, 'QA_REVIEWER', 'Rhea Reviewer'));
  author = await loginOf(server, await grantedPerson(server, 'MBR_AUTHOR', 'Arun Author'));
}, 300_000);
afterAll(async () => {
  await server?.close();
});

describe('session-checked reads of slice 7g (P7G-5)', () => {
  it('[DI-17][DI-14] the installation contents are read only for an active session; the demo screen still shows them', async () => {
    expect(await refusal('select tab.installation_contents($1)', ['0'.repeat(64)])).toContain('EBMR-TAB-018');
    expect(await refusal('select tab.installation_contents($1)', [''])).toContain('EBMR-TAB-018');
    const { rows } = await server.db.app.query<{ c: { persons: string } }>('select tab.installation_contents($1) as c', [hashOf(author)]);
    expect(Number(rows[0]!.c.persons)).toBeGreaterThan(0);
    const view = await author.call(routes.operations.demo);
    expect(view.ok && Number(view.value.contents.persons) > 0).toBe(true);
  }, 60_000);

  it('[DI-17][DI-50] the disposal id is read only for an active session of a records reader', async () => {
    const sql = 'select tab.disposal_aggregate_id($1, $2, $3)';
    expect(await refusal(sql, ['0'.repeat(64), 'batch_execution:nothing', null])).toContain('EBMR-TAB-018');
    expect(await refusal(sql, [hashOf(author), 'batch_execution:nothing', null])).toContain('EBMR-TAB-020');
    // A records reader reads it: a record without a schedule has no disposal id (null).
    const { rows } = await server.db.app.query<{ id: string | null }>(`${sql} as id`, [hashOf(reviewer), 'batch_execution:nothing', null]);
    expect(rows[0]!.id).toBeNull();
  }, 60_000);
});
