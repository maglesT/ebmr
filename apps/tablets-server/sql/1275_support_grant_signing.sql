-- Phase 6 slice 6f: the content of a vendor support grant for its two customer signatures (DI-08; kernel 1202).
--
-- Handbook: modules/tablets-server.md
--
-- A support grant is a GOVERNANCE record (tab.aggregate_read_class): its content is not read through the kernel's
-- provider pairs (tab.kernel_signing_meanings) nor as a RECORD-class record. These two definers serve the SUPPORT_ACT
-- signing handler (features/governance) instead, so the shared functions stay untouched:
--   * tab.support_grant_preview(token hash, grant, meaning): the content to sign, for the session bound to the token when
--     its role signs that meaning (SUPPORT.APPROVE_QA or SUPPORT.APPROVE_IT); EBMR-TAB-018 without a session,
--     EBMR-TAB-020 otherwise;
--   * tab.support_grant_signing_content(grant, meaning): the same inside the signing command, for the validated actor
--     holding the meaning's permission (iam.require_permission, EBMR-IAM-040).

set local role ebmr_owner;

create function tab.support_grant_preview(p_token_hash text, p_grant uuid, p_meaning text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, esig, pg_temp as $$
declare
  v_reader tab.reader := tab.reader_of(p_token_hash);
  v_type   esig.meaning_type;
begin
  if p_meaning not in ('SUPPORT_ACCESS_QA_APPROVED', 'SUPPORT_ACCESS_IT_APPROVED') then
    raise exception using errcode = 'P0001', message = format('A support grant is signed SUPPORT_ACCESS_QA_APPROVED or SUPPORT_ACCESS_IT_APPROVED, not %s. [EBMR-TAB-019]', coalesce(p_meaning, '(none)'));
  end if;
  v_type := esig.current_meaning(p_meaning);
  if not tab.role_may(v_reader.role_code, v_type.permissions) then
    raise exception using errcode = 'P0001',
      message = format('This session may not read support_grant %s: the role %s may not sign %s. [EBMR-TAB-020]', p_grant, v_reader.role_code, p_meaning);
  end if;
  return esig.content_for_signing('support_grant', p_grant::text);
end
$$;

create function tab.support_grant_signing_content(p_grant uuid, p_meaning text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, esig, iam, pg_temp as $$
begin
  perform iam.require_permission(case p_meaning when 'SUPPORT_ACCESS_QA_APPROVED' then 'SUPPORT.APPROVE_QA'
                                                when 'SUPPORT_ACCESS_IT_APPROVED' then 'SUPPORT.APPROVE_IT' end, '{}'::jsonb);
  return esig.content_for_signing('support_grant', p_grant::text);
end
$$;

revoke all on function tab.support_grant_preview(text, uuid, text), tab.support_grant_signing_content(uuid, text) from public;
grant execute on function tab.support_grant_preview(text, uuid, text), tab.support_grant_signing_content(uuid, text) to ebmr_app;

reset role;
