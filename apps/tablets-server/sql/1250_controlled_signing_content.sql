-- Tablets: the content of the four signed records of controlled-substance mode for the ceremony (Phase 6 slice 6e; draft
-- control IN-53; recipe-core 1031 to 1033).
--
-- Handbook: modules/tablets-server.md
--
-- The records are GOVERNANCE-class (tab.aggregate_read_class leaves them out): their content is not read through the
-- shared provider pairs (tab.kernel_signing_meanings), which tablets 1259 and 1270 re-create after this range. These two
-- definers serve the CONTROLLED_ACT signing handler (features/controlled) instead, as 1275 does for support grants:
--   * tab.controlled_preview(token hash, type, id, meaning): the content to sign, for the session bound to the token when
--     its role may sign that meaning on that record type; EBMR-TAB-018 without a session, EBMR-TAB-020 otherwise;
--   * tab.controlled_signing_content(type, id, meaning): the same inside the signing command, for the validated actor
--     holding the meaning's permission (iam.require_permission, EBMR-IAM-040).
-- Pairs: controlled_product CONTROLLED_PRODUCT_APPROVED; controlled_custody CONTROLLED_CUSTODY_RECORDED and
-- CONTROLLED_CUSTODY_COUNTERSIGNED; controlled_checkpoint CONTROLLED_BALANCE_SIGNED. Any other pair: EBMR-TAB-019.

set local role ebmr_owner;

create function tab.controlled_pair_ok(p_type text, p_meaning text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select (p_type, p_meaning) in (('controlled_product', 'CONTROLLED_PRODUCT_APPROVED'), ('controlled_custody', 'CONTROLLED_CUSTODY_RECORDED'),
                                 ('controlled_custody', 'CONTROLLED_CUSTODY_COUNTERSIGNED'), ('controlled_checkpoint', 'CONTROLLED_BALANCE_SIGNED'))
$$;

create function tab.controlled_preview(p_token_hash text, p_type text, p_id text, p_meaning text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, esig, pg_temp as $$
declare
  v_reader tab.reader := tab.reader_of(p_token_hash);
  v_type   esig.meaning_type;
begin
  if not tab.controlled_pair_ok(p_type, p_meaning) then
    raise exception using errcode = 'P0001', message = format('A %s record is not signed %s (IN-53). [EBMR-TAB-019]', coalesce(p_type, '(none)'), coalesce(p_meaning, '(none)'));
  end if;
  v_type := esig.current_meaning(p_meaning);
  if not tab.role_may(v_reader.role_code, v_type.permissions) then
    raise exception using errcode = 'P0001',
      message = format('This session may not read %s %s: the role %s may not sign %s. [EBMR-TAB-020]', p_type, p_id, v_reader.role_code, p_meaning);
  end if;
  return esig.content_for_signing(p_type, p_id);
end
$$;

create function tab.controlled_signing_content(p_type text, p_id text, p_meaning text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, esig, iam, pg_temp as $$
begin
  if not tab.controlled_pair_ok(p_type, p_meaning) then
    raise exception using errcode = 'P0001', message = format('A %s record is not signed %s (IN-53). [EBMR-TAB-019]', coalesce(p_type, '(none)'), coalesce(p_meaning, '(none)'));
  end if;
  perform iam.require_permission((esig.current_meaning(p_meaning)).permissions[1], '{}'::jsonb);
  return esig.content_for_signing(p_type, p_id);
end
$$;

revoke all on function tab.controlled_pair_ok(text, text), tab.controlled_preview(text, text, text, text), tab.controlled_signing_content(text, text, text) from public;
grant execute on function tab.controlled_preview(text, text, text, text), tab.controlled_signing_content(text, text, text) to ebmr_app;

reset role;
