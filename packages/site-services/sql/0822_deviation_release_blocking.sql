-- Deviation links block release from the moment they are made (Phase 4 slice 2a; outline 5.2.5 and 5.2.6 item 2; INV-46;
-- L-21; PR-49). The records are 0820, the commands 0821.
--
-- A link is insert-only (0730: audited insert-only table, no writer but site.link_deviation) and ends only with a
-- recorded "assessed, not affected": QA's signed impact NONE for the subject (INV-46). For a subject and a market:
--   * a CANCELLED record does not block; it is listed (L-21);
--   * a CLOSED record does not block (its closure carries the disposition);
--   * otherwise every link of the record to the subject blocks unless its latest impact row for that market is NONE and
--     within QA's latest sign-off (for no market named, a material lot: every market assessed is NONE and IN is assessed).
-- A BATCH subject covers the links to the batch and to its output containers. L-21: a person who cancelled a record linked
-- to the subject does not sign its release.
--
--   site.deviation_release_items(kind, id, market)   jsonb array, one item per linked record: {deviationId, ref, kind,
--                                    state, classification, cancelled, blocking, reason, cancelledBy}; the release checklist.
--   site.deviation_release_problem(kind, id, market, signer)  the first reason the subject is not released for the market
--                                    by that signer, or NULL.
--   site.deviation_open_for(subject uuid)  true while a record linked to the subject (as BATCH, LOT or CONTAINER, or as
--                                    the batch of a linked container) still blocks it (interface fixed in the Phase 4 plan).
--   triggers on platform.state_history (before insert): a material lot's RELEASE, RELEASE_FOR_FURTHER_PROCESSING and UNHOLD,
--                                    and an output container's RELEASE, are refused while a record linked to that lot or
--                                    container blocks it, or when the signer cancelled one (EBMR-SITE-830). platform.transition
--                                    writes the history row of every state change, so the rule holds for every path.
--
-- Messages: EBMR-SITE-830 to 834.

set local role ebmr_owner;

create function site.deviation_release_items(p_kind text, p_id uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_items jsonb := '[]'::jsonb;
  d       site.deviation;
  l       site.deviation_link;
  i       site.deviation_impact;
  v_st    text;
  v_cov   bigint;
  v_block boolean;
  v_why   text;
  v_m     text;
begin
  if p_kind is null or p_kind not in ('BATCH', 'LOT', 'CONTAINER') or p_id is null then
    return v_items;
  end if;
  if p_market is not null and p_market not in ('IN', 'US', 'EU') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-831 %s is not a market (IN, US or EU)', p_market);
  end if;
  for d in select x.* from site.deviation x
            where exists (select 1 from site.deviation_link y where y.deviation_id = x.id
                           and ((y.subject_kind = p_kind and y.subject_id = p_id) or (p_kind = 'BATCH' and y.batch_id = p_id)))
            order by x.raised_at, x.id loop
    v_st := site.deviation_state(d.id);
    v_block := false;
    v_why := null;
    if v_st not in ('CANCELLED', 'CLOSED') then
      select s.covers_seq into v_cov from site.deviation_impact_signoff s where s.deviation_id = d.id order by s.seq desc limit 1;
      for l in select y.* from site.deviation_link y where y.deviation_id = d.id
                  and ((y.subject_kind = p_kind and y.subject_id = p_id) or (p_kind = 'BATCH' and y.batch_id = p_id))
                order by y.linked_at, y.id loop
        foreach v_m in array case when p_market is not null then array[p_market]
                                  else coalesce((select array_agg(distinct m.market order by m.market) from site.deviation_impact m where m.link_id = l.id), '{}') || array['IN'] end loop
          i := site.deviation_latest_impact(l.id, v_m);
          if i.id is null then
            v_why := format('%s %s is not assessed for %s', lower(l.subject_kind), l.subject_ref, v_m);
          elsif i.impact <> 'NONE' then
            v_why := format('the impact on %s %s for %s is %s', lower(l.subject_kind), l.subject_ref, v_m, i.impact);
          elsif v_cov is null or i.seq > v_cov then
            v_why := format('the impact NONE on %s %s for %s is not yet signed by QA', lower(l.subject_kind), l.subject_ref, v_m);
          end if;
          exit when v_why is not null;
        end loop;
        exit when v_why is not null;
      end loop;
      v_block := v_why is not null;
    end if;
    v_items := v_items || jsonb_build_object(
      'deviationId', d.id, 'ref', d.ref, 'kind', d.kind, 'state', v_st,
      'classification', coalesce((site.deviation_latest_classification(d.id)).classification, d.classification),
      'cancelled', v_st = 'CANCELLED', 'blocking', v_block, 'reason', v_why,
      'cancelledBy', (select e.person_id from site.deviation_event e where e.deviation_id = d.id and e.event = 'CANCELLED'));
  end loop;
  return v_items;
end
$$;

create function site.deviation_release_problem(p_kind text, p_id uuid, p_market text, p_signer uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce(
    (select format('deviation %s linked to it is %s: %s; a link ends only with QA''s signed impact NONE for the market, or the record''s closure (INV-46; PR-49)',
                   x.v ->> 'ref', x.v ->> 'state', x.v ->> 'reason')
       from jsonb_array_elements(site.deviation_release_items(p_kind, p_id, p_market)) with ordinality x(v, n)
      where (x.v -> 'blocking') = 'true'::jsonb order by x.n limit 1),
    (select format('this person cancelled deviation %s linked to it; the release is signed by someone else (L-21)', x.v ->> 'ref')
       from jsonb_array_elements(site.deviation_release_items(p_kind, p_id, p_market)) with ordinality x(v, n)
      where p_signer is not null and x.v ->> 'cancelledBy' = p_signer::text order by x.n limit 1))
$$;

create function site.deviation_open_for(p_subject uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (
    select 1 from (select distinct y.subject_kind as k from site.deviation_link y where y.subject_id = p_subject
                   union select 'BATCH' from site.deviation_link y where y.batch_id = p_subject) s
     where exists (select 1 from jsonb_array_elements(site.deviation_release_items(s.k, p_subject, null)) x(v) where (x.v -> 'blocking') = 'true'::jsonb))
$$;

create function site.guard_release_deviations() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_problem text;
begin
  v_problem := site.deviation_release_problem(case new.aggregate_type when 'material_lot' then 'LOT' else 'CONTAINER' end, new.aggregate_id, null,
                                              (select s.signer_person from esig.signature s where s.id = new.signature_id));
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-830 the %s cannot be released: %s', replace(new.aggregate_type, '_', ' '), v_problem);
  end if;
  return new;
end
$$;

create trigger zz_release_deviations_lot before insert on platform.state_history
  for each row when (new.aggregate_type = 'material_lot' and new.event in ('RELEASE', 'RELEASE_FOR_FURTHER_PROCESSING', 'UNHOLD'))
  execute function site.guard_release_deviations();
create trigger zz_release_deviations_container before insert on platform.state_history
  for each row when (new.aggregate_type = 'output_container' and new.event = 'RELEASE')
  execute function site.guard_release_deviations();

revoke all on function site.deviation_release_items(text, uuid, text), site.deviation_release_problem(text, uuid, text, uuid),
                       site.deviation_open_for(uuid), site.guard_release_deviations() from public;
grant execute on function site.deviation_release_items(text, uuid, text), site.deviation_release_problem(text, uuid, text, uuid),
                          site.deviation_open_for(uuid) to ebmr_app;

reset role;
