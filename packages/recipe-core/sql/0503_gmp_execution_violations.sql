-- Recipe core, execution store (module C3): the invariant query in a GMP database reports what is wrong with a GMP
-- batch, and no longer the batch itself (Phase 3 slice 2b item 2; DI-05, INV-18, INV-01, INV-02, INV-27, IN-18).
--
-- recipe.execution_violations (0210, 0306) reported every batch of a GMP database as "a test batch exists in a GMP
-- database": in Phase 2 nothing of the execution store could be there. Now (replaced from its latest definition, 0306):
--   * in a GMP database it reports a test batch (a row of the sandbox's origin or naming a test package), every test
--     package and every SANDBOX_ONLY block a test package holds, as before, and no longer a GMP batch;
--   * in a sandbox database it reports a GMP batch (a row of GMP origin or naming a control recipe);
--   * in any database, every SANDBOX_ONLY block in the control recipe of a GMP batch, and every GMP batch that is not
--     exactly its planned batch (recipe.gmp_batch_problem, 0500): its planned batch and pin (INV-01), its control recipe
--     verifying with the content it runs (INV-02), the register allocation of its number, not voided (INV-27, IN-18),
--     its pinned market set, batch size and site, and its issuer's valid ISSUED signature (DI-35);
--   * everything else as in 0306 (identifiers, rows, hash chain, projection, content versions, the engine's rules).
-- CREATE OR REPLACE keeps the privileges (0210: the application role may call it). Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

create or replace function recipe.execution_violations() returns table (batch_id uuid, problem text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
#variable_conflict use_column
declare
  v_kind text := kernel.installation_kind();
  r      record;
  rw     recipe.execution_command;
  v_prev text;
  v_bat  uuid;
  v_seq  bigint;
  gb     recipe.batch_execution;
  v_gmp  text;
begin
  -- DI-05, INV-18: a GMP database holds no test package and no test batch, a sandbox no GMP batch (slice 2b).
  if v_kind = 'GMP' then
    for r in select id from recipe.batch_execution where installation is distinct from 'GMP' or package_hash is not null loop
      batch_id := r.id; problem := 'a test batch exists in a GMP database (DI-05, INV-18)'; return next;
    end loop;
    for r in select package_hash from recipe.test_package loop
      batch_id := null; problem := format('test package %s exists in a GMP database (DI-05, INV-18)', r.package_hash); return next;
    end loop;
  else
    for r in select id from recipe.batch_execution where installation is distinct from 'SANDBOX' or control_recipe_id is not null loop
      batch_id := r.id; problem := 'a GMP batch exists in a sandbox database (DI-05, INV-18)'; return next;
    end loop;
  end if;
  for r in
    select distinct t.package_hash, s.block_type, s.block_version
    from recipe.test_package t
    cross join lateral jsonb_path_query(t.content, 'strict $.**.block') blk
    join recipe.sandbox_only_block s on s.block_type = blk ->> 'type' and s.block_version = blk ->> 'version'
    where v_kind = 'GMP'
  loop
    batch_id := null; problem := format('SANDBOX_ONLY block %s@%s in package %s held by a GMP database (DI-05, INV-18)', r.block_type, r.block_version, r.package_hash);
    return next;
  end loop;
  -- DI-05, INV-18: no SANDBOX_ONLY block in the control recipe of a GMP batch.
  for r in
    select b.id, x.blk
      from recipe.batch_execution b
      cross join lateral unnest(recipe.sandbox_only_blocks_in(recipe.execution_mbr_content(null, b.control_recipe_id))) x (blk)
     where b.control_recipe_id is not null
     order by b.id, x.blk
  loop
    batch_id := r.id; problem := format('SANDBOX_ONLY block %s in the control recipe of a GMP batch (DI-05, INV-18)', r.blk); return next;
  end loop;
  -- INV-01, INV-02, INV-27, IN-18, DI-35: every GMP batch has its planned batch, pin, verifying control recipe, register
  -- allocation of its number (not voided), pinned market set, size and site, and its issuer's valid ISSUED signature.
  for gb in select * from recipe.batch_execution x where x.installation = 'GMP' order by x.id loop
    v_gmp := recipe.gmp_batch_problem(gb);
    if v_gmp is not null and v_gmp not like '[195]%' then
      batch_id := gb.id; problem := format('GMP batch %s: %s', gb.batch_number, substr(v_gmp, 7)); return next;
    end if;
  end loop;
  for r in select id, batch_number from recipe.batch_execution where sandbox.identifier_problem('BATCH_NUMBER', batch_number) is not null loop
    batch_id := r.id; problem := format('batch number %s is not allowed in this installation (DI-05)', r.batch_number); return next;
  end loop;

  -- Sequence, kinds and the hash chain.
  for r in select b.id, count(k.seq) as n, min(k.seq) as lo, max(k.seq) as hi from recipe.batch_execution b left join recipe.execution_command k on k.batch_id = b.id group by b.id loop
    if r.n = 0 or r.lo <> 1 or r.hi <> r.n then
      batch_id := r.id; problem := format('rows are not numbered 1..n without gaps (%s rows, %s..%s) (DI-34)', r.n, r.lo, r.hi); return next;
    end if;
  end loop;
  v_bat := null;
  for rw in select * from recipe.execution_command x order by x.batch_id, x.seq loop
    if v_bat is distinct from rw.batch_id then
      v_bat := rw.batch_id;
      v_prev := recipe.execution_genesis_hash(rw.batch_id);
    end if;
    if rw.prev_row_hash is distinct from v_prev then
      batch_id := rw.batch_id; problem := format('row %s does not link to the previous row hash (DI-34)', rw.seq); return next;
    end if;
    if rw.row_hash is distinct from recipe.execution_row_hash(rw.prev_row_hash, rw) then
      batch_id := rw.batch_id; problem := format('row %s does not match its row hash (changed after it was written) (DI-34)', rw.seq); return next;
    end if;
    if rw.command_hash is distinct from recipe.canonical_hash(rw.command) then
      batch_id := rw.batch_id; problem := format('row %s: the command does not match its hash (DI-34)', rw.seq); return next;
    end if;
    if rw.events_hash is distinct from (select recipe.canonical_hash(coalesce(jsonb_agg(e.event order by e.idx), '[]'::jsonb)) from recipe.execution_event e where e.batch_id = rw.batch_id and e.row_seq = rw.seq) then
      batch_id := rw.batch_id; problem := format('row %s: the stored events do not match the events hash (DI-34)', rw.seq); return next;
    end if;
    if rw.device_class in ('SHARED', 'GRADE_A_B') and rw.auth_event_id is null then
      batch_id := rw.batch_id; problem := format('row %s was written on a shared terminal without a badge-tap event (INV-40)', rw.seq); return next;
    end if;
    v_prev := rw.row_hash;
  end loop;

  -- The projection is the state of the last row.
  for r in
    select p.batch_id as id, p.state_hash, p.state_version, p.last_seq, p.last_row_hash, recipe.canonical_hash(p.state) as computed,
           k.state_hash as row_state, k.state_version as row_version, k.row_hash as row_hash, (select max(x.seq) from recipe.execution_command x where x.batch_id = p.batch_id) as hi
    from recipe.execution_state p left join recipe.execution_command k on k.batch_id = p.batch_id and k.seq = p.last_seq
  loop
    if r.computed is distinct from r.state_hash or r.row_state is distinct from r.state_hash or r.row_version is distinct from r.state_version
       or r.last_seq is distinct from r.hi or r.last_row_hash is distinct from r.row_hash then
      batch_id := r.id; problem := 'the stored state is not the state of the last row (DI-34)'; return next;
    end if;
  end loop;
  for r in select b.id from recipe.batch_execution b where not exists (select 1 from recipe.execution_state p where p.batch_id = b.id) loop
    batch_id := r.id; problem := 'a test batch has no state (DI-34)'; return next;
  end loop;

  -- Content versions: numbered 1..n per aggregate and matching their hash.
  for r in
    select x.aggregate_id, x.batch_id as bid, count(*) as n, max(x.content_version) as hi,
           bool_and(x.content_hash = recipe.canonical_hash(x.content)) as hashes
    from (select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_step_content
          union all select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_stage_content
          union all select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_exception_content
          union all select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_point_content) x
    group by x.aggregate_id, x.batch_id
  loop
    if r.n <> r.hi or not r.hashes then
      batch_id := r.bid; problem := format('signable content of %s is not versioned 1..n or does not match its hash (DI-37)', r.aggregate_id); return next;
    end if;
  end loop;

  -- The engine's rules over the stored rows (F11 and later).
  for r in select v.batch_id as bid, v.problem as msg from recipe.execution_rule_violations() v loop
    batch_id := r.bid; problem := r.msg; return next;
  end loop;
end
$$;

reset role;
