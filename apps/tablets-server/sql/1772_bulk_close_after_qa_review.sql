-- Tablets server: a processing record's bulk reconciliation closes, and the record locks, at the end of QA's review of it
-- once its bulk is all packed, instead of at a lot's first disposition (owner demo report R10 #5; INV-21, PR-38).
-- Handbook: modules/tablets-server.md
--
-- Found (slice 7t's CI, golden batches GB-T-01 and GB-T-03). Tablets 1771 closed the reconciliation inside the first
-- disposition of a lot packed from the bulk. That holds the containers left and locks the record after the other lots'
-- QA reviews (and before a second market's decision on the same lot), so their release checklists showed items changed
-- since the review and the next release was refused (EBMR-REL-021) until the signer acknowledged them.
--
-- What holds now.
--   * Trigger zzzm_close_bulk_at_disposition (1771) and its trigger function are dropped; so is
--     recipe.bulk_reconciliation_close_at_disposition.
--   * recipe.bulk_reconciliation_close_after_review(parent, person, account): as 1771's function, and only once the
--     processing record is QA_REVIEWED in its current review cycle (recipe.batch_review_state). The reason for the
--     containers left (earlier stages' output or rejects) says the reconciliation closed at the end of QA's review.
--   * Trigger zzzm_close_bulk_after_review, AFTER INSERT on recipe.batch_review_act: QA's review of a processing record
--     closes it, attributed to the reviewer, when every packaging order of the bulk is already complete.
--   * Trigger zzzm_close_bulk_after_packing, AFTER UPDATE OF status on recipe.execution_state: a packaging order that
--     completes (EXECUTION_COMPLETE, ABORTED or CANCELLED) after its processing record's QA review closes the processing
--     record, attributed to the person whose act completed the order (no closure without a validated person).
--   In the usual order (process, pack, review the records, release) the record locks at the end of its QA review, before
--   any lot's review; with bulk left over production still closes it on the record screen with its own reason.
--
-- Messages: none new. The functions are SECURITY DEFINER, owned by ebmr_owner, private to the owner, and pin their
-- search_path with pg_temp last.

set local role ebmr_owner;

drop trigger zzzm_close_bulk_at_disposition on recipe.manufacturer_release_decision;
drop function recipe.close_bulk_at_disposition();
drop function recipe.bulk_reconciliation_close_at_disposition(uuid, uuid, uuid, uuid);

create function recipe.bulk_reconciliation_close_after_review(p_parent uuid, p_person uuid, p_account uuid) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, site, pg_temp as $$
declare
  v_left  uuid[];
  v_prod  jsonb;
  v_iss   jsonb;
begin
  if p_parent is null or recipe.batch_family_kind(p_parent) is distinct from 'PROCESSING'
     or exists (select 1 from recipe.bulk_reconciliation r where r.batch_id = p_parent)
     or recipe.record_lock_state(p_parent) <> 'UNLOCKED'
     or recipe.batch_review_state(p_parent) is distinct from 'QA_REVIEWED' then
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
  insert into recipe.bulk_reconciliation (batch_id, produced, issued, remaining, remaining_containers, remaining_held_reason, person_id, account_id)
  values (p_parent, v_prod, v_iss, recipe.bulk_totals(p_parent, array['LEFT']), v_left,
          case when cardinality(v_left) > 0 then format('Closed at the end of QA''s review with all bulk packed: the %s container(s) left hold earlier stages'' output or rejects (tablets 1772)', cardinality(v_left)) end,
          p_person, p_account);
  perform recipe.record_lock_append(p_parent, 'LOCKED', 'BULK_RECONCILIATION_CLOSED', null, null, p_person, p_account);
  return true;
end
$$;

create function recipe.close_bulk_after_review() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if new.act = 'QA_REVIEWED' then
    perform recipe.bulk_reconciliation_close_after_review(new.batch_id, new.person_id, new.account_id);
  end if;
  return null;
end
$$;
create trigger zzzm_close_bulk_after_review after insert on recipe.batch_review_act for each row execute function recipe.close_bulk_after_review();

create function recipe.close_bulk_after_packing() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_parent uuid;
  v_actor  jsonb;
begin
  if new.status is distinct from old.status and new.status in ('EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED')
     and recipe.batch_family_kind(new.batch_id) = 'PACKAGING' then
    v_parent := recipe.packaging_parent_of(new.batch_id);
    if v_parent is not null and recipe.batch_review_state(v_parent) = 'QA_REVIEWED' then
      begin
        v_actor := iam.assert_validated_actor();
      exception when others then
        return null;
      end;
      perform recipe.bulk_reconciliation_close_after_review(v_parent, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
    end if;
  end if;
  return null;
end
$$;
create trigger zzzm_close_bulk_after_packing after update of status on recipe.execution_state for each row execute function recipe.close_bulk_after_packing();

revoke all on function recipe.bulk_reconciliation_close_after_review(uuid, uuid, uuid), recipe.close_bulk_after_review(), recipe.close_bulk_after_packing() from public;

reset role;
