-- Records (kernel): what a true-copy bundle holds, read by a definer (Phase 4 slice 4b; DI-41; for the EU QP batch package,
-- kernel 1160).
--
-- buildTrueCopyBundle (true-copy.ts) reads kernel.audit_event, kernel.audit_chain_head and the aggregate's tables
-- directly; an edition that takes those reads away from the application role (the Tablets edition does, tablets 0420:
-- the audit trail is read only through its reader functions) cannot build a copy with it. records.true_copy_snapshot
-- returns the same parts, in the same canonical form, for one chain, to a person who may register true copies
-- (RECORD.TRUE_COPY_REGISTER: QA reviewer, service accounts); every query of the function runs in the snapshot of the
-- calling statement (STABLE), so the parts agree with each other. packages/kernel/src/records/qp-package.ts
-- (trueCopyBundleFromSnapshot) assembles the bundle exactly as buildTrueCopyBundle does.
--
--   records.true_copy_snapshot(chain_key text, tables text[] default null) returns jsonb
--     {generatedAt, aggregateType, aggregateId, tables: [{table, aggregateColumn, insertOnly, rows: [{recordId, content,
--      sha256}]}], events: [{seq, prevHash, hash, recordedAt, correlationId, action, tableName, recordId, payload}],
--      head: {seq, hash} | null, checkpoints: [...], database: [{seq, problem}]}
-- Messages: EBMR-REC-070 (as the true-copy builder), EBMR-IAM-040.

set local role ebmr_owner;

-- The parts, read in one snapshot (STABLE: every query sees the snapshot of the calling statement). Owner only.
create function records.true_copy_parts(p_chain_key text, p_tables text[]) returns jsonb
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
      if not exists (select 1 from kernel.audited_table a where a.aggregate_type = v_type and a.table_name::text = t) then
        raise exception using errcode = 'P0001', message = format('EBMR-REC-070 %s is not a registered table of aggregate type %s', t, v_type);
      end if;
    end loop;
  end if;
  for r in select a.table_name::text as table_name, a.aggregate_column, a.insert_only from kernel.audited_table a
            where a.aggregate_type = v_type and (p_tables is null or a.table_name::text = any (p_tables))
            order by a.table_name::text collate "C" loop
    execute format('select coalesce(jsonb_agg(jsonb_build_object(''recordId'', q.record_id, ''sha256'', q.sha256, ''content'', q.content)
                                              order by q.record_id collate "C", q.content collate "C"), ''[]''::jsonb)
                      from (select coalesce(x.j ->> ''id'', x.j ->> %L) as record_id, x.j::text as content,
                                   encode(sha256(convert_to(x.j::text, ''UTF8'')), ''hex'') as sha256
                              from (select kernel.row_json(y) as j from %s y where y.%I::text = $1) x) q',
                   r.aggregate_column, r.table_name, r.aggregate_column)
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

-- The parts for a person who may register true copies (the permission check writes its evaluation, so this is VOLATILE
-- and the reads are the STABLE function's, in one snapshot).
create function records.true_copy_snapshot(p_chain_key text, p_tables text[] default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, iam, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECORD.TRUE_COPY_REGISTER', '{}'::jsonb);
  return records.true_copy_parts(p_chain_key, p_tables);
end
$$;

revoke all on function records.true_copy_parts(text, text[]), records.true_copy_snapshot(text, text[]) from public;
grant execute on function records.true_copy_snapshot(text, text[]) to ebmr_app;

reset role;
