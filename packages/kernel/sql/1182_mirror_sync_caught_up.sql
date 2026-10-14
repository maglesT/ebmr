-- Phase 6 slice 6a (review fix): a mirror synchronisation marks its data class fresh only when the adapter is caught
-- up with its source (DI-31; INV-26, INV-38; D-P6a-F-1; defect P6a-R3).
--
-- Handbook: modules/kernel.md
--
--  * platform.record_mirror_sync(data class) (1180) let any active adapter of the class's system refresh the class's
--    last synchronisation with nothing behind it: a heartbeat from an adapter that had not received what its source
--    published kept a blocking mirror (LMS, CMMS, ERP lot status, QMS status) looking fresh. It is dropped.
--  * platform.record_mirror_sync(data class, source head) replaces it. The adapter names the source's high-water mark
--    (the highest sequence number the source has published on the adapter's feed, decimal text; 0 when it has
--    published nothing). The database marks the class fresh only when
--      - the adapter holds that mark: the highest sequence number it holds (accepted in platform.inbound_message, or
--        received and refused in platform.inbound_exception) is at least the source head, and
--      - it holds every number up to it: no sequence number is missing between the adapter's first held number (or
--        the head this class was last proven caught up to, by the same adapter) and the source head, unless a person
--        acknowledged the SEQUENCE_GAP alarm whose missing range covers it (platform.acknowledge_integration_alarm,
--        with a note: the gap was looked at and the lost messages accounted for). A gap later filled by its late
--        messages leaves no hole; a message the source never delivered keeps the mirror from being refreshed until it
--        arrives or its gap is acknowledged, so the mirror ages past its bound and fails closed meanwhile.
--    The mark is kept on platform.mirror_sync (source_head) beside the time. A head that is not a sequence number is
--    EBMR-INT-018, an adapter behind it EBMR-INT-019, a missing number EBMR-INT-024. The database cannot see the
--    source itself: an adapter that names a lower head than the source holds is outside what it can check (the
--    reconciliation report, platform.record_reconciliation, compares counts and checksums with the source's).

set local role ebmr_owner;

alter table platform.mirror_sync add column source_head bigint check (source_head >= 0);
comment on column platform.mirror_sync.source_head is
  'The source''s high-water mark (sequence number) the adapter was proven caught up to at this synchronisation (kernel 1182); NULL for a row written before 1182.';

-- Number lookups of refused receipts by sequence (the caught-up check reads them).
create index inbound_exception_refused_sequence on platform.inbound_exception (adapter_id, sequence_no) where kind = 'REFUSED' and sequence_no is not null;

drop function platform.record_mirror_sync(text);

create function platform.record_mirror_sync(p_data_class text, p_source_head text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_ad    iam.integration_adapter;
  v_cls   platform.mirror_data_class%rowtype;
  v_prev  platform.mirror_sync%rowtype;
  v_head  bigint;
  v_max   bigint;
  v_from  bigint;
  v_held  bigint;
  v_hole_from bigint;
begin
  perform platform.require_actor();
  v_ad := iam.current_integration_adapter();
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  select * into v_cls from platform.mirror_data_class where code = p_data_class;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-011 unknown mirror data class %s', coalesce(p_data_class, 'null'));
  end if;
  if v_cls.source_system <> v_ad.source_system then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-013 adapter %s (%s) cannot synchronise %s, which mirrors %s', v_ad.code, v_ad.source_system, v_cls.code, v_cls.source_system);
  end if;
  if coalesce(p_source_head, '') !~ '^(0|[1-9][0-9]{0,17})$' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-018 a synchronisation of %s names the source''s high-water mark (a sequence number as decimal text); %s is not one',
                       v_cls.code, coalesce(p_source_head, 'NULL'));
  end if;
  v_head := p_source_head::bigint;
  select greatest((select max(m.sequence_no) from platform.inbound_message m where m.adapter_id = v_ad.id),
                  (select max(e.sequence_no) from platform.inbound_exception e where e.adapter_id = v_ad.id and e.kind = 'REFUSED' and e.sequence_no is not null))
    into v_max;
  if v_head > 0 and coalesce(v_max, 0) < v_head then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-019 adapter %s is behind its source: it holds sequence %s, the %s source is at %s; %s is not marked fresh (D-P6a-F-1)',
                       v_ad.code, coalesce(v_max, 0), v_ad.source_system, v_head, v_cls.code);
  end if;
  if v_head > 0 then
    select * into v_prev from platform.mirror_sync where data_class = v_cls.code;
    v_from := case
      when v_prev.adapter_id = v_ad.id and v_prev.source_head is not null and v_prev.source_head <= v_head then v_prev.source_head + 1
      else least((select min(m.sequence_no) from platform.inbound_message m where m.adapter_id = v_ad.id),
                 (select min(e.sequence_no) from platform.inbound_exception e where e.adapter_id = v_ad.id and e.kind = 'REFUSED' and e.sequence_no is not null))
    end;
    if v_from <= v_head then
      -- The holes between v_from and the head (runs of numbers neither accepted nor recorded as refused) that no
      -- acknowledged SEQUENCE_GAP alarm of this adapter covers.
      with held as (
        select m.sequence_no as n from platform.inbound_message m where m.adapter_id = v_ad.id and m.sequence_no between v_from and v_head
        union
        select e.sequence_no from platform.inbound_exception e
         where e.adapter_id = v_ad.id and e.kind = 'REFUSED' and e.sequence_no between v_from and v_head
      ), edges as (
        select v_from - 1 as n union all select n from held union all select v_head + 1
      ), holes as (
        select n + 1 as hole_from, nxt - 1 as hole_to
          from (select n, lead(n) over (order by n) as nxt from edges) x
         where nxt > n + 1
      )
      select coalesce(sum(h.hole_to - h.hole_from + 1), 0), min(h.hole_from)
        into v_held, v_hole_from
        from holes h
       where not exists (
         select 1 from platform.integration_alarm a join platform.integration_alarm_ack k on k.alarm_id = a.id
          where a.adapter_id = v_ad.id and a.kind = 'SEQUENCE_GAP'
            and (a.details ->> 'missingFrom')::bigint <= h.hole_from and (a.details ->> 'missingTo')::bigint >= h.hole_to);
      if v_held > 0 then
        raise exception using errcode = 'P0001',
          message = format('EBMR-INT-024 adapter %s holds no message for %s sequence number(s) up to the source''s %s (the first is %s), and no acknowledged gap alarm covers them; %s is not marked fresh until they arrive or a person acknowledges the gap (D-P6a-F-1)',
                           v_ad.code, v_held, v_head, v_hole_from, v_cls.code);
      end if;
    end if;
  end if;
  insert into platform.mirror_sync (data_class, adapter_id, last_synced_at, source_head) values (v_cls.code, v_ad.id, clock_timestamp(), v_head)
  on conflict (data_class) do update set adapter_id = excluded.adapter_id, last_synced_at = excluded.last_synced_at, source_head = excluded.source_head;
end
$$;
revoke all on function platform.record_mirror_sync(text, text) from public;
grant execute on function platform.record_mirror_sync(text, text) to ebmr_app;

reset role;
