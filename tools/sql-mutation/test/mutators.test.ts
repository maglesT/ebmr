import { describe, expect, it } from 'vitest';
import { mutantsOf } from '../src/mutators.ts';
import { findFunctions, segments } from '../src/sql-scan.ts';

const SQL = `
create function demo.guard(p_qty numeric, p_limit numeric default 5) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  -- a comment with < and and
  if p_qty > p_limit and not exists (select 1 from demo.t where x = 'a;b') then
    raise exception using message = format('EBMR-DEMO-001 too much; %s', p_qty);
  end if;
  perform true;
end
$$;

create or replace function demo.sql_fn(p text) returns boolean language sql as $f$ select p <> 'x' $f$;
`;

describe('sql mutation harness', () => {
  it('finds functions, their bodies and a key that ignores defaults', () => {
    const defs = findFunctions(SQL, 'demo.sql');
    expect(defs.map((d) => d.key)).toEqual(['demo.guard(p_qty numeric,p_limit numeric)', 'demo.sql_fn(p text)']);
    const first = defs[0];
    expect(first?.statement.slice(first.bodyStart, first.bodyEnd)).toContain('raise exception');
    expect(first?.line).toBe(2);
  });

  it('never treats string literals or comments as code', () => {
    const body = "x = 'a < b' -- y < z\n and w";
    const code = segments(body).filter((s) => s.code).map((s) => body.slice(s.start, s.end)).join('|');
    expect(code).not.toContain("a < b");
    expect(code).not.toContain('y < z');
    expect(code).toContain('and w');
  });

  it('produces one mutant per operator site, each a complete CREATE OR REPLACE statement', () => {
    const [guard] = findFunctions(SQL, 'demo.sql');
    const ms = mutantsOf(guard!);
    const ops = ms.map((m) => `${m.operator}:${m.original}->${m.replacement}`);
    expect(ops).toEqual(expect.arrayContaining([
      'RELATIONAL:>->>=',
      'LOGICAL:and->or',
      'NOT_REMOVED:not ->',
      'RELATIONAL:=-><>',
      'BOOLEAN:true->false',
    ]));
    const guardRemoved = ms.find((m) => m.operator === 'GUARD_REMOVED');
    expect(guardRemoved?.statement).toContain('null;');
    expect(guardRemoved?.statement).not.toContain('raise exception');
    // The semicolon inside the message literal does not end the statement early.
    expect(guardRemoved?.statement).not.toContain("%s', p_qty)");
    expect(ms.every((m) => m.statement.startsWith('create or replace function demo.guard('))).toBe(true);
    // The := assignment and the comment are left alone.
    expect(ms.some((m) => m.line === 5)).toBe(false);
  });
});
