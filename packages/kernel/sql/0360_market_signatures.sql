-- Market-profile engine, part 7: the electronic signatures behind every market loosening (build
-- outline 3.3.2, 3.5; ADR 0008 decision 8; IN-52, ST-01, INV-47, DI-09, DI-35, DI-37).
--
-- A loosening of a market value or policy is approved by a named person with a full electronic
-- signature, never by a free approval id. The approving functions accept an approval only through
-- esig.assert_signature for the meaning and aggregate below, and refuse it when the signer is the
-- person making the change:
--
--   meaning                          aggregate type          aggregate id (what is signed)
--   RULE_TABLE_CORRECTION_APPROVED   market_rule_correction  <table>:<version>:<content hash>        (0340)
--   SITE_VALUE_LOOSENING_APPROVED    market_site_loosening   <site>@<key>@<effective from>@<value
--                                                            departed from>@<new value>@<justification> (0320)
--   POLICY_LOOSENING_APPROVED        market_policy_version   <policy>@<version>@<position>          (0350)
--
-- The change is signed before it is made, so each aggregate id names the change itself and the
-- content is derived from the id alone: it never changes afterwards, so a signature stays valid for
-- the life of the change (INV-09). The state (PROPOSED before the change is made, then PUBLISHED or
-- RECORDED, or SUPERSEDED / NOT_NEXT when another change took its place) is what the signer expects
-- at signing (EBMR-ESIG-039); the approving functions check everything else themselves.
--
-- The signature types are vendor minimum types signed by the quality unit (MBR.APPROVE,
-- RECORD.QA_REVIEW). The catalogue rows are written under the software-release identity, which the
-- catalogue guard (0210) accepts for vendor types, as in 0720.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 0360_market_signatures)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'signature types of the market-engine approvals (source corrections, site-value and policy loosenings)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('RULE_TABLE_CORRECTION_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Rule-table source correction approved',
   'As a quality-unit approver, I approve this correction of shipped rule-table values against their cited regulatory source.',
   array['MBR.APPROVE', 'RECORD.QA_REVIEW'], '{}', true, false, false, 'ALL_COMPONENTS', false,
   'Outline 3.3.2 source corrections (two QA signatures, L-38); ADR 0008 decision 8; IN-52'),
  ('SITE_VALUE_LOOSENING_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Site-value loosening approved',
   'As a quality-unit approver, I approve this site''s departure from the guidance value named, under the justification cited.',
   array['MBR.APPROVE', 'RECORD.QA_REVIEW'], '{}', true, false, false, 'ALL_COMPONENTS', false,
   'Outline 3.3.2 site values (QA approval of a GUIDANCE or EXAMPLE loosening); ADR 0008 decision 8; ST-01; IN-52'),
  ('POLICY_LOOSENING_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Policy version approved',
   'As approver, I approve this version of the policy switch and the loosening it makes.',
   array['MBR.APPROVE', 'RECORD.QA_REVIEW'], '{}', true, false, false, 'ALL_COMPONENTS', false,
   'Outline 3.5 (author and approver of each switch version, DI-09); L-25; INV-47');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Content providers (contract: esig 0200)
-- ---------------------------------------------------------------------------------------------

-- A source correction: the corrected document of <table>:<version>:<content hash>. Its publisher is
-- its author once it is published (INV-03); before that, market.publish_rule_table refuses a
-- publisher among the signers.
create function market.rule_correction_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  m      text[] := regexp_match(coalesce(p_id, ''), '^([a-z][a-z0-9]*):([1-9][0-9]{0,5}):([0-9a-f]{64})$');
  v      market.rule_table_version;
  v_cur  integer;
begin
  if m is null or m[2]::integer < 2 or not exists (select 1 from market.rule_table t where t.code = m[1]) then
    return '{"exists": false}'::jsonb;
  end if;
  select * into v from market.rule_table_version where table_code = m[1] and version = m[2]::integer;
  select max(x.version) into v_cur from market.rule_table_version x where x.table_code = m[1];
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('table', m[1], 'version', m[2], 'content_hash', m[3], 'change_kind', 'SOURCE_CORRECTION'),
    'state', case when v.id is null then case when m[2]::integer = coalesce(v_cur, 0) + 1 then 'PROPOSED' else 'NOT_NEXT' end
                  when encode(v.content_hash, 'hex') = m[3] and v.change_kind = 'SOURCE_CORRECTION' then 'PUBLISHED'
                  else 'SUPERSEDED' end,
    'entered_by', case when v.id is not null and encode(v.content_hash, 'hex') = m[3] then jsonb_build_array(v.published_by)
                       else '[]'::jsonb end);
end
$$;

-- A site-value loosening: <site>@<key>@<effective from>@<value departed from>@<new value>@<justification>
-- (market.site_loosening_ref, 0320). The authority of the signer is evaluated in the site's scope; the
-- person who recorded it is its author once it is recorded.
create function market.site_loosening_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  m        text[] := regexp_match(coalesce(p_id, ''),
                        '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@([a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)@([0-9]{4}-[0-9]{2}-[0-9]{2})@("[^"@\\]*"|true|false)@("[^"@\\]*"|true|false)@(.+)$');
  v_site   market.stub_site;
  v_from   date;
  v_by     jsonb;
begin
  if m is null or m[6] <> trim(m[6]) or market.table_of_key(m[2]) is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_from := market.parse_date(m[3]);
  select * into v_site from market.stub_site s where s.id = m[1]::uuid;
  if v_from is null or v_site.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select coalesce(jsonb_agg(distinct sv.recorded_by), '[]'::jsonb) into v_by
    from market.site_value sv
   where sv.site_id = v_site.id and sv.key = m[2] and sv.effective_from = v_from and sv.value = m[5]::jsonb
     and sv.resolution -> 'value' = m[4]::jsonb and sv.justification_ref = m[6] and sv.outcome = 'LOOSENED';
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('site_id', v_site.id, 'key', m[2], 'effective_from', m[3], 'departs_from', m[4]::jsonb,
                                  'value', m[5]::jsonb, 'justification_ref', m[6]),
    'state', case when jsonb_array_length(v_by) > 0 then 'RECORDED' else 'PROPOSED' end,
    'scope', jsonb_build_object('site', v_site.code),
    'entered_by', v_by);
end
$$;

-- A policy version: <policy>@<version>@<position>. Its author is its author once it is recorded.
create function market.policy_version_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  m      text[] := regexp_match(coalesce(p_id, ''), '^([A-Za-z0-9][A-Za-z0-9_.-]*)@([1-9][0-9]{0,8})@([A-Za-z0-9][A-Za-z0-9_.:+-]*)$');
  p      market.policy;
  v      market.policy_version;
  v_max  integer;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into p from market.policy where code = m[1];
  if p.code is null or market.position_rank(p.code, m[3]) is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into v from market.policy_version where policy_code = p.code and version = m[2]::integer;
  select max(x.version) into v_max from market.policy_version x where x.policy_code = p.code;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('policy_code', p.code, 'title', p.title, 'level', p.level, 'positions', p.positions,
                                  'loosening_requires', p.loosening_requires, 'version', m[2], 'position', m[3]),
    'state', case when v.id is null then case when m[2]::integer = coalesce(v_max, 0) + 1 then 'PROPOSED' else 'NOT_NEXT' end
                  when v.position = m[3] then 'RECORDED'
                  else 'SUPERSEDED' end,
    'entered_by', case when v.id is not null and v.position = m[3] then jsonb_build_array(v.author_person_id) else '[]'::jsonb end);
end
$$;

select esig.register_content_provider('market_rule_correction', 'market.rule_correction_content(text)',
                                      'a SOURCE_CORRECTION version of a market rule table: table, version and content hash (IN-52)');
select esig.register_content_provider('market_site_loosening', 'market.site_loosening_content(text)',
                                      'a site-value loosening: site, key, effective date, the value departed from, the new value, the justification (ST-01)');
select esig.register_content_provider('market_policy_version', 'market.policy_version_content(text)',
                                      'a version of a policy switch: policy, version number, position (DI-09, INV-47)');

reset role;
