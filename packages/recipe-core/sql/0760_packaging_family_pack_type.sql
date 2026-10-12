-- Recipe core, Phase 4 slice 2c (default D-P4-13; controls PR-01, INV-17): a packaging family's identity is (product,
-- pack size, pack type), so two pack types of one product at the same pack size can both exist (review backlog, slice
-- 6c open item: recipe-core 0110 kept one family per product, strength, form and batch-size set).
--
-- recipe.mbr_family is insert-only and audited (0110), so the pack type is not a new column filled in place: it lives in
-- its own insert-only, audited table, written in the same command as the family.
--
--   * recipe.mbr_family_pack: one row per PACKAGING family: its pack type (an upper-case code, e.g. ALU-PVC-BLISTER or
--     HDPE-BOTTLE) and a copy of the family's identity columns, filled from the family by the guard (never the caller's),
--     with the unique index mbr_family_pack_identity over (edition, product, strength, form, batch sizes, pack type).
--   * mbr_family_identity (0110) is re-created for processing and reprocessing families only; packaging families are
--     unique through mbr_family_pack_identity instead.
--   * a2_pack_type (constraint trigger, deferred to commit) on recipe.mbr_family: a PACKAGING family has its pack row by
--     the end of the transaction that defines it; no other family has one (the pack guard).
--   * recipe.define_family (0150) replaced: a PACKAGING definition names packType (default STANDARD when it names none,
--     D-2c-1); a processing or reprocessing definition names none.
--   * recipe.family_pack_type(family): the pack type of a family (NULL for a processing family).
--   * recipe.content_family_problem (0110) replaced: a PACKAGING master's header names the family's pack type (packType;
--     a header without one reads STANDARD); a processing master's header names none.
--   * Existing PACKAGING families take the pack type of their approved packaging master (the header's packType of the
--     highest approved version, else of the latest version; STANDARD when the header names none), as D-P4-13 says.
--
-- Messages: EBMR-PLN-001 to EBMR-PLN-003.

set local role ebmr_owner;

create table recipe.mbr_family_pack (
  family_id           uuid primary key references recipe.mbr_family (id),
  edition             text not null,
  record_kind         text not null check (record_kind = 'PACKAGING'),
  product_code        text not null,
  strength            text not null,
  dosage_form         text not null,
  batch_sizes         jsonb not null,
  pack_type           text not null check (pack_type ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  source              text not null check (source in ('DEFINED', 'FROM_APPROVED_MASTER', 'FROM_LATEST_MASTER', 'NO_MASTER')),
  created_by_person   uuid not null,
  created_by_account  uuid not null,
  recorded_at         timestamptz not null default clock_timestamp()
);
create unique index mbr_family_pack_identity on recipe.mbr_family_pack (edition, record_kind, product_code, strength, dosage_form, batch_sizes, pack_type);
revoke all on recipe.mbr_family_pack from public;

-- D-P4-13 (header): existing PACKAGING families, before the guards below are attached (no command runs a migration).
insert into recipe.mbr_family_pack (family_id, edition, record_kind, product_code, strength, dosage_form, batch_sizes, pack_type, source,
                                    created_by_person, created_by_account)
select f.id, f.edition, f.record_kind, f.product_code, f.strength, f.dosage_form, f.batch_sizes,
       coalesce(case when coalesce(m.pack, '') ~ '^[A-Z0-9][A-Z0-9-]{0,31}$' then m.pack end, 'STANDARD'),
       case when m.approved then 'FROM_APPROVED_MASTER' when m.version_id is not null then 'FROM_LATEST_MASTER' else 'NO_MASTER' end,
       '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'
  from recipe.mbr_family f
  left join lateral (
    select v.id as version_id, recipe.version_was_approved(v.id) as approved, (recipe.current_content(v.id)).content -> 'header' ->> 'packType' as pack
      from recipe.mbr_version v
     where v.family_id = f.id
     order by recipe.version_was_approved(v.id) desc, v.version_number desc
     limit 1) m on true
 where f.record_kind = 'PACKAGING';

drop index recipe.mbr_family_identity;
-- One family per product, strength, batch-size set, dosage form, edition and record kind for processing records (0110);
-- a packaging family adds its pack type (recipe.mbr_family_pack).
create unique index mbr_family_identity on recipe.mbr_family (edition, record_kind, product_code, strength, dosage_form, batch_sizes)
  where record_kind <> 'PACKAGING';

-- The pack row: identity copied from its family (never the caller's), attributed, for PACKAGING families only.
create function recipe.mbr_family_pack_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
  f     recipe.mbr_family;
begin
  select * into f from recipe.mbr_family where id = new.family_id;
  if f.id is null or f.record_kind is distinct from 'PACKAGING' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLN-001 family %s is no packaging family: only a packaging family has a pack type (D-P4-13)', coalesce(f.code, new.family_id::text));
  end if;
  new.edition := f.edition;
  new.record_kind := f.record_kind;
  new.product_code := f.product_code;
  new.strength := f.strength;
  new.dosage_form := f.dosage_form;
  new.batch_sizes := f.batch_sizes;
  new.source := 'DEFINED';
  new.created_by_person := (v_ctx ->> 'person_id')::uuid;
  new.created_by_account := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.mbr_family_pack for each row execute function recipe.mbr_family_pack_guard();

select platform.enforce_db_time('recipe.mbr_family_pack', array['recorded_at']);
select kernel.register_audited_table('recipe.mbr_family_pack', 'mbr_family', 'family_id', true);

-- A PACKAGING family has its pack row by commit (D-P4-13).
create function recipe.mbr_family_pack_required() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if new.record_kind = 'PACKAGING' and not exists (select 1 from recipe.mbr_family_pack p where p.family_id = new.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLN-002 packaging family %s has no pack type: a packaging family is defined with its pack type, part of its identity with the product and the pack size (D-P4-13, PR-01)', new.code);
  end if;
  return null;
end
$$;
create constraint trigger a2_pack_type after insert on recipe.mbr_family deferrable initially deferred
  for each row execute function recipe.mbr_family_pack_required();

create function recipe.family_pack_type(p_family uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select p.pack_type from recipe.mbr_family_pack p where p.family_id = p_family
$$;

-- As 0150, with the pack type of a packaging family (header).
-- p_def: {code, title, edition, recordKind, product: {code, name, strength, dosageForm}, batchSizes: [...], packType?}
create or replace function recipe.define_family(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_id   uuid;
  v_pack text := nullif(btrim(coalesce(p_def ->> 'packType', '')), '');
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.AUTHOR', jsonb_build_object('product', p_def -> 'product' ->> 'code'));
  if p_def ->> 'recordKind' is distinct from 'PACKAGING' and v_pack is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLN-003 a %s family names no pack type; only a packaging family does (D-P4-13)', coalesce(p_def ->> 'recordKind', 'family without a record kind'));
  end if;
  if p_def ->> 'recordKind' = 'PACKAGING' and coalesce(v_pack, 'STANDARD') !~ '^[A-Z0-9][A-Z0-9-]{0,31}$' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLN-003 pack type %s is not an upper-case code of letters, digits and hyphens (D-P4-13)', v_pack);
  end if;
  insert into recipe.mbr_family (code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                 created_by_person, created_by_account)
  values (p_def ->> 'code', p_def ->> 'title', p_def ->> 'edition', p_def ->> 'recordKind', p_def -> 'product' ->> 'code',
          p_def -> 'product' ->> 'name', p_def -> 'product' ->> 'strength', p_def -> 'product' ->> 'dosageForm',
          coalesce(p_def -> 'batchSizes', '[]'::jsonb), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  if p_def ->> 'recordKind' = 'PACKAGING' then
    insert into recipe.mbr_family_pack (family_id, edition, record_kind, product_code, strength, dosage_form, batch_sizes, pack_type, source,
                                        created_by_person, created_by_account)
    values (v_id, '', 'PACKAGING', '', '', '', '[]'::jsonb, coalesce(v_pack, 'STANDARD'), 'DEFINED',
            '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');
  end if;
  return v_id;
end
$$;

-- As 0110, with the pack type of a packaging master (header).
create or replace function recipe.content_family_problem(p_content jsonb, p_family recipe.mbr_family) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  h jsonb := p_content -> 'header';
  v_sizes jsonb;
  v_markets text[];
  v_pack text;
begin
  if p_content ->> 'format' is distinct from 'ebmr.mbr-content' or p_content ->> 'formatVersion' is distinct from '1' then
    return 'the content is not ebmr.mbr-content format version 1';
  end if;
  if jsonb_typeof(h) is distinct from 'object' then
    return 'the content has no header';
  end if;
  if h ->> 'family' is distinct from p_family.code then
    return format('the header names family %s, not %s', h ->> 'family', p_family.code);
  end if;
  if h ->> 'edition' is distinct from p_family.edition or h ->> 'recordKind' is distinct from p_family.record_kind then
    return format('the header edition and record kind (%s, %s) differ from the family (%s, %s)', h ->> 'edition', h ->> 'recordKind',
                  p_family.edition, p_family.record_kind);
  end if;
  if h -> 'product' ->> 'code' is distinct from p_family.product_code or h -> 'product' ->> 'strength' is distinct from p_family.strength
     or h -> 'product' ->> 'dosageForm' is distinct from p_family.dosage_form then
    return format('the header product (%s, %s, %s) differs from the family (%s, %s, %s)', h -> 'product' ->> 'code',
                  h -> 'product' ->> 'strength', h -> 'product' ->> 'dosageForm', p_family.product_code, p_family.strength, p_family.dosage_form);
  end if;
  -- D-P4-13: a packaging master names its family's pack type (a header without one reads STANDARD); no other master does.
  if p_family.record_kind = 'PACKAGING' then
    v_pack := (select p.pack_type from recipe.mbr_family_pack p where p.family_id = p_family.id);
    if coalesce(h ->> 'packType', 'STANDARD') is distinct from v_pack then
      return format('the header pack type %s differs from the family''s pack type %s (D-P4-13)', coalesce(h ->> 'packType', 'STANDARD'), coalesce(v_pack, '(none)'));
    end if;
  elsif h ? 'packType' then
    return 'only a packaging master names a pack type (D-P4-13)';
  end if;
  begin
    v_sizes := recipe.canonical_batch_sizes(h -> 'batchSizes');
  exception when others then
    return 'the header batch sizes are not valid';
  end;
  if v_sizes is distinct from p_family.batch_sizes then
    return 'the header batch sizes differ from the family''s approved batch-size set (PR-01)';
  end if;
  if jsonb_typeof(h -> 'marketSet') is distinct from 'array' then
    return 'the header has no market set';
  end if;
  v_markets := array(select jsonb_array_elements_text(h -> 'marketSet'));
  if cardinality(v_markets) = 0 or exists (select 1 from unnest(v_markets) m where m !~ '^[A-Z]{2}$')
     or cardinality(v_markets) <> (select count(distinct m) from unnest(v_markets) m) then
    return 'the market set must list distinct two-letter market codes';
  end if;
  if not ('IN' = any (v_markets)) then
    return 'India (IN) must be in every market set (INV-28)';
  end if;
  return null;
end
$$;

grant select on recipe.mbr_family_pack to ebmr_app;
revoke all on function recipe.mbr_family_pack_guard(), recipe.mbr_family_pack_required() from public;
revoke all on function recipe.family_pack_type(uuid) from public;
grant execute on function recipe.family_pack_type(uuid) to ebmr_app;

reset role;
