-- India-domestic label particulars and the Schedule H2 QR payload as a versioned stub, bound to the batch record (Phase 4
-- slice 6a; plan defaults D-P4-14, D-6a-6; controls IN-31, IN-30, PR-43; ADR 0012).
--
--   recipe.india_label_particulars(batch)  the batch-variable particulars an India-domestic pack carries, all from the
--       record and its masters, never typed: drug name and strength, dosage form, batch number, date of manufacture and
--       expiry in plain form (recipe.batch_expiry, PR-43), the manufacturer's name and address and licence number, and for
--       a loan-licence batch the loan licensee's name, address and licence number (IN-30). The fixed particulars
--       (ingredients with INN and amount, storage, directions and warnings) belong to the approved artwork template and are
--       not repeated here (D-6a-6). Refused (EBMR-IND-050) when a particular cannot be computed.
--   recipe.h2_layout()  the stub layout: version H2-STUB-1, status U (unconfirmed, D-P4-14), keys V, UPIC, GENERIC, BRAND,
--       MFR, BATCH, MFG, EXP, LIC and, for a loan-licence batch, LOAN; `KEY=value;` in that order, values without ; or =.
--   recipe.h2_payload(batch)  the payload computed from the label particulars now.
--   recipe.h2_payload_issue  insert-only: a payload released for printing on a batch, with its layout version and SHA-256,
--       by recipe.issue_h2_payload(batch) (STEP.EXECUTE on the batch, never an administrator).
--   recipe.h2_payload_problem(batch, payload)  IN-31 payload binding: NULL when the payload is the one computed from the
--       batch's record now and was issued for that batch; else why not (another batch's, stale after a data change, or
--       never issued).
-- Messages: EBMR-IND-050 to EBMR-IND-054.

set local role ebmr_owner;

-- IN-31 (header).
create function recipe.india_label_particulars(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b      recipe.batch_execution;
  sb     recipe.stub_batch;
  f      recipe.mbr_family;
  lb     recipe.batch_licence_basis;
  v_exp  jsonb;
  v_mfg  date;
  v_end  date;
begin
  select * into b from recipe.batch_execution where id = p_batch;
  select * into sb from recipe.stub_batch where id = p_batch;
  select * into f from recipe.mbr_family where id = sb.family_id;
  if b.id is null or f.id is null or b.installation <> 'GMP' then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-050 %s is no issued GMP batch, so it has no label particulars (IN-31)', coalesce(p_batch::text, 'NULL'));
  end if;
  select * into lb from recipe.batch_licence_basis where batch_id = p_batch;
  if lb.batch_id is null then
    select * into lb from recipe.batch_licence_basis where batch_id = recipe.packaging_parent_of(p_batch);
  end if;
  if lb.batch_id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-050 batch %s carries no licence recorded at its issue: the manufacturer and licence number of its label cannot be given (IN-31, IN-30)', b.batch_number);
  end if;
  v_exp := recipe.batch_expiry(p_batch);
  if v_exp is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-050 the expiry of batch %s cannot be computed: the product master''s shelf life is needed (PR-43, IN-31)', b.batch_number);
  end if;
  v_mfg := (v_exp ->> 'manufactureDate')::date;
  v_end := (v_exp ->> 'expiryDate')::date;
  return jsonb_build_object(
    'batchId', p_batch, 'batchNumber', b.batch_number, 'productCode', f.product_code, 'drugName', f.product_name, 'strength', f.strength,
    'dosageForm', f.dosage_form,
    'manufactureDate', to_char(v_mfg, 'YYYY-MM-DD'), 'manufactureLabel', upper(to_char(v_mfg, 'MM/YYYY')),
    'expiryDate', to_char(v_end, 'YYYY-MM-DD'), 'expiryLabel', upper(to_char(v_end, 'MM/YYYY')),
    'shelfLifeMonths', (v_exp ->> 'shelfLifeMonths')::integer, 'tentativeShelfLife', (v_exp ->> 'tentative')::boolean,
    'manufacturer', jsonb_build_object('name', lb.basis ->> 'holderName', 'address', lb.basis ->> 'holderAddress',
                                       'licenceNumber', lb.licence_number, 'form', lb.basis ->> 'form'),
    'loanLicensee', case when lb.loan_licence_id is null then null
                         else jsonb_build_object('name', lb.basis ->> 'loanHolderName', 'address', lb.basis ->> 'loanHolderAddress',
                                                 'licenceNumber', lb.loan_licence_number, 'form', lb.basis ->> 'loanForm') end);
end
$$;

create function recipe.h2_layout() returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '{"version": "H2-STUB-1", "status": "U", "keys": ["V", "UPIC", "GENERIC", "BRAND", "MFR", "BATCH", "MFG", "EXP", "LIC", "LOAN"]}'::jsonb
$$;

-- D-P4-14 (header).
create function recipe.h2_payload(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  p     jsonb := recipe.india_label_particulars(p_batch);
  v_kv  text[][];
  i     integer;
  v_out text := '';
begin
  v_kv := array[
    ['V', recipe.h2_layout() ->> 'version'],
    ['UPIC', p ->> 'productCode'],
    ['GENERIC', (p ->> 'drugName') || ' ' || (p ->> 'strength')],
    ['BRAND', p ->> 'drugName'],
    ['MFR', (p -> 'manufacturer' ->> 'name') || ', ' || (p -> 'manufacturer' ->> 'address')],
    ['BATCH', p ->> 'batchNumber'],
    ['MFG', left(p ->> 'manufactureDate', 7)],
    ['EXP', left(p ->> 'expiryDate', 7)],
    ['LIC', p -> 'manufacturer' ->> 'licenceNumber']];
  if jsonb_typeof(p -> 'loanLicensee') = 'object' then
    v_kv := v_kv || array[['LOAN', p -> 'loanLicensee' ->> 'licenceNumber']];
  end if;
  for i in 1 .. array_length(v_kv, 1) loop
    if v_kv[i][2] is null or v_kv[i][2] !~ '^[ -~]{1,200}$' or v_kv[i][2] ~ '[;=]' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-IND-051 the H2 payload of batch %s cannot carry %s: it must be printable text without ; or = (D-P4-14, IN-31)', p ->> 'batchNumber', v_kv[i][1]);
    end if;
    v_out := v_out || case when i > 1 then ';' else '' end || v_kv[i][1] || '=' || v_kv[i][2];
  end loop;
  return v_out;
end
$$;

create table recipe.h2_payload_issue (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null references recipe.batch_execution (id),
  layout_version       text not null,
  payload              text not null,
  payload_hash         text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  issued_by_person     uuid not null,
  issued_by_account    uuid not null,
  issued_at            timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null
);
create index h2_payload_issue_batch on recipe.h2_payload_issue (batch_id, issued_at desc);
revoke all on recipe.h2_payload_issue from public;
select platform.enforce_db_time('recipe.h2_payload_issue', array['issued_at']);
select kernel.register_audited_table('recipe.h2_payload_issue', 'h2_payload_issue', 'id', true);
create trigger zz_immutable before update or delete on recipe.h2_payload_issue for each row execute function site.india_record_immutable();

-- Releases the payload of batch p_batch for printing (header). Returns {issueId, payload, payloadHash, layoutVersion}.
create function recipe.issue_h2_payload(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_pl    text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_pl := recipe.h2_payload(p_batch);
  insert into recipe.h2_payload_issue (batch_id, layout_version, payload, payload_hash, issued_by_person, issued_by_account, correlation_id)
  values (p_batch, recipe.h2_layout() ->> 'version', v_pl, encode(sha256(convert_to(v_pl, 'UTF8')), 'hex'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('issueId', v_id, 'payload', v_pl, 'payloadHash', encode(sha256(convert_to(v_pl, 'UTF8')), 'hex'),
                            'layoutVersion', recipe.h2_layout() ->> 'version');
end
$$;

-- IN-31 payload binding (header).
create function recipe.h2_payload_problem(p_batch uuid, p_payload text) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_now text;
  v_bn  text;
  v_key text;
begin
  select x.batch_number into v_bn from recipe.batch_execution x where x.id = p_batch;
  if v_bn is null then
    return format('%s is no batch of this installation (IN-31)', coalesce(p_batch::text, 'NULL'));
  end if;
  begin
    v_now := recipe.h2_payload(p_batch);
  exception when others then
    return format('the H2 payload of batch %s cannot be computed: %s (IN-31)', v_bn, sqlerrm);
  end;
  if p_payload is distinct from v_now then
    select coalesce(split_part(a.e, '=', 1), split_part(c.e, '=', 1)) into v_key
      from unnest(string_to_array(coalesce(p_payload, ''), ';')) with ordinality a(e, n)
      full join unnest(string_to_array(v_now, ';')) with ordinality c(e, n) on a.n = c.n
     where a.e is distinct from c.e
     order by coalesce(a.n, c.n) limit 1;
    return format('the payload is not the one computed from the record of batch %s now (it differs at %s): print only the payload issued for this batch (IN-31, D-P4-14)',
                  v_bn, coalesce(nullif(v_key, ''), 'its end'));
  end if;
  if not exists (select 1 from recipe.h2_payload_issue i where i.batch_id = p_batch and i.payload_hash = encode(sha256(convert_to(p_payload, 'UTF8')), 'hex')) then
    return format('the payload of batch %s was never issued for printing (IN-31)', v_bn);
  end if;
  return null;
end
$$;

revoke all on function recipe.india_label_particulars(uuid), recipe.h2_layout(), recipe.h2_payload(uuid), recipe.issue_h2_payload(uuid),
                       recipe.h2_payload_problem(uuid, text) from public;
revoke all on recipe.h2_payload_issue from ebmr_app;
grant select on recipe.h2_payload_issue to ebmr_app;
grant execute on function recipe.india_label_particulars(uuid), recipe.h2_layout(), recipe.h2_payload(uuid), recipe.issue_h2_payload(uuid),
                          recipe.h2_payload_problem(uuid, text) to ebmr_app;

reset role;
