-- Tablets server, Phase 3 slice 4a (builder B; G-21, tablets spec K-19): the artwork version a printed packaging lot
-- carries, and the lot an ISSUE of a printed-materials step names, as the register holds it at the moment of issue
-- (controls PR-32, PR-33, DI-05; ADR 0012: the rules hold when the application's own database credentials are used
-- directly).
--
--   tab.printed_lot_artwork  insert-only, audited: the artwork version one printed packaging lot was received and
--                            checked with, once per lot. A lot of this installation's register only: a material lot of
--                            kind PRINTED_PACKAGING of the site register on GMP (site.material_lot), a TEST- lot in the
--                            sandbox (tab.sandbox_lot), never both (as tab.lot_assay_result, 0841).
--   tab.record_lot_artwork   the one writer: on GMP a QC.RESULT_RECORD holder at the lot's site (the artwork check at
--                            receipt is the quality unit's), in the sandbox a MASTERDATA.CHANGE holder (test data).
--                            Never an administrator.
--   tab.printed_lot_facts    the lot as an issue takes it: {id, material, status, artwork, expiresAtUs?} from
--                            tab.lot_facts (0801: RELEASED only while the lot's state is a usable one) and the lot's
--                            artwork; NULL when the register holds no such lot, the lot is no printed packaging lot or
--                            carries no recorded artwork.
--   trigger ad_tab_g21_issue_lot on recipe.execution_command (before insert; accepted and refused rows alike): an ISSUE
--                            entry at a G-21 step names its lot exactly as tab.printed_lot_facts gives it for the batch
--                            now, so the block's rules (released, unexpired, the item's material, the artwork scanned
--                            at the line and the master's for every market; recipe-core 0580) are judged on the
--                            register's facts, never on what a client sends (EBMR-EXE-295).
--
-- Privileges: the application role SELECTs the table and EXECUTEs the writer and the reader.

set local role ebmr_owner;

create table tab.printed_lot_artwork (
  id                  uuid primary key default gen_random_uuid(),
  material_lot_id     uuid unique references site.material_lot (id),
  sandbox_lot_code    text unique references tab.sandbox_lot (lot_code),
  artwork_version     text not null check (artwork_version ~ '^[!-~]{1,64}$'),
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  check (num_nonnulls(material_lot_id, sandbox_lot_code) = 1)
);
revoke all on tab.printed_lot_artwork from public;
create trigger aa_printed_lot_artwork_insert_only before update or delete on tab.printed_lot_artwork for each row execute function kernel.reject_mutation();
create trigger aa_printed_lot_artwork_no_truncate before truncate on tab.printed_lot_artwork for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.printed_lot_artwork', array['recorded_at']);
select kernel.register_audited_table('tab.printed_lot_artwork', 'printed_lot_artwork', 'id', true);

-- PR-32 (header): records the artwork version p_artwork of printed packaging lot p_lot_code (at site p_site on GMP; null
-- in the sandbox). Returns the record's id.
create function tab.record_lot_artwork(p_lot_code text, p_site text, p_artwork text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, site, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  v_lot   site.material_lot;
  v_code  text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  if kernel.installation_kind() = 'SANDBOX' then
    v_actor := iam.require_permission('MASTERDATA.CHANGE', iam.actor_location_scope());
    select l.lot_code into v_code from tab.sandbox_lot l where l.lot_code = p_lot_code;
    if v_code is null then
      raise exception using errcode = 'P0001', message = format('Lot %s is not a registered test lot (PR-32). [EBMR-EXE-295]', left(coalesce(p_lot_code, '(none)'), 64));
    end if;
  else
    select * into v_lot from site.material_lot l where l.site_code = p_site and l.lot_code = p_lot_code;
    if v_lot.id is null then
      raise exception using errcode = 'P0001', message = format('Lot %s is not a material lot of site %s (PR-32). [EBMR-EXE-295]', left(coalesce(p_lot_code, '(none)'), 64), left(coalesce(p_site, '(none)'), 16));
    end if;
    v_actor := iam.require_permission('QC.RESULT_RECORD', jsonb_build_object('site', p_site));
    if v_lot.material_kind <> 'PRINTED_PACKAGING' then
      raise exception using errcode = 'P0001', message = format('Lot %s is %s, not printed packaging: only a printed packaging lot carries an artwork version (PR-32). [EBMR-EXE-295]', v_lot.lot_code, v_lot.material_kind);
    end if;
  end if;
  if coalesce(p_artwork, '') !~ '^[!-~]{1,64}$' then
    raise exception using errcode = 'P0001', message = 'An artwork version is printable text of 1 to 64 characters without spaces (PR-32). [EBMR-EXE-295]';
  end if;
  if exists (select 1 from tab.printed_lot_artwork a where a.material_lot_id = v_lot.id or a.sandbox_lot_code = v_code) then
    raise exception using errcode = 'P0001', message = format('Lot %s carries a recorded artwork version already; it never changes (PR-32, DI-22). [EBMR-EXE-295]', coalesce(v_code, v_lot.lot_code));
  end if;
  insert into tab.printed_lot_artwork (material_lot_id, sandbox_lot_code, artwork_version, recorded_by_person, recorded_by_account, correlation_id)
  values (v_lot.id, v_code, p_artwork, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- PR-32, PR-33 (header): printed packaging lot p_code as batch p_batch issues it now, or NULL.
create function tab.printed_lot_facts(p_code text, p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, site, recipe, kernel, pg_temp as $$
declare
  v_facts jsonb := tab.lot_facts(p_code, p_batch);
  v_site  text;
  v_art   text;
begin
  if v_facts is null then
    return null;
  end if;
  if kernel.installation_kind() = 'SANDBOX' then
    select a.artwork_version into v_art from tab.printed_lot_artwork a where a.sandbox_lot_code = p_code;
  else
    select b.site into v_site from recipe.stub_batch b where b.id = p_batch;
    select a.artwork_version into v_art
      from tab.printed_lot_artwork a join site.material_lot l on l.id = a.material_lot_id
     where l.lot_code = p_code and l.material_kind = 'PRINTED_PACKAGING' and (v_site is null or l.site_code = v_site);
  end if;
  if v_art is null then
    return null;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('id', v_facts -> 'lotCode', 'material', v_facts -> 'materialCode', 'status', v_facts -> 'status',
                                              'artwork', v_art, 'expiresAtUs', v_facts -> 'expiresAtUs'));
end
$$;

-- The G-21 phase of batch p_batch that command p_command acts on, or NULL.
create function tab.g21_command_node(p_batch uuid, p_command jsonb) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select n from (select recipe.step_node(recipe.batch_mbr_content(p_batch), p_command ->> 'step') n) x where n -> 'block' ->> 'type' = 'G-21'
$$;

create function tab.g21_issue_lot_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_entry jsonb;
  v_facts jsonb;
begin
  if new.kind <> 'COMMAND' or new.command_type is distinct from 'RECORD_ENTRY' or new.command -> 'entry' ->> 'kind' is distinct from 'ISSUE'
     or tab.g21_command_node(new.batch_id, new.command) is null then
    return new;
  end if;
  v_entry := new.command -> 'entry';
  v_facts := tab.printed_lot_facts(v_entry -> 'lot' ->> 'id', new.batch_id);
  if v_facts is null or (v_entry -> 'lot') is distinct from v_facts then
    raise exception using errcode = 'P0001',
      message = format('The ISSUE entry of this RECORD_ENTRY row is refused: lot %s %s; printed material is issued from the register''s printed packaging lots as they stand now, with the artwork they carry (PR-32, PR-33, DI-05). [EBMR-EXE-295]',
                       left(coalesce(v_entry -> 'lot' ->> 'id', '(none)'), 64),
                       case when v_facts is null then 'is no printed packaging lot of this installation with a recorded artwork version'
                            else format('states other facts than the register holds (%s)', v_facts::text) end);
  end if;
  return new;
end
$$;

create trigger ad_tab_g21_issue_lot before insert on recipe.execution_command for each row execute function tab.g21_issue_lot_check();

revoke all on function tab.record_lot_artwork(text, text, text), tab.printed_lot_facts(text, uuid), tab.g21_command_node(uuid, jsonb), tab.g21_issue_lot_check() from public;
grant execute on function tab.record_lot_artwork(text, text, text), tab.printed_lot_facts(text, uuid) to ebmr_app;
grant select on tab.printed_lot_artwork to ebmr_app;

reset role;
