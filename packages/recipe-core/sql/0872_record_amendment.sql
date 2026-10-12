-- Recipe core: the amendment of a locked record (Phase 4 slice 5b; outline 5.2.10 "Locking"; INV-21, R-04, IN-29;
-- default D-5-7, D-5b-5 to D-5b-8 in docs/build-plan/phase-4/phase-4-plan.md).
--
--   LOCKED -> UNDER_AMENDMENT  recipe.open_record_amendment(batch, basis kind, basis id, reason code, reason text, signature):
--       RECORD.QA_REVIEW in the batch's scope, QA's AMENDMENT_OPENED signature on record_lock
--       <batch>/<n>/OPEN/<DEVIATION|CHANGE_RECORD>/<basis id> (state LOCKED); the basis is a deviation linked to the record
--       (or to a lot made from it) and neither CLOSED nor CANCELLED, or a change record; the person's own reason. In the
--       same transaction: for every lot made from the record (recipe.lots_of_batch) whose manufacturer release is
--       RELEASED, one AP-owned market-impact task per market already released (IN; US RELEASED; EU CERTIFIED), then
--       recipe.suspend_release(lot, cause) (the 4-0 interface; slice 5a builds it: until then it refuses, and so does the
--       opening, whole: a released record is never amended without its releases suspended). The cause:
--       {"kind": "RECORD_AMENDMENT", "batch_id", "batch_number", "amendment_id", "amendment_number", "basis_kind",
--        "basis_id", "signature_id"}.
--   UNDER_AMENDMENT: recipe.append_amendment_entry(batch, n, kind, target, text, value, reason): STEP.EXECUTE in the batch's
--       scope; LATE_ENTRY, CORRECTION or NOTE; insert-only, numbered; the record itself stays as it was (0870 refuses
--       every write to it).
--   UNDER_AMENDMENT -> LOCKED  recipe.close_record_amendment(batch, n, statement, signature): RECORD.QA_REVIEW, QA's
--       AMENDMENT_CLOSED signature on record_lock <batch>/<n>/CLOSE (state UNDER_AMENDMENT) over the entries as they
--       stand, by a person who appended none of them (the meaning excludes the involved; checked here too).
--   Every act bumps the record's evidence epoch (0870), so a review or release evaluated before it is evaluated again;
--   the lots' epochs move with the opening.
--   recipe.amendment_market_task (insert-only): the AP's market-impact tasks (state derived by the read: OPEN while the
--       amendment is open or the lot's disposition for the market is RELEASE_SUSPENDED, DONE after).
--
-- Messages: EBMR-LCK-030 to EBMR-LCK-059.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0872_record_amendment)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'amendment of a locked batch record (outline 5.2.10; INV-21, R-04)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('AMENDMENT_OPENED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'REVIEWER', 'Amendment of a locked record opened',
   'Quality unit: I open an amendment of this locked record under the cited deviation or change record; the releases of its lots are suspended.',
   array['RECORD.QA_REVIEW'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.10; INV-21; R-04'),
  ('AMENDMENT_CLOSED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'REVIEWER', 'Amendment of a record closed',
   'Quality unit: I have reviewed the entries appended by this amendment and lock the record again.',
   array['RECORD.QA_REVIEW'], '{}', false, true, false, 'ALL_COMPONENTS', false, 'Outline 5.2.10; INV-21');

select kernel.set_actor_context(null);

create table recipe.record_amendment (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references recipe.batch_execution (id),
  number             integer not null check (number >= 1),
  basis_kind         text not null check (basis_kind in ('DEVIATION', 'CHANGE_RECORD')),
  deviation_id       uuid,
  change_record_id   uuid references recipe.change_record (id),
  reason_code        text not null check (btrim(reason_code) <> '' and length(reason_code) <= 64),
  reason_text        text not null check (length(btrim(reason_text)) >= 10),
  suspended_lots     uuid[] not null,
  content            jsonb not null check (jsonb_typeof(content) = 'object'),
  signature_id       uuid not null unique,
  person_id          uuid not null,
  account_id         uuid not null,
  opened_at          timestamptz not null default clock_timestamp(),
  unique (batch_id, number),
  check ((basis_kind = 'DEVIATION') = (deviation_id is not null)),
  check ((basis_kind = 'CHANGE_RECORD') = (change_record_id is not null))
);
revoke all on recipe.record_amendment from public;
grant select on recipe.record_amendment to ebmr_app;
select platform.enforce_db_time('recipe.record_amendment', array['opened_at']);
select kernel.register_audited_table('recipe.record_amendment', 'record_lock', 'batch_id', true);

create table recipe.record_amendment_entry (
  id            uuid primary key default gen_random_uuid(),
  amendment_id  uuid not null references recipe.record_amendment (id),
  batch_id      uuid not null references recipe.batch_execution (id),
  seq           integer not null check (seq >= 1),
  kind          text not null check (kind in ('LATE_ENTRY', 'CORRECTION', 'NOTE')),
  target        text not null check (btrim(target) <> '' and length(target) <= 200),
  body          text not null check (btrim(body) <> '' and length(body) <= 4000),
  value         text check (value is null or (btrim(value) <> '' and length(value) <= 200)),
  reason        text not null check (length(btrim(reason)) >= 10),
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  unique (amendment_id, seq)
);
revoke all on recipe.record_amendment_entry from public;
grant select on recipe.record_amendment_entry to ebmr_app;
select platform.enforce_db_time('recipe.record_amendment_entry', array['recorded_at']);
select kernel.register_audited_table('recipe.record_amendment_entry', 'record_lock', 'batch_id', true);

create table recipe.record_amendment_close (
  amendment_id   uuid primary key references recipe.record_amendment (id),
  batch_id       uuid not null references recipe.batch_execution (id),
  statement      text not null check (length(btrim(statement)) >= 10),
  content        jsonb not null check (jsonb_typeof(content) = 'object'),
  signature_id   uuid not null unique,
  person_id      uuid not null,
  account_id     uuid not null,
  closed_at      timestamptz not null default clock_timestamp()
);
revoke all on recipe.record_amendment_close from public;
grant select on recipe.record_amendment_close to ebmr_app;
select platform.enforce_db_time('recipe.record_amendment_close', array['closed_at']);
select kernel.register_audited_table('recipe.record_amendment_close', 'record_lock', 'batch_id', true);

create table recipe.amendment_market_task (
  id                  uuid primary key default gen_random_uuid(),
  amendment_id        uuid not null references recipe.record_amendment (id),
  batch_id            uuid not null references recipe.batch_execution (id),
  lot_id              uuid not null,
  market              text not null check (market in ('IN', 'US', 'EU')),
  owner_role          text not null default 'AUTHORISED_PERSON' check (owner_role = 'AUTHORISED_PERSON'),
  disposition_before  text not null,
  opened_at           timestamptz not null default clock_timestamp(),
  unique (amendment_id, lot_id, market)
);
revoke all on recipe.amendment_market_task from public;
grant select on recipe.amendment_market_task to ebmr_app;
select platform.enforce_db_time('recipe.amendment_market_task', array['opened_at']);
select kernel.register_audited_table('recipe.amendment_market_task', 'record_lock', 'batch_id', true);

-- The record's lock subject for screens and signatures: number and kind.
create function recipe.record_lock_ref(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'record_kind', recipe.batch_family_kind(b.id))
    from recipe.batch_execution b where b.id = p_batch
$$;

-- The released lots made from the record and the markets already released for each (before any suspension).
create function recipe.record_released_lots(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'lot_id', l, 'lot_code', (select m.lot_code from site.material_lot m where m.id = l),
           'markets', (select coalesce(jsonb_agg(jsonb_build_object('market', x.market, 'disposition', x.d) order by x.market), '[]'::jsonb)
                         from (select 'IN' as market, 'RELEASED' as d
                               union all
                               select mk, recipe.disposition_state(l, mk) from unnest(array['US', 'EU']) mk
                                where recipe.disposition_state(l, mk) in ('RELEASED', 'CERTIFIED')) x))
         order by l), '[]'::jsonb)
    from unnest(recipe.lots_of_batch(p_batch)) l
   where recipe.manufacturer_release_state(l) = 'RELEASED'
$$;

create function recipe.record_lock_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, plant, pg_temp as $$
declare
  m       text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([1-9][0-9]{0,5})/(OPEN|CLOSE)(/(DEVIATION|CHANGE_RECORD)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$');
  v_batch uuid;
  v_n     integer;
  a       recipe.record_amendment;
  x       recipe.record_amendment_close;
  v_ref   jsonb;
  v_basis jsonb;
begin
  if m is null or (m[3] = 'OPEN') = (m[5] is null) then
    return '{"exists": false}'::jsonb;
  end if;
  v_batch := m[1]::uuid;
  v_n := m[2]::integer;
  v_ref := recipe.record_lock_ref(v_batch);
  if v_ref is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into a from recipe.record_amendment r where r.batch_id = v_batch and r.number = v_n;
  if m[3] = 'OPEN' then
    if a.id is not null then
      if a.basis_kind <> m[5] or coalesce(a.deviation_id, a.change_record_id) <> m[6]::uuid then
        return '{"exists": false}'::jsonb;
      end if;
      return jsonb_build_object('exists', true, 'content_version', 1, 'content', a.content, 'state', 'RECORDED',
                                'scope', plant.batch_scope(v_batch), 'involved', '[]'::jsonb);
    end if;
    if v_n <> (select count(*) + 1 from recipe.record_amendment r where r.batch_id = v_batch) then
      return '{"exists": false}'::jsonb;
    end if;
    v_basis := case m[5]
                 when 'DEVIATION' then (select jsonb_build_object('kind', 'DEVIATION', 'id', d.id, 'ref', d.ref, 'title', d.title, 'state', site.deviation_state(d.id))
                                          from site.deviation d where d.id = m[6]::uuid)
                 else (select jsonb_build_object('kind', 'CHANGE_RECORD', 'id', c.id, 'ref', c.number, 'title', c.title) from recipe.change_record c where c.id = m[6]::uuid)
               end;
    if v_basis is null then
      return '{"exists": false}'::jsonb;
    end if;
    return jsonb_build_object(
      'exists', true, 'content_version', 1,
      'content', v_ref || jsonb_build_object('act', 'AMENDMENT_OPEN', 'amendment_number', v_n, 'basis', v_basis,
                                             'lock_state', recipe.record_lock_state(v_batch),
                                             'released_lots', recipe.record_released_lots(v_batch)),
      'state', recipe.record_lock_state(v_batch),
      'scope', plant.batch_scope(v_batch),
      'involved', '[]'::jsonb);
  end if;
  -- CLOSE
  if a.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into x from recipe.record_amendment_close c where c.amendment_id = a.id;
  if x.amendment_id is not null then
    return jsonb_build_object('exists', true, 'content_version', 1, 'content', x.content, 'state', 'RECORDED',
                              'scope', plant.batch_scope(v_batch), 'involved', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'content', v_ref || jsonb_build_object(
      'act', 'AMENDMENT_CLOSE', 'amendment_number', v_n, 'amendment_id', a.id, 'basis_kind', a.basis_kind,
      'basis_id', coalesce(a.deviation_id, a.change_record_id), 'reason_code', a.reason_code, 'reason_text', a.reason_text,
      'entries', (select coalesce(jsonb_agg(jsonb_build_object('seq', e.seq, 'kind', e.kind, 'target', e.target, 'text', e.body, 'value', e.value,
                                                                'reason', e.reason, 'person_id', e.person_id) order by e.seq), '[]'::jsonb)
                    from recipe.record_amendment_entry e where e.amendment_id = a.id)),
    -- The open amendment is the record's state; an earlier one never is.
    'state', case when recipe.record_lock_state(v_batch) = 'UNDER_AMENDMENT'
                       and v_n = (select max(r.number) from recipe.record_amendment r where r.batch_id = v_batch) then 'UNDER_AMENDMENT' else 'LOCKED' end,
    'scope', plant.batch_scope(v_batch),
    'involved', (select coalesce(jsonb_agg(distinct e.person_id), '[]'::jsonb) from recipe.record_amendment_entry e where e.amendment_id = a.id));
end
$$;

select esig.register_content_provider('record_lock', 'recipe.record_lock_content(text)',
  'The opening or closing of an amendment of a locked batch record, with its basis, the lots it suspends and its entries (outline 5.2.10)');

-- The aggregate id an amendment act signs: OPEN with its basis, or CLOSE of the open amendment (NULL when none is open).
create function recipe.record_lock_next_id(p_batch uuid, p_act text, p_basis_kind text, p_basis uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case p_act
           when 'OPEN' then format('%s/%s/OPEN/%s/%s', p_batch, (select count(*) + 1 from recipe.record_amendment r where r.batch_id = p_batch), p_basis_kind, p_basis)
           when 'CLOSE' then (select format('%s/%s/CLOSE', p_batch, r.number) from recipe.record_amendment r
                               where r.batch_id = p_batch and not exists (select 1 from recipe.record_amendment_close c where c.amendment_id = r.id)
                               order by r.number desc limit 1)
         end
$$;

create function recipe.open_record_amendment(p_batch uuid, p_basis_kind text, p_basis uuid, p_reason_code text, p_reason_text text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, plant, pg_temp as $$
declare
  v_actor   jsonb;
  b         recipe.batch_execution;
  v_state   text;
  v_dstate  text;
  v_aid     text;
  v_sig     jsonb;
  v_content jsonb;
  v_lots    jsonb;
  v_id      uuid;
  v_n       integer;
  l         jsonb;
  k         jsonb;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.batch_execution where id = p_batch for update;
  if not found or b.purpose <> 'GMP_BATCH' then
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-030 %s is no GMP batch record', coalesce(p_batch::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('RECORD.QA_REVIEW', plant.batch_scope(p_batch));
  v_state := recipe.record_lock_state(p_batch);
  if v_state <> 'LOCKED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LCK-031 batch record %s is %s: an amendment is opened on a LOCKED record only (%s) (INV-21)', b.batch_number, v_state,
                       case v_state when 'UNLOCKED' then 'an unlocked record is still written by its own paths' else 'one amendment is open at a time' end);
  end if;
  if p_basis_kind = 'DEVIATION' then
    v_dstate := site.deviation_state(p_basis);
    if v_dstate is null or v_dstate in ('CLOSED', 'CANCELLED') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-LCK-032 an amendment is opened under an open deviation (the deviation is %s) or a change record (D-5-7)', coalesce(v_dstate, 'unknown'));
    end if;
    if not exists (select 1 from site.deviation_link k2 where k2.deviation_id = p_basis
                      and (k2.batch_id = p_batch or (k2.subject_kind = 'LOT' and k2.subject_id = any (recipe.lots_of_batch(p_batch))))) then
      raise exception using errcode = 'P0001', message = format('EBMR-LCK-033 the deviation is not linked to batch record %s or to a lot made from it (D-5-7)', b.batch_number);
    end if;
  elsif p_basis_kind = 'CHANGE_RECORD' then
    if p_basis is null or not exists (select 1 from recipe.change_record c where c.id = p_basis) then
      raise exception using errcode = 'P0001', message = 'EBMR-LCK-032 an amendment is opened under an open deviation or a change record (D-5-7): the change record does not exist';
    end if;
  else
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-032 an amendment is opened under a DEVIATION or a CHANGE_RECORD, not %s (D-5-7)', coalesce(p_basis_kind, 'NULL'));
  end if;
  if p_reason_code is null or btrim(p_reason_code) = '' or length(p_reason_code) > 64 or p_reason_text is null or length(btrim(p_reason_text)) < 10 then
    raise exception using errcode = 'P0001', message = 'EBMR-LCK-034 an amendment carries the person''s own reason: a code and a text of at least 10 characters (DI-22)';
  end if;

  v_aid := recipe.record_lock_next_id(p_batch, 'OPEN', p_basis_kind, p_basis);
  v_sig := recipe.assert_release_signature(p_signature, 'AMENDMENT_OPENED', 'record_lock', v_aid, (v_actor ->> 'person_id')::uuid);
  v_content := esig.provide('record_lock', v_aid);
  if esig.content_hash_of('record_lock', v_aid, v_content) is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-LCK-035 the signed amendment is not the current one (the record or its lots moved); sign it again (DI-37)';
  end if;
  v_n := split_part(v_aid, '/', 2)::integer;
  v_lots := v_content -> 'content' -> 'released_lots';
  insert into recipe.record_amendment (batch_id, number, basis_kind, deviation_id, change_record_id, reason_code, reason_text, suspended_lots, content,
                                       signature_id, person_id, account_id)
  values (p_batch, v_n, p_basis_kind, case p_basis_kind when 'DEVIATION' then p_basis end, case p_basis_kind when 'CHANGE_RECORD' then p_basis end,
          btrim(p_reason_code), btrim(p_reason_text), array(select (x ->> 'lot_id')::uuid from jsonb_array_elements(v_lots) x), v_content -> 'content',
          p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  perform recipe.record_lock_append(p_batch, 'AMENDMENT_OPENED', null, null, v_id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  -- R-04: the AP assesses every market already released; the releases are suspended in this transaction (L-19).
  for l in select * from jsonb_array_elements(v_lots) loop
    for k in select * from jsonb_array_elements(l -> 'markets') loop
      insert into recipe.amendment_market_task (amendment_id, batch_id, lot_id, market, disposition_before)
      values (v_id, p_batch, (l ->> 'lot_id')::uuid, k ->> 'market', k ->> 'disposition');
    end loop;
    perform recipe.suspend_release((l ->> 'lot_id')::uuid, jsonb_build_object(
      'kind', 'RECORD_AMENDMENT', 'batch_id', p_batch, 'batch_number', b.batch_number, 'amendment_id', v_id, 'amendment_number', v_n,
      'basis_kind', p_basis_kind, 'basis_id', p_basis, 'signature_id', p_signature));
    perform recipe.bump_epoch('LOT', (l ->> 'lot_id')::uuid);
  end loop;
  return v_id;
end
$$;

create function recipe.append_amendment_entry(p_batch uuid, p_number integer, p_kind text, p_target text, p_text text, p_value text, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  a       recipe.record_amendment;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH') then
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-030 %s is no GMP batch record', coalesce(p_batch::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  perform 1 from recipe.batch_execution b where b.id = p_batch for update;
  select * into a from recipe.record_amendment r where r.batch_id = p_batch and r.number = p_number;
  if a.id is null or exists (select 1 from recipe.record_amendment_close c where c.amendment_id = a.id) or recipe.record_lock_state(p_batch) <> 'UNDER_AMENDMENT' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LCK-040 amendment %s of the record is not open: entries are appended to an open amendment only (INV-21)', coalesce(p_number::text, 'NULL'));
  end if;
  if p_kind is null or p_kind not in ('LATE_ENTRY', 'CORRECTION', 'NOTE') or p_target is null or btrim(p_target) = '' or length(p_target) > 200
     or p_text is null or btrim(p_text) = '' or length(p_text) > 4000 or (p_value is not null and (btrim(p_value) = '' or length(p_value) > 200))
     or p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-LCK-041 an amendment entry is a LATE_ENTRY, CORRECTION or NOTE naming what it amends, its text, its value if any and its reason (at least 10 characters)';
  end if;
  insert into recipe.record_amendment_entry (amendment_id, batch_id, seq, kind, target, body, value, reason, person_id, account_id)
  values (a.id, p_batch, (select count(*) + 1 from recipe.record_amendment_entry e where e.amendment_id = a.id), p_kind, btrim(p_target), btrim(p_text),
          nullif(btrim(p_value), ''), btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  perform recipe.bump_epoch('BATCH', p_batch);
  return v_id;
end
$$;

create function recipe.close_record_amendment(p_batch uuid, p_number integer, p_statement text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, iam, plant, pg_temp as $$
declare
  v_actor   jsonb;
  a         recipe.record_amendment;
  v_aid     text;
  v_sig     jsonb;
  v_content jsonb;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH') then
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-030 %s is no GMP batch record', coalesce(p_batch::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('RECORD.QA_REVIEW', plant.batch_scope(p_batch));
  perform 1 from recipe.batch_execution b where b.id = p_batch for update;
  select * into a from recipe.record_amendment r where r.batch_id = p_batch and r.number = p_number;
  if a.id is null or exists (select 1 from recipe.record_amendment_close c where c.amendment_id = a.id) or recipe.record_lock_state(p_batch) <> 'UNDER_AMENDMENT' then
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-040 amendment %s of the record is not open (INV-21)', coalesce(p_number::text, 'NULL'));
  end if;
  if p_statement is null or length(btrim(p_statement)) < 10 then
    raise exception using errcode = 'P0001', message = 'EBMR-LCK-042 an amendment is closed with a statement of what it found and appended (at least 10 characters)';
  end if;
  if exists (select 1 from recipe.record_amendment_entry e where e.amendment_id = a.id and e.person_id = (v_actor ->> 'person_id')::uuid) then
    raise exception using errcode = 'P0001', message = 'EBMR-LCK-043 a person who appended an entry to the amendment does not close it (outline 7.2 S10)';
  end if;
  v_aid := format('%s/%s/CLOSE', p_batch, a.number);
  v_sig := recipe.assert_release_signature(p_signature, 'AMENDMENT_CLOSED', 'record_lock', v_aid, (v_actor ->> 'person_id')::uuid);
  v_content := esig.provide('record_lock', v_aid);
  if esig.content_hash_of('record_lock', v_aid, v_content) is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-LCK-044 the signed amendment is not the current one (an entry was appended since); sign it again (DI-37)';
  end if;
  insert into recipe.record_amendment_close (amendment_id, batch_id, statement, content, signature_id, person_id, account_id)
  values (a.id, p_batch, btrim(p_statement), v_content -> 'content', p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  perform recipe.record_lock_append(p_batch, 'AMENDMENT_CLOSED', null, null, a.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return a.id;
end
$$;

revoke all on function recipe.record_lock_ref(uuid), recipe.record_released_lots(uuid), recipe.record_lock_content(text), recipe.record_lock_next_id(uuid, text, text, uuid),
  recipe.open_record_amendment(uuid, text, uuid, text, text, uuid), recipe.append_amendment_entry(uuid, integer, text, text, text, text, text),
  recipe.close_record_amendment(uuid, integer, text, uuid) from public;
grant execute on function recipe.record_released_lots(uuid), recipe.record_lock_next_id(uuid, text, text, uuid), recipe.open_record_amendment(uuid, text, uuid, text, text, uuid),
  recipe.append_amendment_entry(uuid, integer, text, text, text, text, text), recipe.close_record_amendment(uuid, integer, text, uuid) to ebmr_app;

reset role;
