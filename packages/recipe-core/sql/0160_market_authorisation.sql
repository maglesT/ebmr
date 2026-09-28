-- Recipe core, MBR life cycle (A3), part 6: per-market authorisation (ADR 0014; outline 5.2.1;
-- PR-04, PR-05; INV-17).
--
-- An APPROVED version becomes usable for a market and scope (site, line, batch size) only through a
-- signed market-authorisation record:
--   1. propose_market_authorisation   the record: version, market, kind, the scope cells, effective
--                                     date, the market's approvals or notifications (regulatory
--                                     basis) and, for BRIDGING, the successor and the end of validity;
--                                     insert-only; state PROPOSED.
--   2. two signatures on the record   MBR_MARKET_AUTHORISED by QA and REGULATORY_CONFIRMED by a
--                                     regulatory-conformity signer, two different persons (esig).
--   3. activate_market_authorisation  by the QA signer: one authorisation cell per scope cell; for
--                                     CURRENT, the predecessor's CURRENT cell of the same family,
--                                     market and scope becomes SUPERSEDED in the same transaction,
--                                     valid until the successor takes effect. A successor covering
--                                     only part of the scope leaves the predecessor CURRENT elsewhere.
--   BRIDGING                          a signed, time-limited validity for a version that its named
--                                     successor superseded in that market and scope; it is usable
--                                     only by batches whose market set includes a market where the
--                                     successor is not CURRENT (selection, 0170).
--   withdraw_market_authorisation     ends the record's open cells (WITHDRAWN) with a reason.
--   retire_version                    CURRENT -> RETIRED by QA: ends every open cell of the version
--                                     and retires it; no new batch can use it (PR-05).
--
-- INV-17 in the database: a unique partial index allows one open CURRENT cell per family, market and
-- scope; an exclusion constraint forbids two CURRENT validity intervals of one family, market and
-- scope from overlapping at any instant (and likewise two BRIDGING intervals); a BRIDGING cell always
-- has an end; a cell can be created only for an activated record whose two signatures are valid.
-- Validity is computed, never cached (outline 5.2): a cell is valid at t when effective_from <= t <
-- coalesce(valid_until, infinity), and its version was APPROVED at t.

set local role ebmr_owner;

create table recipe.market_authorisation (
  id                    uuid primary key default gen_random_uuid(),
  family_id             uuid not null references recipe.mbr_family (id),
  version_id            uuid not null references recipe.mbr_version (id),
  market                text not null check (market ~ '^[A-Z]{2}$'),
  kind                  text not null check (kind in ('CURRENT', 'BRIDGING')),
  -- [{site, line, batch_size}] ordered by site, line, batch size.
  cells                 jsonb not null check (jsonb_typeof(cells) = 'array' and jsonb_array_length(cells) >= 1),
  effective_from        timestamptz,
  effective_to          timestamptz,
  successor_version_id  uuid references recipe.mbr_version (id),
  regulatory_basis      text not null check (btrim(regulatory_basis) <> ''),
  proposed_by_person    uuid not null,
  proposed_by_account   uuid not null,
  recorded_at           timestamptz not null default clock_timestamp(),
  check ((kind = 'BRIDGING') = (effective_to is not null)),
  check ((kind = 'BRIDGING') = (successor_version_id is not null)),
  check (effective_to is null or effective_from is null or effective_to > effective_from)
);
create index market_authorisation_version on recipe.market_authorisation (version_id);

create table recipe.market_authorisation_activation (
  authorisation_id         uuid primary key references recipe.market_authorisation (id),
  qa_signature_id          uuid not null unique,
  regulatory_signature_id  uuid not null unique,
  effective_from           timestamptz not null,
  person_id                uuid not null,
  account_id               uuid not null,
  recorded_at              timestamptz not null default clock_timestamp(),
  check (qa_signature_id <> regulatory_signature_id)
);

create table recipe.market_authorisation_withdrawal (
  authorisation_id  uuid primary key references recipe.market_authorisation (id),
  reason            text not null check (btrim(reason) <> ''),
  person_id         uuid not null,
  account_id        uuid not null,
  recorded_at       timestamptz not null default clock_timestamp()
);

create table recipe.authorisation_cell (
  id                    uuid primary key default gen_random_uuid(),
  authorisation_id      uuid not null references recipe.market_authorisation (id),
  family_id             uuid not null references recipe.mbr_family (id),
  version_id            uuid not null references recipe.mbr_version (id),
  version_number        integer not null,
  market                text not null,
  site                  text not null check (btrim(site) <> ''),
  line                  text not null check (btrim(line) <> ''),
  batch_size            text not null check (btrim(batch_size) <> ''),
  kind                  text not null check (kind in ('CURRENT', 'BRIDGING')),
  status                text not null check (status in ('CURRENT', 'BRIDGING', 'SUPERSEDED', 'WITHDRAWN')),
  effective_from        timestamptz not null,
  valid_until           timestamptz,
  successor_version_id  uuid references recipe.mbr_version (id),
  superseded_by         uuid references recipe.authorisation_cell (id) deferrable initially deferred,
  recorded_at           timestamptz not null default clock_timestamp(),
  check ((kind = 'CURRENT' and status in ('CURRENT', 'SUPERSEDED', 'WITHDRAWN')) or (kind = 'BRIDGING' and status in ('BRIDGING', 'WITHDRAWN'))),
  check (kind <> 'CURRENT' or (status = 'CURRENT') = (valid_until is null)),
  check (kind <> 'BRIDGING' or (valid_until is not null and successor_version_id is not null)),
  check (kind <> 'CURRENT' or successor_version_id is null),
  check (valid_until is null or valid_until >= effective_from),
  check ((status = 'SUPERSEDED') = (superseded_by is not null))
);
-- INV-17: at most one open CURRENT cell per family, market and scope ...
create unique index authorisation_cell_one_current on recipe.authorisation_cell (family_id, market, site, line, batch_size)
  where status = 'CURRENT';
-- ... and no two CURRENT (or two BRIDGING) validity intervals of one family, market and scope overlap.
alter table recipe.authorisation_cell add constraint authorisation_cell_current_no_overlap
  exclude using gist (family_id with =, market with =, site with =, line with =, batch_size with =,
                      tstzrange(effective_from, valid_until, '[)') with &&) where (kind = 'CURRENT');
alter table recipe.authorisation_cell add constraint authorisation_cell_bridging_no_overlap
  exclude using gist (family_id with =, market with =, site with =, line with =, batch_size with =,
                      tstzrange(effective_from, valid_until, '[)') with &&) where (kind = 'BRIDGING');
create index authorisation_cell_lookup on recipe.authorisation_cell (family_id, site, line, batch_size, market);
create index authorisation_cell_version on recipe.authorisation_cell (version_id);

-- ---------------------------------------------------------------------------------------------
-- Reading helpers and the signing content of a record
-- ---------------------------------------------------------------------------------------------

create function recipe.market_authorisation_state(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case when exists (select 1 from recipe.market_authorisation_withdrawal w where w.authorisation_id = p_id) then 'WITHDRAWN'
              when exists (select 1 from recipe.market_authorisation_activation a where a.authorisation_id = p_id) then 'ACTIVE'
              when exists (select 1 from recipe.market_authorisation m where m.id = p_id) then 'PROPOSED' end
$$;

-- What QA and the regulatory signer sign: the version (with its content hash), the market, the kind,
-- the scope cells, the effective window, the successor of a BRIDGING and the market's approvals or
-- notifications. The record is insert-only, so the signed content never changes.
create function recipe.market_authorisation_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  a recipe.market_authorisation;
  v recipe.mbr_version;
  f recipe.mbr_family;
begin
  if coalesce(p_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into a from recipe.market_authorisation where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  select * into v from recipe.mbr_version where id = a.version_id;
  select * into f from recipe.mbr_family where id = a.family_id;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object(
      'family', f.code, 'product_code', f.product_code, 'version_id', v.id, 'version_number', v.version_number::text,
      'content_hash', recipe.content_hash_of(v.id), 'version_effective_from', recipe.utc_text(v.effective_from),
      'market', a.market, 'kind', a.kind, 'cells', a.cells,
      'effective_from', recipe.utc_text(a.effective_from), 'effective_to', recipe.utc_text(a.effective_to),
      'successor', (select jsonb_build_object('version_id', s.id, 'version_number', s.version_number::text)
                    from recipe.mbr_version s where s.id = a.successor_version_id),
      'regulatory_basis', a.regulatory_basis, 'proposed_by', a.proposed_by_person),
    'state', recipe.market_authorisation_state(a.id),
    'scope', jsonb_build_object('product', f.product_code),
    'market', a.market);
end
$$;

select esig.register_content_provider('mbr_market_authorisation', 'recipe.market_authorisation_content(text)',
  'Market authorisation of an approved MBR version: market, kind, scope cells, effective window, regulatory basis');
select esig.register_signed_table('recipe.market_authorisation', 'mbr_market_authorisation', 'id');

-- Scope cells in canonical form: distinct {site, line, batch_size} with a batch size of the family.
create function recipe.canonical_cells(p_cells jsonb, p_family recipe.mbr_family) returns jsonb
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  x jsonb;
begin
  if p_cells is null or jsonb_typeof(p_cells) <> 'array' or jsonb_array_length(p_cells) = 0 then
    raise exception using errcode = 'P0001', message = 'An authorisation names at least one scope cell {site, line, batch_size} (ADR 0014; EBMR-RCP-080)';
  end if;
  for x in select * from jsonb_array_elements(p_cells) loop
    if jsonb_typeof(x) <> 'object' or coalesce(btrim(x ->> 'site'), '') = '' or coalesce(btrim(x ->> 'line'), '') = ''
       or coalesce(btrim(x ->> 'batch_size'), '') = '' or (select count(*) from jsonb_object_keys(x)) <> 3 then
      raise exception using errcode = 'P0001', message = format('Scope cell %s is not {site, line, batch_size} (ADR 0014; EBMR-RCP-080)', x);
    end if;
    if not exists (select 1 from jsonb_array_elements(p_family.batch_sizes) b where b ->> 'id' = x ->> 'batch_size') then
      raise exception using errcode = 'P0001',
        message = format('Batch size %s is not an approved batch size of family %s (PR-01; EBMR-RCP-080)', x ->> 'batch_size', p_family.code);
    end if;
  end loop;
  if (select count(distinct (e ->> 'site', e ->> 'line', e ->> 'batch_size')) from jsonb_array_elements(p_cells) e) <> jsonb_array_length(p_cells) then
    raise exception using errcode = 'P0001', message = 'Scope cells must be distinct (EBMR-RCP-080)';
  end if;
  return (select jsonb_agg(jsonb_build_object('site', e ->> 'site', 'line', e ->> 'line', 'batch_size', e ->> 'batch_size')
                           order by e ->> 'site' collate "C", e ->> 'line' collate "C", e ->> 'batch_size' collate "C")
          from jsonb_array_elements(p_cells) e);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards on the tables (every writer, including owner-level code)
-- ---------------------------------------------------------------------------------------------

create function recipe.market_authorisation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  new.proposed_by_person := (v_ctx ->> 'person_id')::uuid;
  new.proposed_by_account := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.market_authorisation for each row execute function recipe.market_authorisation_guard();

create function recipe.stamp_person() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_stamp before insert on recipe.market_authorisation_activation for each row execute function recipe.stamp_person();
create trigger a1_stamp before insert on recipe.market_authorisation_withdrawal for each row execute function recipe.stamp_person();

-- A cell exists only for an activated record whose QA and regulatory signatures are valid, and
-- repeats the record exactly (INV-17: CURRENT and BRIDGING only through a signed record).
create function recipe.authorisation_cell_insert_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  a    recipe.market_authorisation;
  act  recipe.market_authorisation_activation;
begin
  perform recipe.require_actor();
  select * into a from recipe.market_authorisation where id = new.authorisation_id;
  select * into act from recipe.market_authorisation_activation where authorisation_id = new.authorisation_id;
  if act.authorisation_id is null
     or esig.signature_problem(act.qa_signature_id, 'MBR_MARKET_AUTHORISED', 'mbr_market_authorisation', a.id::text) is not null
     or esig.signature_problem(act.regulatory_signature_id, 'REGULATORY_CONFIRMED', 'mbr_market_authorisation', a.id::text) is not null then
    raise exception using errcode = 'P0001',
      message = 'A version becomes CURRENT or BRIDGING for a market only through an activated authorisation record with valid QA and regulatory signatures (INV-17; EBMR-RCP-092)';
  end if;
  if new.family_id <> a.family_id or new.version_id <> a.version_id or new.market <> a.market or new.kind <> a.kind
     or new.successor_version_id is distinct from a.successor_version_id
     or not (a.cells @> jsonb_build_array(jsonb_build_object('site', new.site, 'line', new.line, 'batch_size', new.batch_size)))
     or new.status <> new.kind or new.effective_from <> act.effective_from
     or (new.kind = 'CURRENT' and new.valid_until is not null) or (new.kind = 'BRIDGING' and new.valid_until is distinct from a.effective_to)
     or new.superseded_by is not null then
    raise exception using errcode = 'P0001', message = 'An authorisation cell repeats its signed record exactly (INV-17; EBMR-RCP-092)';
  end if;
  new.version_number := (select v.version_number from recipe.mbr_version v where v.id = new.version_id);
  return new;
end
$$;
create trigger a1_guard before insert on recipe.authorisation_cell for each row execute function recipe.authorisation_cell_insert_guard();

-- A cell changes only by ending: CURRENT -> SUPERSEDED (by a successor) or WITHDRAWN, BRIDGING ->
-- WITHDRAWN; the end of validity is set once and a bridging end only moves earlier.
create function recipe.authorisation_cell_update_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'Authorisation cells are never deleted (INV-17; EBMR-RCP-091)';
  end if;
  if new.id <> old.id or new.authorisation_id <> old.authorisation_id or new.family_id <> old.family_id or new.version_id <> old.version_id
     or new.version_number <> old.version_number or new.market <> old.market or new.site <> old.site or new.line <> old.line
     or new.batch_size <> old.batch_size or new.kind <> old.kind or new.effective_from <> old.effective_from
     or new.successor_version_id is distinct from old.successor_version_id or new.recorded_at <> old.recorded_at then
    raise exception using errcode = 'P0001', message = 'Only the status and end of an authorisation cell can change (INV-17; EBMR-RCP-091)';
  end if;
  if (old.status = 'CURRENT' and new.status = 'SUPERSEDED' and new.valid_until is not null and new.superseded_by is not null)
     or (old.status = 'CURRENT' and new.status = 'WITHDRAWN' and new.valid_until is not null and new.superseded_by is null)
     or (old.status = 'BRIDGING' and new.status = 'WITHDRAWN' and new.valid_until <= old.valid_until) then
    return new;
  end if;
  raise exception using errcode = 'P0001',
    message = format('An authorisation cell cannot go from %s to %s: CURRENT ends as SUPERSEDED or WITHDRAWN, BRIDGING as WITHDRAWN (INV-17; EBMR-RCP-091)',
                     old.status, new.status);
end
$$;
create trigger a1_guard_update before update or delete on recipe.authorisation_cell for each row execute function recipe.authorisation_cell_update_guard();
create trigger aa_no_truncate before truncate on recipe.authorisation_cell for each statement execute function kernel.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- p_def: {versionId, market, kind: CURRENT|BRIDGING, cells: [{site, line, batch_size}], effectiveFrom?,
--         effectiveTo? (BRIDGING), successorVersionId? (BRIDGING), regulatoryBasis}
create function recipe.propose_market_authorisation(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v        recipe.mbr_version;
  f        recipe.mbr_family;
  s        recipe.mbr_version;
  v_market text := p_def ->> 'market';
  v_kind   text := p_def ->> 'kind';
  v_from   timestamptz := (p_def ->> 'effectiveFrom')::timestamptz;
  v_to     timestamptz := (p_def ->> 'effectiveTo')::timestamptz;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  select * into v from recipe.mbr_version where id = (p_def ->> 'versionId')::uuid;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_def ->> 'versionId');
  end if;
  perform iam.require_permission('MBR.APPROVE', recipe.version_scope(v.id));
  select * into f from recipe.mbr_family where id = v.family_id;
  if recipe.version_state(v.id) is distinct from 'APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('Version %s is %s: only an APPROVED version can be authorised for a market (ADR 0014; EBMR-RCP-086)', v.version_number, recipe.version_state(v.id));
  end if;
  if v_market is null or not ((recipe.current_content(v.id)).content -> 'header' -> 'marketSet' ? v_market) then
    raise exception using errcode = 'P0001',
      message = format('The master is not linked to market %s: its market set is %s, so it cannot be authorised there (PR-04; EBMR-RCP-081)',
                       coalesce(v_market, '(none)'), (recipe.current_content(v.id)).content -> 'header' -> 'marketSet');
  end if;
  if v_kind is null or v_kind not in ('CURRENT', 'BRIDGING') then
    raise exception using errcode = 'P0001', message = 'An authorisation is CURRENT or BRIDGING (ADR 0014; EBMR-RCP-082)';
  end if;
  if v_kind = 'BRIDGING' then
    select * into s from recipe.mbr_version where id = (p_def ->> 'successorVersionId')::uuid;
    if s.id is null or s.family_id <> v.family_id or s.version_number <= v.version_number or recipe.version_state(s.id) is distinct from 'APPROVED' then
      raise exception using errcode = 'P0001',
        message = 'A BRIDGING validity names the approved successor of the same family that superseded this version (ADR 0014; EBMR-RCP-082)';
    end if;
    if v_to is null or v_to <= greatest(coalesce(v_from, clock_timestamp()), clock_timestamp()) then
      raise exception using errcode = 'P0001', message = 'A BRIDGING validity is time-limited: its end must lie after its start (INV-17; EBMR-RCP-082)';
    end if;
  elsif v_to is not null or p_def ? 'successorVersionId' and p_def ->> 'successorVersionId' is not null then
    raise exception using errcode = 'P0001', message = 'A CURRENT authorisation has no end date and no successor (ADR 0014; EBMR-RCP-082)';
  end if;
  insert into recipe.market_authorisation (family_id, version_id, market, kind, cells, effective_from, effective_to, successor_version_id,
                                           regulatory_basis, proposed_by_person, proposed_by_account)
  values (v.family_id, v.id, v_market, v_kind, recipe.canonical_cells(p_def -> 'cells', f), v_from, v_to, s.id,
          coalesce(p_def ->> 'regulatoryBasis', ''), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  return v_id;
end
$$;

-- Ends every open cell of one record: CURRENT and BRIDGING become WITHDRAWN, valid until now (or
-- until their start, when they had not started yet).
create function recipe.end_open_cells(p_where_authorisation uuid, p_where_version uuid, p_reason_code text, p_reason_text text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.push_reason(p_reason_code, p_reason_text);
  v_now timestamptz := clock_timestamp();
  v_n   integer;
begin
  update recipe.authorisation_cell c
  set status = 'WITHDRAWN',
      valid_until = case when c.kind = 'BRIDGING' then least(c.valid_until, greatest(v_now, c.effective_from)) else greatest(v_now, c.effective_from) end
  where c.status in ('CURRENT', 'BRIDGING')
    and (p_where_authorisation is null or c.authorisation_id = p_where_authorisation)
    and (p_where_version is null or c.version_id = p_where_version);
  get diagnostics v_n = row_count;
  perform recipe.restore_actor(v_ctx);
  return v_n;
end
$$;

-- Activates a proposed record with its two signatures (the QA signer runs the command). CURRENT:
-- supersedes the predecessor per scope cell; BRIDGING: only for cells where the named successor
-- superseded this version.
create function recipe.activate_market_authorisation(p_authorisation uuid, p_qa_signature uuid, p_regulatory_signature uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, esig, kernel, pg_temp as $$
declare
  a       recipe.market_authorisation;
  v       recipe.mbr_version;
  v_ctx   jsonb;
  v_now   timestamptz := clock_timestamp();
  v_from  timestamptz;
  v_qa    jsonb;
  v_reg   jsonb;
  v_ev    jsonb;
  x       jsonb;
  v_old   recipe.authorisation_cell;
  v_new   uuid;
  v_out   jsonb := '[]'::jsonb;
  v_push  jsonb;
begin
  perform iam.assert_not_administrator();
  select * into a from recipe.market_authorisation where id = p_authorisation for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown market authorisation %s (EBMR-RCP-083)', p_authorisation);
  end if;
  v_ctx := iam.require_permission('MBR.APPROVE', recipe.version_scope(a.version_id));
  -- One activation at a time per family (INV-17).
  perform 1 from recipe.mbr_family where id = a.family_id for update;
  if recipe.market_authorisation_state(a.id) <> 'PROPOSED' then
    raise exception using errcode = 'P0001',
      message = format('This authorisation is %s; only a PROPOSED record is activated (EBMR-RCP-083)', recipe.market_authorisation_state(a.id));
  end if;
  -- DI-37: both signatures valid for this record; QA is the person activating; two different persons.
  v_qa := esig.assert_signature(p_qa_signature, 'MBR_MARKET_AUTHORISED', 'mbr_market_authorisation', a.id::text);
  v_reg := esig.assert_signature(p_regulatory_signature, 'REGULATORY_CONFIRMED', 'mbr_market_authorisation', a.id::text);
  if (v_qa ->> 'signer_person') is distinct from (v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001', message = 'The QA person who signed the authorisation activates it (DI-37; EBMR-RCP-085)';
  end if;
  if (v_reg ->> 'signer_person') = (v_qa ->> 'signer_person') then
    raise exception using errcode = 'P0001',
      message = 'QA and the regulatory-conformity signer are two different persons (ADR 0014; EBMR-RCP-085)';
  end if;
  select * into v from recipe.mbr_version where id = a.version_id;
  if recipe.version_state(v.id) is distinct from 'APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('Version %s is %s: only an APPROVED version becomes CURRENT or BRIDGING (ADR 0014; EBMR-RCP-086)', v.version_number, recipe.version_state(v.id));
  end if;
  v_ev := recipe.evidence_status(v.id);
  if not (v_ev ->> 'complete')::boolean then
    raise exception using errcode = 'P0001',
      message = format('The version has no complete verification record for its content (%s); it cannot become effective for a market (DI-04; EBMR-RCP-087)',
                       (select string_agg(m, '; ') from jsonb_array_elements_text(v_ev -> 'missing') m));
  end if;
  -- Never before the activation, never before the version's own effective date (PR-02).
  v_from := greatest(coalesce(a.effective_from, v_now), v_now, v.effective_from);
  if a.kind = 'BRIDGING' and a.effective_to <= v_from then
    raise exception using errcode = 'P0001', message = 'The bridging window has already ended (INV-17; EBMR-RCP-082)';
  end if;
  insert into recipe.market_authorisation_activation (authorisation_id, qa_signature_id, regulatory_signature_id, effective_from, person_id, account_id)
  values (a.id, p_qa_signature, p_regulatory_signature, v_from, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');

  v_push := recipe.push_reason('MBR_SUPERSEDED', format('superseded for market %s by version %s', a.market, v.version_number));
  for x in select * from jsonb_array_elements(a.cells) loop
    v_new := gen_random_uuid();
    if a.kind = 'CURRENT' then
      select * into v_old from recipe.authorisation_cell c
      where c.family_id = a.family_id and c.market = a.market and c.site = x ->> 'site' and c.line = x ->> 'line'
        and c.batch_size = x ->> 'batch_size' and c.status = 'CURRENT'
      for update;
      if found then
        if v_old.version_id = v.id then
          raise exception using errcode = 'P0001',
            message = format('Version %s is already CURRENT for %s at %s', v.version_number, a.market, x) || ' (INV-17; EBMR-RCP-088)';
        end if;
        if v_old.version_number > v.version_number then
          raise exception using errcode = 'P0001',
            message = format('The newer version %s is CURRENT for %s at %s; an older version cannot supersede it (PR-05; EBMR-RCP-089)',
                             v_old.version_number, a.market, x);
        end if;
        if v_old.effective_from > v_from then
          raise exception using errcode = 'P0001',
            message = format('Version %s takes effect for %s at %s only from %s; its successor cannot take effect before it (INV-17; EBMR-RCP-089)',
                             v_old.version_number, a.market, x, recipe.utc_text(v_old.effective_from));
        end if;
        update recipe.authorisation_cell set status = 'SUPERSEDED', valid_until = v_from, superseded_by = v_new where id = v_old.id;
      end if;
      insert into recipe.authorisation_cell (id, authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind,
                                             status, effective_from, valid_until, successor_version_id)
      values (v_new, a.id, a.family_id, v.id, v.version_number, a.market, x ->> 'site', x ->> 'line', x ->> 'batch_size', 'CURRENT',
              'CURRENT', v_from, null, null);
    else
      if not exists (select 1 from recipe.authorisation_cell c join recipe.authorisation_cell s on s.id = c.superseded_by
                     where c.version_id = v.id and c.market = a.market and c.site = x ->> 'site' and c.line = x ->> 'line'
                       and c.batch_size = x ->> 'batch_size' and c.status = 'SUPERSEDED' and s.version_id = a.successor_version_id) then
        raise exception using errcode = 'P0001',
          message = format('BRIDGING is given only where the named successor superseded this version: not the case for %s at %s (ADR 0014; EBMR-RCP-090)', a.market, x);
      end if;
      insert into recipe.authorisation_cell (id, authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind,
                                             status, effective_from, valid_until, successor_version_id)
      values (v_new, a.id, a.family_id, v.id, v.version_number, a.market, x ->> 'site', x ->> 'line', x ->> 'batch_size', 'BRIDGING',
              'BRIDGING', v_from, a.effective_to, a.successor_version_id);
    end if;
    v_out := v_out || jsonb_build_object('cell_id', v_new, 'site', x ->> 'site', 'line', x ->> 'line', 'batch_size', x ->> 'batch_size',
                                         'superseded_cell_id', case when a.kind = 'CURRENT' and v_old.id is not null then v_old.id end);
    v_old := null;
  end loop;
  perform recipe.restore_actor(v_push);
  perform kernel.audit_business_event('mbr_version:' || v.id,
    format('version %s is %s for market %s from %s (%s scope cells)', v.version_number, a.kind, a.market, recipe.utc_text(v_from), jsonb_array_length(a.cells)),
    jsonb_build_object('authorisation_id', a.id, 'cells', v_out));
  return jsonb_build_object('authorisation_id', a.id, 'version_id', v.id, 'market', a.market, 'kind', a.kind,
                            'effective_from', recipe.utc_text(v_from), 'cells', v_out);
end
$$;

create function recipe.withdraw_market_authorisation(p_authorisation uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  a    recipe.market_authorisation;
  v_n  integer;
begin
  perform iam.assert_not_administrator();
  select * into a from recipe.market_authorisation where id = p_authorisation for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown market authorisation %s (EBMR-RCP-083)', p_authorisation);
  end if;
  perform iam.require_permission('MBR.APPROVE', recipe.version_scope(a.version_id));
  perform 1 from recipe.mbr_family where id = a.family_id for update;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'A withdrawal states its reason (EBMR-RCP-084)';
  end if;
  if recipe.market_authorisation_state(a.id) = 'WITHDRAWN' then
    raise exception using errcode = 'P0001', message = 'This authorisation is already withdrawn (EBMR-RCP-084)';
  end if;
  insert into recipe.market_authorisation_withdrawal (authorisation_id, reason, person_id, account_id)
  values (a.id, p_reason, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');
  v_n := recipe.end_open_cells(a.id, null, 'MBR_AUTHORISATION_WITHDRAWN', p_reason);
  return jsonb_build_object('authorisation_id', a.id, 'cells_ended', v_n);
end
$$;

-- CURRENT -> RETIRED by QA (outline 5.2.1; PR-05): ends every open cell of the version, then makes
-- the RETIRE transition (which needs a reason and no open cell). Batches already issued keep their pin.
create function recipe.retire_version(p_version uuid, p_expected_version bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_ctx jsonb;
begin
  perform iam.assert_not_administrator();
  v_ctx := iam.require_permission('MBR.APPROVE', coalesce(recipe.version_scope(p_version), '{}'::jsonb));
  if recipe.version_state(p_version) = 'APPROVED' then
    perform 1 from recipe.mbr_family f join recipe.mbr_version v on v.family_id = f.id where v.id = p_version for update of f;
    perform recipe.end_open_cells(null, p_version, 'MBR_RETIRED', coalesce(v_ctx ->> 'reason_text', 'MBR version retired'));
  end if;
  return platform.transition('mbr_version', 'mbr_version', p_version, 'RETIRE', p_expected_version, '{}'::jsonb);
end
$$;

select platform.enforce_db_time('recipe.market_authorisation', array['recorded_at']);
select platform.enforce_db_time('recipe.market_authorisation_activation', array['recorded_at']);
select platform.enforce_db_time('recipe.market_authorisation_withdrawal', array['recorded_at']);
select platform.enforce_db_time('recipe.authorisation_cell', array['recorded_at']);
select kernel.register_audited_table('recipe.market_authorisation', 'mbr_market_authorisation', 'id', true);
select kernel.register_audited_table('recipe.market_authorisation_activation', 'mbr_market_authorisation', 'authorisation_id', true);
select kernel.register_audited_table('recipe.market_authorisation_withdrawal', 'mbr_market_authorisation', 'authorisation_id', true);
-- Cells end by UPDATE (status and end of validity), audited with old and new values and a reason.
select kernel.register_audited_table('recipe.authorisation_cell', 'mbr_market_authorisation', 'authorisation_id', false);

grant select on recipe.market_authorisation, recipe.market_authorisation_activation, recipe.market_authorisation_withdrawal,
                recipe.authorisation_cell to ebmr_app;
grant execute on function recipe.market_authorisation_state(uuid), recipe.canonical_cells(jsonb, recipe.mbr_family),
                          recipe.propose_market_authorisation(jsonb), recipe.activate_market_authorisation(uuid, uuid, uuid),
                          recipe.withdraw_market_authorisation(uuid, text), recipe.retire_version(uuid, bigint) to ebmr_app;
-- market_authorisation_content and end_open_cells stay private to the owner.

reset role;
