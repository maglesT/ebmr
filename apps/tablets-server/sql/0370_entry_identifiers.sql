-- Tablets edition, module C3: an entry of a test run records only test identifiers and registered test lots (Phase 2
-- exit review F12; DI-05, INV-18, PR-18; ADR 0012: the rules hold when the application's own database credentials are
-- used directly).
--
-- The sandbox identifier rule (kernel 0810: sandbox.identifier_problem, sandbox.guard_identifier) was applied only to
-- columns of a few tables: the batch number of a test batch (recipe-core 0200) and the code of a sandbox lot (tablets
-- 0200). Identifiers carried inside an execution entry were checked nowhere in the database, and the previous batch of
-- a line clearance nowhere at all: a trainee who typed the real previous GMP batch (B24-0001) on the floor form had it
-- recorded, accepted, in the test run's command and state. The lot of a weighing was checked only by the server's
-- lookup (EBMR-EXE-072): with that lookup bypassed, a weighing of a real-format lot that is no sandbox lot was stored.
--
-- A row trigger on recipe.execution_command (ad_tab_entry_identifiers, before insert, after the recipe and device
-- checks) now refuses a person's RECORD_ENTRY row, accepted or refused, whose entry (EBMR-EXE-078):
--   * names a batch number that is not a test batch number of this installation (sandbox.identifier_problem
--     BATCH_NUMBER): the previous batch of a line clearance (PREVIOUS_BATCH.batchNumber; the block's own word NONE, for
--     no previous batch, excepted), the batch printed on a scanned container label (CHARGE_CONTAINER.scannedBatch) and
--     the source batch of a recovery (SOURCE_ADDITION.sourceBatch);
--   * names a container or lot that is not a test lot number (LOT_NUMBER): the container of CONTAINER_WEIGHING,
--     CHARGE_CONTAINER, CHARGE_LOT, OUTPUT_CONTAINER, SAMPLE and DISPOSAL, and the lot of CONTAINER_WEIGHING and
--     CHARGE_LOT;
--   * in a SANDBOX installation, names a lot (CONTAINER_WEIGHING, CHARGE_LOT) that is not a registered sandbox lot, or
--     states other facts of it than the register holds when the row is written (material, status, expiry and retest
--     instants, identity test; as the server's tab.resolve_lot gives them).
-- In a GMP installation the same identifier rule refuses TEST- identifiers instead (EBMR-SBX-021 semantics).
--
-- The trigger function is SECURITY DEFINER, owned by ebmr_owner, private to the owner, and pins its search_path with
-- pg_temp last. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, PR-18: why entry p_entry (a RECORD_ENTRY's entry, as recorded) names an identifier this installation never
-- records in an entry, or a lot other than its register entry; NULL when it does not.
create function tab.entry_identifier_problem(p_entry jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, platform, sandbox, kernel, pg_temp as $$
declare
  v_kind  text := p_entry ->> 'kind';
  v_check record;
  v_p     text;
  v_lot   jsonb;
  v_reg   jsonb;
begin
  for v_check in
    select c.member, c.idkind
      from (values ('PREVIOUS_BATCH', 'batchNumber', 'BATCH_NUMBER'), ('CHARGE_CONTAINER', 'scannedBatch', 'BATCH_NUMBER'),
                   ('SOURCE_ADDITION', 'sourceBatch', 'BATCH_NUMBER'),
                   ('CONTAINER_WEIGHING', 'container', 'LOT_NUMBER'), ('CHARGE_CONTAINER', 'container', 'LOT_NUMBER'),
                   ('CHARGE_LOT', 'container', 'LOT_NUMBER'), ('OUTPUT_CONTAINER', 'container', 'LOT_NUMBER'),
                   ('SAMPLE', 'container', 'LOT_NUMBER'), ('DISPOSAL', 'container', 'LOT_NUMBER')) c (kind, member, idkind)
     where c.kind = v_kind and p_entry ? c.member and jsonb_typeof(p_entry -> c.member) is distinct from 'null'
  loop
    continue when v_kind = 'PREVIOUS_BATCH' and p_entry -> v_check.member = '"NONE"'::jsonb;
    v_p := sandbox.identifier_problem(v_check.idkind, p_entry ->> v_check.member);
    if v_p is not null then
      return format('%s %s', v_check.member, regexp_replace(v_p, '\s*\[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
    end if;
  end loop;
  if v_kind in ('CONTAINER_WEIGHING', 'CHARGE_LOT') then
    v_lot := p_entry -> 'lot';
    v_p := sandbox.identifier_problem('LOT_NUMBER', coalesce(v_lot ->> 'id', ''));
    if v_p is not null then
      return format('lot %s', regexp_replace(v_p, '\s*\[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
    end if;
    if kernel.installation_kind() = 'SANDBOX' then
      select jsonb_strip_nulls(jsonb_build_object(
               'id', l.lot_code, 'material', l.material_code, 'status', l.status,
               'expiresAtUs', case when l.expires_at is null then null else platform.epoch_micros(l.expires_at)::text end,
               'retestAtUs', case when l.retest_at is null then null else platform.epoch_micros(l.retest_at)::text end,
               'identityTested', l.identity_tested))
        into v_reg
        from tab.sandbox_lot l where l.lot_code = v_lot ->> 'id';
      if v_reg is null then
        return format('lot %s is not a registered test lot of this installation', left(v_lot ->> 'id', 64));
      end if;
      if v_lot is distinct from v_reg then
        return format('lot %s states other facts than the lot register holds (%s)', v_lot ->> 'id', v_reg::text);
      end if;
    end if;
  end if;
  return null;
end
$$;

create function tab.entry_identifiers_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.command_type is distinct from 'RECORD_ENTRY' then
    return new;
  end if;
  v_problem := tab.entry_identifier_problem(new.command -> 'entry');
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The %s entry of this RECORD_ENTRY row is refused: %s; an entry in a test run records only test identifiers and registered test lots (DI-05, PR-18). [EBMR-EXE-078]',
                       coalesce(new.command -> 'entry' ->> 'kind', 'unnamed'), v_problem);
  end if;
  return new;
end
$$;

create trigger ad_tab_entry_identifiers before insert on recipe.execution_command
  for each row execute function tab.entry_identifiers_check();

revoke all on function tab.entry_identifier_problem(jsonb), tab.entry_identifiers_check() from public;

reset role;
