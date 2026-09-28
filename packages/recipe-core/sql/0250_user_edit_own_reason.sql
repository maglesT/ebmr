-- Recipe core: a change a user starts carries that user's own reason; recipe code never writes it for them
-- (DI-22, DI-24; EBMR-AUDIT-002).
--
-- The kernel's audit trigger (kernel 0010) refuses an UPDATE or DELETE of an audited row unless the command
-- context carries a reason code and a reason text, neither of them blank (outline 5.4: both halves for every
-- change after first entry). recipe.push_reason (0100, 0230) completes a missing reason with a fixed one that
-- names the act. Until this migration three commands that a user starts used it for their own UPDATE:
--   set_draft_attributes   (0150)  the author edits the change record, effective date or review due date of
--                                  a DRAFT version (fixed reason MBR_DRAFT_EDIT)
--   issue_stub_batch       (0170)  the issuer moves a PLANNED batch to ISSUED (fixed reason BATCH_ISSUED)
--   set_stub_batch_status  (0170)  the issuer moves a batch on to IN_PROGRESS, COMPLETED or CANCELLED
--                                  (fixed reason BATCH_STATUS)
-- A command that gave no reason, or only a reason text, therefore passed EBMR-AUDIT-002 with a reason code,
-- and possibly a reason text, that the user never gave. Production code wrote the reason only to satisfy the
-- reason check. The audit entry of a change a person decides on must record why that person made it (DI-22),
-- not the system's description of what happened.
--
-- From here on these three commands make their UPDATE in the command's own validated context, unchanged.
-- The kernel refuses the UPDATE (EBMR-AUDIT-002) unless the command gave both halves of its reason, and the
-- whole command rolls back. For issue_stub_batch this includes the pin and the control recipe written before
-- the status update. No new rule is added here: the kernel's own check applies again, and no recipe
-- function steps around it.
--
-- recipe.push_reason and recipe.restore_actor remain only for updates that follow from another act of the
-- same command, an act with its own signatures or its own stated reason (0160):
--   - activate_market_authorisation supersedes the predecessor's CURRENT cell (MBR_SUPERSEDED); the
--     activation itself carries the QA and regulatory-conformity e-signatures;
--   - withdraw_market_authorisation and retire_version end the open cells (recipe.end_open_cells), with the
--     withdrawal's stated reason or the retirement command's reason as the text.
-- In those cases too, a reason code the command gave owns the reason and is never completed (0230).
--
-- Applied as a new migration because applied migrations are checksummed and never edited. Apart from the
-- reason, each function is exactly as it was: same checks, same order, same messages. CREATE OR REPLACE
-- keeps the privileges set in 0150 and 0170.

set local role ebmr_owner;

-- p_attrs: any of {"changeRecordId": uuid|null, "effectiveFrom": timestamptz|null, "reviewDue": "YYYY-MM-DD"|null}.
-- The update carries the command's own reason (code and text); without both halves the kernel refuses it.
create or replace function recipe.set_draft_attributes(p_version uuid, p_attrs jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v     recipe.mbr_version;
  k     text;
begin
  perform iam.assert_not_administrator();
  select * into v from recipe.mbr_version where id = p_version;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  for k in select jsonb_object_keys(coalesce(p_attrs, '{}'::jsonb)) loop
    if k not in ('changeRecordId', 'effectiveFrom', 'reviewDue') then
      raise exception using errcode = 'P0001', message = format('%s is not a draft attribute of an MBR version (EBMR-RCP-028)', k);
    end if;
  end loop;
  if p_attrs ? 'changeRecordId' then
    v.change_record_id := (p_attrs ->> 'changeRecordId')::uuid;
    if v.change_record_id is not null and not exists (select 1 from recipe.change_record where id = v.change_record_id) then
      raise exception using errcode = 'P0001', message = format('Unknown change record %s (PR-06; EBMR-RCP-060)', v.change_record_id);
    end if;
  end if;
  if p_attrs ? 'effectiveFrom' then
    v.effective_from := (p_attrs ->> 'effectiveFrom')::timestamptz;
  end if;
  if p_attrs ? 'reviewDue' then
    v.review_due := (p_attrs ->> 'reviewDue')::date;
  end if;
  update recipe.mbr_version set change_record_id = v.change_record_id, effective_from = v.effective_from, review_due = v.review_due
  where id = p_version;
end
$$;

-- Issues a planned stub batch: selection at the database clock, the pin, the control recipe and the
-- status ISSUED, in one transaction. p_version (optional) is the version the caller expects; any
-- other than the one the selection gives is refused (PR-05: after v2 is CURRENT, v1 is refused).
-- The status update carries the command's own reason (code and text); without both halves the kernel
-- refuses it and nothing of the issue remains.
create or replace function recipe.issue_stub_batch(p_batch uuid, p_version uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  b      recipe.stub_batch;
  v_sel  jsonb;
  p      recipe.batch_mbr_pin;
  cr     recipe.control_recipe;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.stub_batch where id = p_batch for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-RCP-120)', p_batch);
  end if;
  perform iam.require_permission('BATCH.ISSUE', recipe.family_scope(b.family_id));
  -- Wait for any market authorisation being activated for this family (INV-17 / INV-01 consistency).
  perform 1 from recipe.mbr_family where id = b.family_id for share;
  if b.status <> 'PLANNED' then
    raise exception using errcode = 'P0001', message = format('Batch %s is %s; only a PLANNED batch is issued (EBMR-RCP-102)', b.batch_number, b.status);
  end if;
  v_sel := recipe.select_version_for_issue(b.family_id, b.markets, jsonb_build_object('site', b.site, 'line', b.line, 'batch_size', b.batch_size), clock_timestamp());
  if not (v_sel ->> 'ok')::boolean then
    raise exception using errcode = 'P0001', message = format('Batch %s cannot be issued. %s (EBMR-RCP-100)', b.batch_number, v_sel ->> 'explanation');
  end if;
  insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions,
                                    person_id, account_id)
  values (b.id, b.family_id, p_version, 0, repeat('0', 64), '{}', '{}', '{}', '{}',
          '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning * into p;
  insert into recipe.control_recipe (batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
  values (b.id, p.id, p.version_id, p.content_hash, '{}', repeat('0', 64), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning * into cr;
  update recipe.stub_batch set status = 'ISSUED' where id = b.id;
  perform kernel.audit_business_event('batch:' || b.id,
    format('batch %s issued on MBR %s version %s (%s), control recipe %s', b.batch_number, v_sel ->> 'family', p.version_number, p.selection ->> 'rule', cr.snapshot_hash),
    jsonb_build_object('pin_id', p.id, 'version_id', p.version_id, 'content_hash', p.content_hash, 'snapshot_hash', cr.snapshot_hash));
  return jsonb_build_object('batch_id', b.id, 'pin_id', p.id, 'version_id', p.version_id, 'version_number', p.version_number,
                            'content_hash', p.content_hash, 'rule', p.selection ->> 'rule', 'basis', p.selection -> 'basis',
                            'control_recipe_id', cr.id, 'snapshot_hash', cr.snapshot_hash);
end
$$;

-- Stub batch progress (Phase 3 replaces this with the batch record machine). The update carries the
-- command's own reason (code and text); without both halves the kernel refuses it.
create or replace function recipe.set_stub_batch_status(p_batch uuid, p_status text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  b     recipe.stub_batch;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.stub_batch where id = p_batch for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-RCP-120)', p_batch);
  end if;
  perform iam.require_permission('BATCH.ISSUE', recipe.family_scope(b.family_id));
  if p_status = 'ISSUED' then
    raise exception using errcode = 'P0001', message = 'A batch is issued through recipe.issue_stub_batch (INV-01; EBMR-RCP-122)';
  end if;
  update recipe.stub_batch set status = p_status where id = p_batch;
end
$$;

-- Privileges are kept by CREATE OR REPLACE (execute for ebmr_app from 0150 and 0170).

reset role;
