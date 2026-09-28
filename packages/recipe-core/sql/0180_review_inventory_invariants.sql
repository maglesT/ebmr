-- Recipe core, MBR life cycle (A3), part 8: periodic review and the overdue list (PR-05), the
-- controlled-document inventory (PR-05; PR-02 unique document ID and version), where-used (outline
-- 6.5) and the invariant queries that must return no rows (outline 5.3; ADR 0012 item 8).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Periodic review (PR-05; EU Ch.4 4.5)
-- ---------------------------------------------------------------------------------------------

create table recipe.periodic_review (
  id           uuid primary key default gen_random_uuid(),
  version_id   uuid not null references recipe.mbr_version (id),
  outcome      text not null check (outcome in ('NO_CHANGE', 'REVISION_REQUIRED', 'RETIREMENT_PROPOSED')),
  summary      text not null check (btrim(summary) <> ''),
  next_due     date not null,
  person_id    uuid not null,
  account_id   uuid not null,
  recorded_at  timestamptz not null default clock_timestamp()
);
create index periodic_review_version on recipe.periodic_review (version_id, recorded_at);

create trigger a1_stamp before insert on recipe.periodic_review for each row execute function recipe.stamp_person();

-- The review due date in force: the latest review's next due date, else the version's own.
create function recipe.review_due(p_version uuid) returns date
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select r.next_due from recipe.periodic_review r where r.version_id = p_version order by r.recorded_at desc, r.id desc limit 1),
                  (select v.review_due from recipe.mbr_version v where v.id = p_version))
$$;

create function recipe.record_periodic_review(p_version uuid, p_outcome text, p_summary text, p_next_due date) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_version where id = p_version) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.APPROVE', recipe.version_scope(p_version));
  if recipe.version_state(p_version) is distinct from 'APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('A periodic review is recorded for an APPROVED version; this one is %s (PR-05; EBMR-RCP-072)', recipe.version_state(p_version));
  end if;
  if p_next_due is null or p_next_due <= recipe.site_today() then
    raise exception using errcode = 'P0001', message = 'The next review due date lies in the future (PR-05; EBMR-RCP-072)';
  end if;
  insert into recipe.periodic_review (version_id, outcome, summary, next_due, person_id, account_id)
  values (p_version, p_outcome, coalesce(p_summary, ''), p_next_due, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  return v_id;
end
$$;

-- The overdue list for the dashboard: APPROVED versions whose review due date has passed at the
-- site date (or at the date given).
create function recipe.overdue_reviews(p_as_of date default null)
returns table (version_id uuid, family_code text, version_number integer, document_id text, review_due date, days_overdue integer,
               last_review_at timestamptz, in_use boolean)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select v.id, f.code, v.version_number, 'MBR-' || f.code || '-v' || v.version_number, recipe.review_due(v.id),
         (coalesce(p_as_of, recipe.site_today()) - recipe.review_due(v.id))::integer,
         (select max(r.recorded_at) from recipe.periodic_review r where r.version_id = v.id),
         exists (select 1 from recipe.authorisation_cell c where c.version_id = v.id and c.status in ('CURRENT', 'BRIDGING'))
  from recipe.mbr_version v join recipe.mbr_family f on f.id = v.family_id
  where recipe.version_state(v.id) = 'APPROVED' and recipe.review_due(v.id) < coalesce(p_as_of, recipe.site_today())
  order by recipe.review_due(v.id), f.code, v.version_number
$$;

-- ---------------------------------------------------------------------------------------------
-- Controlled-document inventory (PR-05; EU Ch.4 4.32): every version with its state and dates
-- ---------------------------------------------------------------------------------------------

create view recipe.document_inventory as
select 'MBR-' || f.code || '-v' || v.version_number as document_id,
       f.code as family_code, f.title, f.edition, f.record_kind, f.product_code, f.product_name, f.strength, f.dosage_form,
       v.id as version_id, v.version_number, recipe.version_state(v.id) as state,
       c.content_hash, c.revision as content_revision,
       v.effective_from, v.review_due as initial_review_due, recipe.review_due(v.id) as review_due,
       (select max(r.recorded_at) from recipe.periodic_review r where r.version_id = v.id) as last_review_at,
       (select min(h.recorded_at) from platform.state_history h
        where h.aggregate_type = 'mbr_version' and h.aggregate_id = v.id and h.to_state = 'APPROVED') as approved_at,
       (select min(h.recorded_at) from platform.state_history h
        where h.aggregate_type = 'mbr_version' and h.aggregate_id = v.id and h.to_state in ('RETIRED', 'WITHDRAWN')) as ended_at,
       r.number as change_record_number,
       (select coalesce(jsonb_agg(jsonb_build_object('market', x.market, 'status', x.status, 'site', x.site, 'line', x.line,
                                                     'batch_size', x.batch_size, 'effective_from', recipe.utc_text(x.effective_from),
                                                     'valid_until', recipe.utc_text(x.valid_until))
                                  order by x.market, x.site, x.line, x.batch_size, x.effective_from), '[]'::jsonb)
        from recipe.authorisation_cell x where x.version_id = v.id) as market_authorisations
from recipe.mbr_version v
join recipe.mbr_family f on f.id = v.family_id
left join lateral (select * from recipe.mbr_content cc where cc.version_id = v.id order by cc.revision desc limit 1) c on true
left join recipe.change_record r on r.id = v.change_record_id;

-- ---------------------------------------------------------------------------------------------
-- Where-used (outline 6.5): batches pinned to a version or to any version of a family
-- ---------------------------------------------------------------------------------------------

create function recipe.where_used(p_version uuid)
returns table (batch_id uuid, batch_number text, status text, markets text[], site text, line text, batch_size text, pinned_at timestamptz,
               version_id uuid, version_number integer)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select b.id, b.batch_number, b.status, b.markets, b.site, b.line, b.batch_size, p.recorded_at, p.version_id, p.version_number
  from recipe.batch_mbr_pin p join recipe.stub_batch b on b.id = p.batch_id
  where p.version_id = p_version
  order by p.recorded_at, b.batch_number
$$;

-- Issued or running batches of versions of the same family older than p_version: the batches that
-- need an in-flight disposition before p_version is approved.
create function recipe.in_flight_batches(p_version uuid)
returns table (batch_id uuid, batch_number text, status text, pinned_version_id uuid, pinned_version_number integer, disposition text)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select b.id, b.batch_number, b.status, pv.id, pv.version_number,
         (select d.disposition from recipe.in_flight_disposition d where d.successor_version_id = v.id and d.batch_id = b.id)
  from recipe.mbr_version v
  join recipe.mbr_version pv on pv.family_id = v.family_id and pv.version_number < v.version_number
  join recipe.batch_mbr_pin p on p.version_id = pv.id
  join recipe.stub_batch b on b.id = p.batch_id
  where v.id = p_version and b.status in ('ISSUED', 'IN_PROGRESS')
  order by b.batch_number
$$;

-- ---------------------------------------------------------------------------------------------
-- Invariant queries (zero rows expected; production runs them on a schedule)
-- ---------------------------------------------------------------------------------------------

-- INV-04: recomputed from the state history, the signatures and the version log.
create function recipe.inv04_violations() returns table (version_id uuid, detail text)
language sql stable security definer set search_path = pg_catalog, recipe, platform, esig, pg_temp as $$
  with steps as (
    select h.aggregate_id as version_id, h.event, h.recorded_at, s.signer_person,
           (select max(d.cycle) from recipe.mbr_draft_entry d where d.version_id = h.aggregate_id and d.recorded_at <= h.recorded_at) as cycle,
           (select c.signer_person from platform.state_history hc join esig.signature c on c.id = hc.signature_id
            where hc.aggregate_type = 'mbr_version' and hc.aggregate_id = h.aggregate_id and hc.event = 'CHECK' and hc.to_version < h.to_version
            order by hc.to_version desc limit 1) as checker
    from platform.state_history h join esig.signature s on s.id = h.signature_id
    where h.aggregate_type = 'mbr_version' and h.event in ('CHECK', 'APPROVE')
  )
  select st.version_id, format('%s was signed by the author', st.event)
  from steps st join recipe.mbr_version v on v.id = st.version_id where st.signer_person = v.author_person
  union all
  select st.version_id, format('%s was signed by a person who edited the content in the same draft cycle', st.event)
  from steps st
  where exists (select 1 from recipe.mbr_version_log l where l.version_id = st.version_id and l.cycle = st.cycle and l.is_edit
                  and l.person_id = st.signer_person and l.recorded_at <= st.recorded_at)
  union all
  select st.version_id, 'APPROVE was signed by the checker while S4 does not allow it'
  from steps st where st.event = 'APPROVE' and st.signer_person = st.checker and not recipe.checker_may_approve()
$$;

-- INV-17: one open CURRENT per family, market and scope; no overlapping CURRENT validities; every
-- cell of an activated record with valid signatures; BRIDGING always time-limited; only approved
-- versions.
create function recipe.inv17_violations() returns table (cell_id uuid, detail text)
language sql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
  select c.id, 'more than one open CURRENT cell for this family, market and scope'
  from recipe.authorisation_cell c
  where c.status = 'CURRENT'
    and exists (select 1 from recipe.authorisation_cell o where o.id <> c.id and o.status = 'CURRENT' and o.family_id = c.family_id
                  and o.market = c.market and o.site = c.site and o.line = c.line and o.batch_size = c.batch_size)
  union all
  select c.id, 'CURRENT validity overlaps another CURRENT validity of the same family, market and scope'
  from recipe.authorisation_cell c
  where c.kind = 'CURRENT'
    and exists (select 1 from recipe.authorisation_cell o where o.id <> c.id and o.kind = 'CURRENT' and o.family_id = c.family_id
                  and o.market = c.market and o.site = c.site and o.line = c.line and o.batch_size = c.batch_size
                  and tstzrange(o.effective_from, o.valid_until, '[)') && tstzrange(c.effective_from, c.valid_until, '[)'))
  union all
  select c.id, 'BRIDGING without an end of validity'
  from recipe.authorisation_cell c where c.kind = 'BRIDGING' and c.valid_until is null
  union all
  select c.id, 'cell without an activated, validly signed authorisation record'
  from recipe.authorisation_cell c
  left join recipe.market_authorisation_activation a on a.authorisation_id = c.authorisation_id
  where a.authorisation_id is null
     or esig.signature_problem(a.qa_signature_id, 'MBR_MARKET_AUTHORISED', 'mbr_market_authorisation', c.authorisation_id::text) is not null
     or esig.signature_problem(a.regulatory_signature_id, 'REGULATORY_CONFIRMED', 'mbr_market_authorisation', c.authorisation_id::text) is not null
  union all
  select c.id, 'cell of a version that was never approved'
  from recipe.authorisation_cell c where not recipe.version_was_approved(c.version_id)
$$;

-- INV-01: every issued batch has exactly one pin; the pin is what the selection gives at its issue
-- instant; the pinned content never changed.
create function recipe.inv01_violations() returns table (batch_id uuid, detail text)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select b.id, format('batch %s is %s without a pinned MBR version', b.batch_number, b.status)
  from recipe.stub_batch b
  where b.status in ('ISSUED', 'IN_PROGRESS', 'COMPLETED') and not exists (select 1 from recipe.batch_mbr_pin p where p.batch_id = b.id)
  union all
  select p.batch_id, format('the pinned version %s is not the version the selection gives at the issue instant (%s)', p.version_number,
                            coalesce(s ->> 'version_number', s ->> 'explanation'))
  from recipe.batch_mbr_pin p
  cross join lateral (select recipe.select_version_for_issue(p.family_id, p.markets, p.scope, p.recorded_at) as s) x
  where not coalesce((s ->> 'ok')::boolean, false) or (s ->> 'version_id')::uuid is distinct from p.version_id
  union all
  select p.batch_id, 'the pinned version''s content changed after issue'
  from recipe.batch_mbr_pin p where recipe.content_hash_of(p.version_id) is distinct from p.content_hash
$$;

-- INV-02: every pinned batch has its control recipe and every control recipe verifies.
create function recipe.inv02_violations() returns table (batch_id uuid, detail text)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select p.batch_id, 'pinned batch without a control recipe'
  from recipe.batch_mbr_pin p where not exists (select 1 from recipe.control_recipe c where c.batch_id = p.batch_id)
  union all
  select c.batch_id, v ->> 'problems'
  from recipe.control_recipe c cross join lateral (select recipe.verify_control_recipe(c.batch_id) as v) x
  where not (v ->> 'ok')::boolean
$$;

-- PR-06: no content revision of a version after it was first approved.
create function recipe.approved_content_violations() returns table (version_id uuid, detail text)
language sql stable security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
  select c.version_id, format('content revision %s recorded after the version was approved', c.revision)
  from recipe.mbr_content c
  join lateral (select min(h.recorded_at) as approved_at from platform.state_history h
                where h.aggregate_type = 'mbr_version' and h.aggregate_id = c.version_id and h.to_state = 'APPROVED') a on true
  where a.approved_at is not null and c.recorded_at > a.approved_at
$$;

create function recipe.invariant_violations() returns table (invariant text, subject uuid, detail text)
language sql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select 'INV-01', batch_id, detail from recipe.inv01_violations()
  union all select 'INV-02', batch_id, detail from recipe.inv02_violations()
  union all select 'INV-04', version_id, detail from recipe.inv04_violations()
  union all select 'INV-17', cell_id, detail from recipe.inv17_violations()
  union all select 'PR-06', version_id, detail from recipe.approved_content_violations()
$$;

select platform.enforce_db_time('recipe.periodic_review', array['recorded_at']);
select kernel.register_audited_table('recipe.periodic_review', 'mbr_version', 'version_id', true);

grant select on recipe.periodic_review, recipe.document_inventory to ebmr_app;
grant execute on function recipe.review_due(uuid), recipe.record_periodic_review(uuid, text, text, date), recipe.overdue_reviews(date),
                          recipe.where_used(uuid), recipe.in_flight_batches(uuid), recipe.inv04_violations(), recipe.inv17_violations(),
                          recipe.inv01_violations(), recipe.inv02_violations(), recipe.approved_content_violations(),
                          recipe.invariant_violations() to ebmr_app;

reset role;
