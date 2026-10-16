-- Tablets: the engine roles of a command on a batch are evaluated in the batch's scope, the actor's location with the
-- batch's product added (Phase 6 exit review 6jc-R16; recipe-core 1100; IN-04, DI-21, DI-17, INV-26).
--
-- Handbook: modules/tablets-server.md
--
--   * tab.engine_roles(batch): as tab.engine_roles() of 0200, each permission evaluated in the scope
--     iam.actor_location_scope() || recipe.batch_scope_members(batch). A qualification requirement limited to another
--     product then no longer applies to the command; one limited to this product, or to none, applies as before.
--     recipe.append_execution (recipe-core 1100) accepts an evaluation in exactly that scope (or at the location only);
--     the database holds the scope to the batch the row is appended to, so naming another batch here gains nothing.
--   * tab.engine_roles() is unchanged; the batch issue (no batch exists yet) keeps it.

set local role ebmr_owner;

create function tab.engine_roles(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_scope jsonb := iam.actor_location_scope() || recipe.batch_scope_members(p_batch);
  m       tab.engine_role_map;
  v_eval  jsonb;
  v_out   jsonb := '[]'::jsonb;
begin
  for m in select * from tab.engine_role_map where kernel_role = v_actor ->> 'role_code' order by engine_role loop
    v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, m.via_permission, v_scope,
                                     clock_timestamp(), m.kernel_role);
    if (v_eval ->> 'allowed')::boolean then
      v_out := v_out || jsonb_build_array(jsonb_build_object('role', m.engine_role, 'permission', m.via_permission, 'evaluationId', v_eval ->> 'evaluation_id'));
    end if;
  end loop;
  return v_out;
end
$$;

revoke all on function tab.engine_roles(uuid) from public;
grant execute on function tab.engine_roles(uuid) to ebmr_app;

reset role;
