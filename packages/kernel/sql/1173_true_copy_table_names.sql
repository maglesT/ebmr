-- Records (kernel): a true copy of a chain whose tables live in the records schema verifies (Phase 4 slice 6b review fix
-- of kernel 1161; DI-41).
--
-- Why. The audit trigger (kernel 0010) names a row's table as tg_relid::regclass::text under its own search_path
-- (pg_catalog, kernel, pg_temp): a records table is named "records.contingency_form". records.true_copy_parts named the
-- tables as a.table_name::text under ITS search_path (pg_catalog, records, kernel, pg_temp): "contingency_form". The
-- offline verifier matches rows to events by table name, so the copy of any chain held in the records schema (the
-- contingency forms of slice 6b, the QP packages of 4b) reported every row as "not captured by the audit trail".
--
-- Now. records.audit_table_name(regclass) names a table exactly as the audit trigger does (the same search_path), and
-- records.true_copy_parts is re-created from its latest definition (1161) using it for the names it returns and
-- compares; the table it reads is the regclass itself. Nothing else changes (signature, STABLE, owner only).

set local role ebmr_owner;

-- A table's name as the audit trigger writes it into kernel.audit_event.table_name.
create function records.audit_table_name(p_table regclass) returns text
language sql stable set search_path = pg_catalog, kernel, pg_temp as $$
  select p_table::text
$$;
revoke all on function records.audit_table_name(regclass) from public;

create or replace function records.true_copy_parts(p_chain_key text, p_tables text[]) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_type   text;
  v_id     text;
  v_tables jsonb := '[]'::jsonb;
  v_rows   jsonb;
  r        record;
  t        text;
begin
  if p_chain_key is null or strpos(p_chain_key, ':') <= 1 or right(p_chain_key, 1) = ':' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-070 %s is not an aggregate chain key', coalesce(p_chain_key, 'NULL'));
  end if;
  v_type := split_part(p_chain_key, ':', 1);
  v_id := substr(p_chain_key, length(v_type) + 2);
  if p_tables is not null then
    foreach t in array p_tables loop
      if not exists (select 1 from kernel.audited_table a where a.aggregate_type = v_type and records.audit_table_name(a.table_name) = t) then
        raise exception using errcode = 'P0001', message = format('EBMR-REC-070 %s is not a registered table of aggregate type %s', t, v_type);
      end if;
    end loop;
  end if;
  for r in select records.audit_table_name(a.table_name) as table_name, a.table_name::regclass as rel, a.aggregate_column, a.insert_only from kernel.audited_table a
            where a.aggregate_type = v_type and (p_tables is null or records.audit_table_name(a.table_name) = any (p_tables))
            order by records.audit_table_name(a.table_name) collate "C" loop
    execute format('select coalesce(jsonb_agg(jsonb_build_object(''recordId'', q.record_id, ''sha256'', q.sha256, ''content'', q.content)
                                              order by q.record_id collate "C", q.content collate "C"), ''[]''::jsonb)
                      from (select coalesce(x.j ->> ''id'', x.j ->> %L) as record_id, x.j::text as content,
                                   encode(sha256(convert_to(x.j::text, ''UTF8'')), ''hex'') as sha256
                              from (select kernel.row_json(y) as j from %s y where y.%I::text = $1) x) q',
                   r.aggregate_column, r.rel, r.aggregate_column)
      into v_rows using v_id;
    v_tables := v_tables || jsonb_build_object('table', r.table_name, 'aggregateColumn', r.aggregate_column, 'insertOnly', r.insert_only, 'rows', v_rows);
  end loop;
  return jsonb_build_object(
    'generatedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'aggregateType', v_type, 'aggregateId', v_id, 'tables', v_tables,
    'events', coalesce((select jsonb_agg(jsonb_build_object('seq', e.seq::text, 'prevHash', encode(e.prev_hash, 'hex'), 'hash', encode(e.hash, 'hex'),
                                                            'recordedAt', to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                                                            'correlationId', e.correlation_id::text, 'action', e.action, 'tableName', e.table_name,
                                                            'recordId', e.record_id, 'payload', e.payload::text) order by e.seq)
                          from kernel.audit_event e where e.chain_key = p_chain_key), '[]'::jsonb),
    'head', (select jsonb_build_object('seq', h.last_seq::text, 'hash', encode(h.last_hash, 'hex')) from kernel.audit_chain_head h where h.chain_key = p_chain_key),
    'checkpoints', coalesce((select jsonb_agg(jsonb_build_object('seq', c.seq::text, 'hash', encode(c.hash, 'hex'), 'eventCount', c.event_count::text,
                                                                 'sealedAt', to_char(c.sealed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'reason', c.reason) order by c.seq)
                               from kernel.audit_checkpoint c where c.chain_key = p_chain_key), '[]'::jsonb),
    'database', coalesce((select jsonb_agg(jsonb_build_object('seq', v.seq::text, 'problem', v.problem)) from kernel.verify_chain(p_chain_key) v), '[]'::jsonb));
end
$$;

reset role;
