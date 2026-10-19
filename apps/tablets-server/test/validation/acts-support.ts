/**
 * Shared set-up of the slice 7g-3 route tests (validation, export and records acts): the people who hold the rights no
 * seeded persona holds (the CSV / DI lead, the system administrator), signed in on the QA office PC; a configuration
 * change record raised by the steward and approved by QA through the ceremony; the EBMR code of a refusal.
 */
import { routes, type Result, type SignableAction } from '@ebmr/api-contract';
import { refusalOf, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf, type GrantedPerson } from '../support/granted-person.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

/** The EBMR code a refusal names (in its code or its why), or its code. */
export function codeIn(r: Result<unknown>): string {
  const f = refusalOf(r);
  return `${f.code} ${f.why}`.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? f.code;
}

export interface Signed {
  person: GrantedPerson;
  browser: TestBrowser;
}

/** A person holding `role`, signed in on the QA office PC. */
export async function signedIn(server: TestServer, role: string, name: string): Promise<Signed> {
  const person = await grantedPerson(server, role, name);
  return { person, browser: await loginOf(server, person) };
}

/** The ceremony for a granted person (their own user ID and password). */
export function signAs(server: TestServer, who: Signed, action: SignableAction): Promise<Result<unknown>> {
  return signAction(server, who.browser, '(granted)', action, { credentials: { kind: 'PASSWORD', loginName: who.person.loginName, password: who.person.password } });
}

/** A change record covering `areas`, raised by the steward and approved by QA (qaInvestigator) with a signature. */
export async function approvedChangeRecord(server: TestServer, steward: TestBrowser, qa: TestBrowser, areas: string[], tag: string): Promise<string> {
  const number = `CR-${tag}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number, title: `Test change ${tag}`, description: `Change control for the ${tag} test`, areas } }));
  const signed = await signAction(server, qa, 'qaInvestigator', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number });
  if (!signed.ok) throw new Error(`SETUP: change record ${number} was not approved: ${JSON.stringify(signed.error)}`);
  return number;
}

/** The database's time now, as an ISO instant with its offset. */
export async function dbNow(server: TestServer, shift = '0 seconds'): Promise<string> {
  const { rows } = await server.db.admin.query<{ t: string }>(`select to_char((clock_timestamp() + $1::interval) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`, [shift]);
  return rows[0]?.t ?? '';
}

/** Whether an act succeeded; a refusal is printed, so a failing test says why. */
export function okOf(r: Result<unknown>): boolean {
  if (!r.ok) console.error(`refused: ${JSON.stringify(r.error)}`);
  return r.ok;
}

