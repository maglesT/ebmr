-- Tablets server: a processing record's bulk reconciliation closes, and the record locks, at the first disposition of a
-- lot packed from it once nothing is left for production to decide (owner demo report R10 #5; INV-21, PR-38).
--
-- Found. A processing record locks only at its bulk reconciliation's closure (outline 5.2.10 "Locking", INV-21), and the
-- closure was only production's own act on the record screen (recipe.close_bulk_reconciliation, recipe-core 0871). The
-- review and release path never reaches it, so a processing record stayed UNLOCKED after QA's review and the release of
-- its lots, while the packaging record locks at its lot's first disposition (recipe-core 0870).
--
-- What holds now.
--   * recipe.bulk_reconciliation_close_at_disposition(parent, lot, person, account): closes the bulk reconciliation of
--     processing batch `parent` and locks it (BULK_RECONCILIATION_CLOSED, naming the lot), attributed to the person whose
--     disposition of `lot` triggered it, when it can close without anyone's decision: the record is still UNLOCKED with no
--     reconciliation, recipe.bulk_close_problems names nothing (execution complete, every packaging order of the bulk
--     closed, no container open), never more issued than produced, and no container left is bulk (tablets 1770,
--     recipe.packaging_bulk_problem). What is left then is earlier stages' output or rejects: the closure holds those
--     containers, with that stated as the reason. Otherwise it closes nothing and returns false: bulk left over needs
--     production's own close with its reason, which stays as it was.
--   * Trigger zzzm_close_bulk_at_disposition, AFTER INSERT on recipe.manufacturer_release_decision (one row per lot: its
--     first disposition): for the lot's batch's processing batch (recipe.packaging_parent_of), in the same transaction.
--   The lock point is unchanged (INV-21: only at the bulk reconciliation's closure); only who closes it in that case is new.
--
-- Records already released are not locked by this migration: a lock event and a reconciliation are attributed to the
-- person whose act closes them, and no act exists for those. Production closes them on the record screen
-- (/records/<batch>, "Close the bulk reconciliation and lock the record", with the reason for what is left).
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, private to the owner, and pin their search_path with pg_temp
-- last. A new migration, because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create function recipe.bulk_reconciliation_close_at_disposition(p_parent uuid, p_lot uuid, p_person uuid, p_account uuid) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, site, pg_temp as $$
declare
  v_left  uuid[];
  v_prod  jsonb;
  v_iss   jsonb;
  v_lot   text;
begin
  if p_parent is null or recipe.batch_family_kind(p_parent) is distinct from 'PROCESSING'
     or exists (select 1 from recipe.bulk_reconciliation r where r.batch_id = p_parent)
     or recipe.record_lock_state(p_parent) <> 'UNLOCKED' then
    return false;
  end if;
  -- Serialise with the engine and with every bulk issue from the batch, as production's close does (0871).
  perform 1 from recipe.batch_execution b where b.id = p_parent for update;
  perform 1 from recipe.execution_state s where s.batch_id = p_parent for update;
  perform 1 from plant.output_container c where c.batch_id = p_parent for update;
  if cardinality(recipe.bulk_close_problems(p_parent)) > 0 then
    return false;
  end if;
  v_left := array(select c.id from plant.output_container c where c.batch_id = p_parent and recipe.bulk_container_disposition(c.id) = 'LEFT' order by c.label_code);
  if exists (select 1 from unnest(v_left) x where recipe.packaging_bulk_problem(x) is null) then
    return false;
  end if;
  v_prod := recipe.bulk_totals(p_parent, array['ISSUED', 'CHARGED', 'REJECTED', 'LEFT']);
  v_iss := recipe.bulk_totals(p_parent, array['ISSUED']);
  if exists (select 1 from jsonb_array_elements(v_iss) i
              where (i ->> 'quantity')::numeric > coalesce((select (p ->> 'quantity')::numeric from jsonb_array_elements(v_prod) p where p ->> 'unit' = i ->> 'unit'), 0)) then
    return false;
  end if;
  v_lot := coalesce((select l.lot_code from site.material_lot l where l.id = p_lot), p_lot::text);
  insert into recipe.bulk_reconciliation (batch_id, produced, issued, remaining, remaining_containers, remaining_held_reason, person_id, account_id)
  values (p_parent, v_prod, v_iss, recipe.bulk_totals(p_parent, array['LEFT']), v_left,
          case when cardinality(v_left) > 0 then format('Closed at the first disposition of lot %s: no bulk for packing is left; the %s container(s) left hold earlier stages'' output or rejects (tablets 1771)', v_lot, cardinality(v_left)) end,
          p_person, p_account);
  perform recipe.record_lock_append(p_parent, 'LOCKED', 'BULK_RECONCILIATION_CLOSED', p_lot, null, p_person, p_account);
  return true;
end
$$;

create function recipe.close_bulk_at_disposition() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_batch uuid := (select f.batch_id from site.finished_lot f where f.lot_id = new.lot_id);
begin
  if v_batch is not null and exists (select 1 from recipe.batch_execution b where b.id = v_batch) then
    perform recipe.bulk_reconciliation_close_at_disposition(recipe.packaging_parent_of(v_batch), new.lot_id, new.person_id, new.account_id);
  end if;
  return null;
end
$$;
create trigger zzzm_close_bulk_at_disposition after insert on recipe.manufacturer_release_decision for each row execute function recipe.close_bulk_at_disposition();

revoke all on function recipe.bulk_reconciliation_close_at_disposition(uuid, uuid, uuid, uuid), recipe.close_bulk_at_disposition() from public;

reset role;
