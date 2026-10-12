-- Records (kernel): a request to delete a record before or after its retention is answered and logged, never carried out
-- here (Phase 4 slice 6b; PR-59 "deleting before the date is refused and logged", IN-08, DI-47; default D-6-5: retention
-- computes and shows the earliest date, no deletion is built).
--
--   records.disposal_request   insert-only: every request, by whom, why, and the database's answer: REFUSED with the
--                              refusals of records.disposal_refusals (open retention, retain-until not reached, a hold, a
--                              blocker, no schedule) or ELIGIBLE (the record may go to the existing QA disposal approval).
--   records.request_disposal(aggregate_type, aggregate_id, reason) returns jsonb {recordKey, outcome, status, retainUntil,
--                              governedBy, refusals}: RECORD.RETENTION_MANAGE, not an administrator, a reason; the answer
--                              is recomputed from the stored inputs and rule rows (never from the caller). EBMR-REC-130.
-- The row is written in the caller's transaction and kept when the caller commits; the screens commit the answer they
-- show, so a refused request stays in the log.

set local role ebmr_owner;

create table records.disposal_request (
  id              uuid primary key default gen_random_uuid(),
  record_key      text not null,
  outcome         text not null check (outcome in ('REFUSED', 'ELIGIBLE')),
  status          text,
  retain_until    date,
  refusals        jsonb not null check (jsonb_typeof(refusals) = 'array'),
  reason          text not null check (btrim(reason) <> ''),
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  check ((outcome = 'REFUSED') = (jsonb_array_length(refusals) > 0))
);
create index disposal_request_record on records.disposal_request (record_key, recorded_at);
revoke all on records.disposal_request from public;
grant select on records.disposal_request to ebmr_app;
select platform.enforce_db_time('records.disposal_request', array['recorded_at']);
select kernel.register_audited_table('records.disposal_request', 'disposal_request', 'record_key', true);

create function records.request_disposal(p_aggregate_type text, p_aggregate_id text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, iam, pg_temp as $$
declare
  v_actor    jsonb;
  v_key      text;
  v_sched    records.retention_schedule%rowtype;
  v_eff      jsonb;
  v_refusals jsonb;
  v_outcome  text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.RETENTION_MANAGE', '{}'::jsonb);
  if records.is_blank(p_aggregate_type) or records.is_blank(p_aggregate_id) or records.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-130 a disposal request names the record and the reason';
  end if;
  v_key := records.record_key(p_aggregate_type, p_aggregate_id);
  select * into v_sched from records.retention_schedule where record_key = v_key;
  if v_sched.id is null then
    v_refusals := jsonb_build_array(jsonb_build_object('code', 'EBMR-REC-021', 'detail', format('%s has no retention schedule: it is kept', v_key)));
  else
    v_eff := records.compute_effective_retention(v_sched.id);
    select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'detail', r.detail)), '[]'::jsonb) into v_refusals
      from records.disposal_refusals(v_sched.id) r;
  end if;
  v_outcome := case when jsonb_array_length(v_refusals) > 0 then 'REFUSED' else 'ELIGIBLE' end;
  insert into records.disposal_request (record_key, outcome, status, retain_until, refusals, reason, person_id, account_id, correlation_id)
  values (v_key, v_outcome, v_eff ->> 'status', (v_eff ->> 'retainUntil')::date, v_refusals, btrim(p_reason),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('recordKey', v_key, 'outcome', v_outcome, 'status', v_eff ->> 'status', 'retainUntil', v_eff ->> 'retainUntil',
                            'governedBy', coalesce(v_eff -> 'governedBy', '[]'::jsonb), 'refusals', v_refusals);
end
$$;

revoke all on function records.request_disposal(text, text, text) from public;
grant execute on function records.request_disposal(text, text, text) to ebmr_app;

reset role;
