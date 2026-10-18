-- Recipe core: the destinations a mock recall asks come from the run itself, after the permission check (Phase 7 slice
-- 7b-1, review residual 6jc-R12; IN-29, PR-57).
--
-- Handbook: modules/recipe-core.md
--
-- Why. The server's mock recall (features/genealogy/index.ts) read the forward genealogy itself to find the outbound
-- transfers to ask, and took a failure of that read as "no outbound transfer": no destination was asked and the run went
-- on. It also asked the other sites before the database checked RECALL.MOCK_RUN (recipe.run_mock_recall and
-- recipe.record_mock_recall_remote refused afterwards and rolled the command back, after the peers had answered).
--
--   recipe.mock_recall_destinations(run) jsonb  [{transferId, destination}] of the outbound transfers the stored run
--       reached (its result's transfers, recipe-core 1091) that have no ANSWERED row yet, in the run's order
--       (recipe.mock_recall_federation, 1092). Refuses an administrator first (EBMR-IAM-042), then without
--       RECALL.MOCK_RUN (EBMR-IAM-040), an unknown run (EBMR-RCL-010) and a signed-off run (EBMR-RCL-020), as
--       recipe.record_mock_recall_remote does. VOLATILE (it asks iam.require_permission), SECURITY DEFINER, EXECUTE to
--       ebmr_app.
-- The server now runs recipe.run_mock_recall first (permission, subject and instant checked, the run stored with its
-- transfers), then asks exactly the destinations this function names, then records each answer; the refresh asks the
-- same function first. A destination that cannot be asked keeps no ANSWERED row, so the run is shown and signed off as
-- incomplete (recipe.mock_recall_federation), never as complete, and never as "no destination".

set local role ebmr_owner;

create function recipe.mock_recall_destinations(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  m recipe.mock_recall;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECALL.MOCK_RUN', '{}'::jsonb);
  select * into m from recipe.mock_recall where id = p_id;
  if m.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-RCL-010 there is no mock recall %s', coalesce(p_id::text, 'NULL'));
  end if;
  if exists (select 1 from recipe.mock_recall_signoff s where s.mock_recall_id = m.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-RCL-020 the mock recall is signed off; what other sites answer is recorded before the sign-off';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('transferId', t ->> 'transfer_id', 'destination', t ->> 'destination') order by n)
                     from jsonb_array_elements(recipe.mock_recall_federation(m.id) -> 'transfers') with ordinality x(t, n)
                    where t ->> 'status' is distinct from 'ANSWERED'), '[]'::jsonb);
end
$$;
revoke all on function recipe.mock_recall_destinations(uuid) from public;
grant execute on function recipe.mock_recall_destinations(uuid) to ebmr_app;

reset role;
