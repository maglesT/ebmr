-- Recipe core: the federated genealogy runs as a validated actor with a catalogued permission, and its logs are audited
-- (Phase 6 slice 6i; CI meta tests [DI-17][DI-18] and [DI-17][INV-01][INV-02][INV-04][INV-17] of
-- packages/recipe-core/test/lifecycle/authorization.test.ts; DI-14, DI-31; D-P6i-0-13).
--
-- Handbook: modules/recipe-core.md
--
--   * Permissions GENEALOGY.FEDERATE (GMP, WRITE: ask another installation and record its answer; QA reviewer, head of
--     QC, AP, QA MBR approver, QA shop floor) and FEDERATION.ANSWER (GMP, WRITE: answer another installation's sealed
--     request; the role FEDERATION_INTERFACE, INTEGRATION accounts only, which holds no SIGN or ACKNOWLEDGE permission
--     and so never signs, DI-14).
--   * recipe.answer_federated_genealogy (from 1092), recipe.issue_federated_request, recipe.record_federation_failure and
--     recipe.record_federated_excerpt (from 1090) re-created: each refuses administrators, then checks its permission,
--     before anything else. The answering server runs the answer as its federation integration identity; the peer seal,
--     destination, time window and nonce are still checked by platform.accept_federation_request.
--   * recipe.federated_request_out, recipe.federated_excerpt and recipe.federated_request_failure become audited,
--     insert-only tables (the triggers 1090 made with platform.make_insert_only are replaced by the kernel's own); the
--     application role keeps SELECT only.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1093_federation_actor_and_audit)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the federated genealogy as a validated actor (DI-17, DI-18, DI-31)'));

insert into iam.permission (code, domain, effect, description) values
  ('GENEALOGY.FEDERATE', 'GMP', 'WRITE', 'Ask another site installation for its genealogy across a transfer and record its sealed answer (L-41, PR-57)'),
  ('FEDERATION.ANSWER', 'GMP', 'WRITE', 'Answer another site installation''s sealed genealogy request about a transfer exchanged with it (L-41, DI-31)');
insert into iam.role (code, name, role_group, description, account_kinds, is_kernel) values
  ('FEDERATION_INTERFACE', 'Site-to-site federation', 'MASTER_RECORDS',
   'The installation''s federation endpoint: answers sealed genealogy requests of trusted installations; never signs, never logs in interactively',
   array['INTEGRATION'], false);
insert into iam.role_permission (role_code, permission_code) values
  ('FEDERATION_INTERFACE', 'FEDERATION.ANSWER'),
  ('QA_REVIEWER', 'GENEALOGY.FEDERATE'), ('HEAD_OF_QC', 'GENEALOGY.FEDERATE'), ('AUTHORISED_PERSON', 'GENEALOGY.FEDERATE'),
  ('QA_MBR_APPROVER', 'GENEALOGY.FEDERATE'), ('QA_SHOP_FLOOR', 'GENEALOGY.FEDERATE');

select kernel.set_actor_context(null);

create or replace function recipe.answer_federated_genealogy(p_request text, p_seal text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, platform, iam, pg_temp as $$
declare
  v       jsonb;
  m       jsonb;
  q       jsonb;
  v_rid   uuid;
  v_from  text;
  v_tr    uuid;
  v_as_of timestamptz;
  v_rows  jsonb;
  v_nodes jsonb;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('FEDERATION.ANSWER', '{}'::jsonb);
  v := platform.accept_federation_request(p_request, p_seal);
  if not coalesce((v ->> 'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', v ->> 'reason');
  end if;
  m := v -> 'request'; q := m -> 'query'; v_rid := (v ->> 'requestId')::uuid; v_from := m ->> 'from';
  if coalesce(q ->> 'transferId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(q ->> 'direction', '') not in ('FORWARD', 'BACKWARD') or coalesce(q ->> 'asOfUs', '') !~ '^(0|[1-9][0-9]{0,15})$' then
    return platform.refuse_federation_query(v_rid, 'EBMR-FED-010 a genealogy query names the transfer, the direction (FORWARD or BACKWARD) and the as-of point (epoch microseconds)');
  end if;
  v_tr := (q ->> 'transferId')::uuid;
  if not exists (select 1 from site.transfer_package p join site.transfer_package_seal ps on ps.package_id = p.id where p.id = v_tr and p.destination_installation = v_from)
     and not exists (select 1 from site.transfer_receipt r where r.package_id = v_tr and r.origin_installation = v_from) then
    return platform.refuse_federation_query(v_rid,
      format('EBMR-FED-011 transfer %s was not exchanged with installation %s; a site answers only about the transfers it shared with the asking site (D-P6i-0-7)', v_tr, v_from));
  end if;
  v_as_of := site.us_instant(q ->> 'asOfUs');
  -- Two clocks are never equal: an as-of point up to 2 seconds ahead of this database's clock is answered once this
  -- clock has passed it (review 6i-R2), so the answer is still as of an instant in the past here; further ahead is refused.
  if v_as_of > clock_timestamp() + interval '2 seconds' then
    return platform.refuse_federation_query(v_rid, 'EBMR-FED-012 the as-of point is in the future at the answering site (D-P6i-0-9)');
  end if;
  if v_as_of > clock_timestamp() then
    perform pg_sleep(extract(epoch from (v_as_of - clock_timestamp())) + 0.001);
  end if;
  begin
    select coalesce(jsonb_agg(jsonb_build_object('nodeKind', g.node_kind, 'nodeId', g.node_id, 'parentKind', g.parent_kind, 'parentId', g.parent_id,
                                                 'edgeKind', g.edge_kind, 'depth', g.depth)
                              order by g.depth, g.node_kind, g.node_id, g.parent_kind, g.parent_id, g.edge_kind), '[]')
      into v_rows from recipe.genealogy('TRANSFER', v_tr, q ->> 'direction', v_as_of) g;
    select recipe.genealogy_node_views(array_agg(g.node_kind), array_agg(g.node_id)) into v_nodes
      from (select distinct g.node_kind, g.node_id from recipe.genealogy('TRANSFER', v_tr, q ->> 'direction', v_as_of) g) g;
  exception when others then
    return platform.refuse_federation_query(v_rid, 'EBMR-FED-013 ' || sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'payload', jsonb_build_object(
    'format', 'ebmr.genealogy-excerpt.v1', 'requestNonce', m ->> 'nonce', 'from', (platform.current_installation()).installation_code, 'to', v_from,
    'query', q, 'asOfUs', q ->> 'asOfUs', 'answeredAtUs', site.us_text(clock_timestamp()), 'rows', v_rows, 'nodes', coalesce(v_nodes, '[]'::jsonb))::text);
end
$$;

create or replace function recipe.issue_federated_request(p_peer text, p_transfer uuid, p_direction text, p_as_of timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, platform, kernel, iam, pg_temp as $$
declare
  me      platform.installation_identity := platform.current_installation();
  v_nonce uuid := gen_random_uuid();
  v_as_of timestamptz := coalesce(p_as_of, clock_timestamp());
  v_req   text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('GENEALOGY.FEDERATE', '{}'::jsonb);
  if me.version is null then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-014 this installation has no identity yet; it asks no other site (L-41)';
  end if;
  if (platform.trusted_peer(p_peer)).id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-FED-014 installation %s is not a trusted peer of this site', coalesce(p_peer, 'NULL'));
  end if;
  if p_direction is null or p_direction not in ('FORWARD', 'BACKWARD') then
    raise exception using errcode = 'P0001', message = format('EBMR-GEN-001 %s is no genealogy direction (FORWARD or BACKWARD)', coalesce(p_direction, 'NULL'));
  end if;
  if v_as_of > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'EBMR-GEN-003 the as-of point of a trace is now or in the past, never in the future (D-P6d-0-3)';
  end if;
  if not exists (select 1 from site.transfer_package p where p.id = p_transfer and p.destination_installation = p_peer)
     and not exists (select 1 from site.transfer_receipt r where r.package_id = p_transfer and r.origin_installation = p_peer) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-FED-011 transfer %s was not exchanged with installation %s (D-P6i-0-7)', coalesce(p_transfer::text, 'NULL'), coalesce(p_peer, 'NULL'));
  end if;
  v_req := jsonb_build_object('format', 'ebmr.federation-request.v1', 'nonce', v_nonce, 'from', me.installation_code, 'to', p_peer,
                              'issuedAtUs', site.us_text(clock_timestamp()),
                              'query', jsonb_build_object('transferId', p_transfer, 'direction', p_direction, 'asOfUs', site.us_text(v_as_of)))::text;
  insert into recipe.federated_request_out (nonce, peer_code, transfer_id, direction, as_of, request, person_id)
  values (v_nonce, p_peer, p_transfer, p_direction, v_as_of, v_req, (kernel.current_actor() ->> 'person_id')::uuid);
  return jsonb_build_object('nonce', v_nonce, 'request', v_req, 'baseUrl', (platform.trusted_peer(p_peer)).base_url, 'asOfUs', site.us_text(v_as_of));
end
$$;

create or replace function recipe.record_federation_failure(p_nonce uuid, p_status text, p_detail text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, platform, iam, pg_temp as $$
declare
  o       recipe.federated_request_out;
  v_alarm uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('GENEALOGY.FEDERATE', '{}'::jsonb);
  select * into o from recipe.federated_request_out where nonce = p_nonce;
  if o.nonce is null then
    raise exception using errcode = 'P0001', message = format('EBMR-FED-015 no federation request %s was issued here', coalesce(p_nonce::text, 'NULL'));
  end if;
  if p_status is null or p_status not in ('UNREACHABLE', 'REFUSED', 'WRONG_ANSWER') then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-015 a failed federation request is UNREACHABLE, REFUSED or WRONG_ANSWER';
  end if;
  v_alarm := platform.raise_installation_alarm(case p_status when 'UNREACHABLE' then 'UNREACHABLE' else 'WRONG_ANSWER' end,
                                               case p_status when 'WRONG_ANSWER' then 'MAJOR' else 'MINOR' end, 'FEDERATION_QUERY', o.peer_code,
                                               jsonb_build_object('nonce', o.nonce, 'transferId', o.transfer_id, 'status', p_status, 'detail', left(coalesce(p_detail, ''), 1000)));
  insert into recipe.federated_request_failure (nonce, status, detail, alarm_id)
  values (o.nonce, p_status, left(coalesce(nullif(btrim(p_detail), ''), p_status), 2000), v_alarm);
  return v_alarm;
end
$$;

create or replace function recipe.record_federated_excerpt(p_nonce uuid, p_payload text, p_seal text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, platform, iam, pg_temp as $$
declare
  o       recipe.federated_request_out;
  m       jsonb;
  v_why   text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('GENEALOGY.FEDERATE', '{}'::jsonb);
  select * into o from recipe.federated_request_out where nonce = p_nonce for update;
  if o.nonce is null then
    raise exception using errcode = 'P0001', message = format('EBMR-FED-015 no federation request %s was issued here', coalesce(p_nonce::text, 'NULL'));
  end if;
  if exists (select 1 from recipe.federated_excerpt e where e.nonce = o.nonce) then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-016 this request was answered already';
  end if;
  begin
    m := p_payload::jsonb;
  exception when others then
    m := null;
  end;
  if not platform.peer_seal_valid(o.peer_code, 'federation-answer', p_payload, p_seal) then
    v_why := format('EBMR-FED-017 the answer''s seal does not verify under the key of installation %s', o.peer_code);
  elsif jsonb_typeof(m) is distinct from 'object' or m ->> 'format' is distinct from 'ebmr.genealogy-excerpt.v1'
        or jsonb_typeof(m -> 'rows') is distinct from 'array' or jsonb_typeof(m -> 'nodes') is distinct from 'array' then
    v_why := 'EBMR-FED-018 the answer is not a genealogy excerpt (format ebmr.genealogy-excerpt.v1 with rows and nodes)';
  elsif m ->> 'from' is distinct from o.peer_code or m ->> 'to' is distinct from (platform.current_installation()).installation_code
        or m ->> 'requestNonce' is distinct from o.nonce::text or m -> 'query' ->> 'transferId' is distinct from o.transfer_id::text
        or m -> 'query' ->> 'direction' is distinct from o.direction or m ->> 'asOfUs' is distinct from site.us_text(o.as_of) then
    v_why := 'EBMR-FED-019 the answer does not answer the request issued (installations, nonce, transfer, direction or as-of differ)';
  end if;
  if v_why is not null then
    return jsonb_build_object('ok', false, 'reason', v_why, 'alarmId', recipe.record_federation_failure(o.nonce, 'WRONG_ANSWER', v_why));
  end if;
  insert into recipe.federated_excerpt (nonce, peer_code, transfer_id, direction, as_of, payload, payload_sha256, seal)
  values (o.nonce, o.peer_code, o.transfer_id, o.direction, o.as_of, p_payload, encode(sha256(convert_to(p_payload, 'UTF8')), 'hex'), p_seal)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'excerptId', v_id);
end
$$;

-- The logs become audited, insert-only tables (the kernel's triggers replace platform.make_insert_only's, same names).
drop trigger aa_insert_only_recipe_federated_request_out on recipe.federated_request_out;
drop trigger aa_no_truncate_recipe_federated_request_out on recipe.federated_request_out;
drop trigger aa_insert_only_recipe_federated_excerpt on recipe.federated_excerpt;
drop trigger aa_no_truncate_recipe_federated_excerpt on recipe.federated_excerpt;
drop trigger aa_insert_only_recipe_federated_request_failure on recipe.federated_request_failure;
drop trigger aa_no_truncate_recipe_federated_request_failure on recipe.federated_request_failure;
select kernel.register_audited_table('recipe.federated_request_out', 'federated_request', 'nonce', true);
select kernel.register_audited_table('recipe.federated_excerpt', 'federated_request', 'nonce', true);
select kernel.register_audited_table('recipe.federated_request_failure', 'federated_request', 'nonce', true);
revoke insert, update, delete, truncate on recipe.federated_request_out, recipe.federated_excerpt, recipe.federated_request_failure from ebmr_app;

reset role;
