import { describe, expect, it } from 'vitest';
import { mutantsOf } from '../src/mutators.ts';
import { findFunctions, functionEvents, functionIdentity, segments } from '../src/sql-scan.ts';

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

  it('[meta] a < or > that is part of another operator is never mutated, and every other mutant keeps its number', () => {
    const [def] = findFunctions(`
create function demo.json(p jsonb, q jsonb) returns boolean language plpgsql as $$
begin
  return p ->> 'a' = 'x' and p #>> '{b,c}' = 'y' and p @> q and q <@ p and demo.f(p_x => 1) and (p ->> 'n')::int > 2;
end
$$;`, 'demo.sql');
    const ms = mutantsOf(def!);
    for (const broken of ['->>=', '#>>=', '@>=', '<=@', '=>=']) expect(ms.some((m) => m.statement.includes(broken)), broken).toBe(false);
    // The sites in order, each with its number: ->> (1, not made) = (2) and (3) #>> (4, not made) = (5) and (6) @> (7, not
    // made) and (8) <@ (9, not made) and (10) => (11, not made) and (12) ->> (13, not made) > (14).
    expect(ms.map((m) => `${m.id} ${m.original}->${m.replacement}`)).toEqual([
      'demo.json#2 =-><>', 'demo.json#3 and->or', 'demo.json#5 =-><>', 'demo.json#6 and->or', 'demo.json#8 and->or',
      'demo.json#10 and->or', 'demo.json#12 and->or', 'demo.json#14 >->>=',
    ]);
  });

  it('[meta] the = of a RAISE option is never mutated (always a syntax error at CREATE); a comparison inside the statement is', () => {
    const [def] = findFunctions(`
create function demo.r(a int, b int) returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = format('EBMR-DEMO-002 a; b %s', a = b), hint = 'h';
  raise notice 'n' using detail = 'd';
end
$$;`, 'demo.sql');
    const ms = mutantsOf(def!);
    // Sites by position: the guard (1), errcode = (2), message = (3), a = b (4), hint = (5), detail = (6).
    expect(ms.map((m) => `${m.id} ${m.operator}`)).toEqual(['demo.r#1 GUARD_REMOVED', 'demo.r#4 RELATIONAL']);
    expect(ms[1]?.statement).toContain("using errcode = 'P0001', message = format('EBMR-DEMO-002 a; b %s', a <> b), hint = 'h';");
  });

  it('[meta] a function is identified as PostgreSQL identifies it: input argument types, aliases spelt out, no names, OUT arguments, defaults or type modifiers', () => {
    expect(functionIdentity('Demo.F', 'p_at timestamptz, out x text, p_n numeric(10, 2) default 1, p_list text[], inout p_y int, variadic p_z int8[]'))
      .toBe('demo.f(timestamp with time zone, numeric, text[], integer, bigint[])');
    expect(functionIdentity('demo.g', "uuid, double precision, p_d jsonb default '{\"a\": 1, \"b\": 2}'::jsonb, \"Odd name\" bool"))
      .toBe('demo.g(uuid, double precision, jsonb, boolean)');
    expect(functionIdentity('demo.h', '')).toBe('demo.h()');
    const [def] = findFunctions(SQL, 'demo.sql');
    expect(def?.identity).toBe('demo.guard(numeric, numeric)');
  });

  it('[meta] a migration\'s definitions and drops come in file order; a CREATE or DROP quoted in a comment or a literal is not one', () => {
    const events = functionEvents(`
-- drop function demo.a(int); create function demo.c(p int) returns int
create function demo.a(p_x integer) returns int language sql as $$ select 1 $$;
select 'drop function demo.a(int)';
drop function if exists demo.a(int), demo.b(p_y text) cascade;
drop function demo.d;
create or replace function demo.a(p_x int, p_y text) returns int language sql as $$ select 2 $$;
`, 'demo.sql');
    expect(events.map((e) => (e.kind === 'define' ? `define ${e.def.identity}` : e.kind === 'drop' ? `drop ${e.identity}` : `drop-all ${e.name}`))).toEqual([
      'define demo.a(integer)',
      'drop demo.a(integer)',
      'drop demo.b(text)',
      'drop-all demo.d',
      'define demo.a(integer, text)',
    ]);
  });
});
