-- One version in preparation per MBR family (owner decision, 13 November 2026; demo report r13 bug 2; PR-06).
--
-- Since the designer derives the next version of an approved master on screen (designer.deriveVersion), a family must
-- not hold two competing versions in preparation: two drafts of one master, each approved on its own, would each claim
-- to be the change of the same baseline. The server already refuses a second one (409 DESIGNER_OPEN_VERSION, with the
-- open version named); from this migration on the database refuses it for every writer.
--
-- recipe.insert_version, shared by recipe.create_version and recipe.derive_version, now refuses a new version while
-- the family has a version in DRAFT, IN_VERIFICATION, SUBMITTED or CHECKED (EBMR-RCP-436). The check runs after the
-- family row lock the function already takes, so two concurrent creations cannot both pass it. A WITHDRAWN version is
-- not open; an APPROVED or RETIRED one is not in preparation.
--
-- Existing data: the rule only governs new versions. No row is changed or deleted. A family that already holds two
-- open versions (none is known on the demo; the copy-to-a-new-family workaround made separate families) keeps them,
-- and takes no further version until one of them is approved or withdrawn (return to DRAFT, then discard).
--
-- Apart from the check, recipe.insert_version is exactly as in 0150 (same signature, owner, SECURITY DEFINER,
-- search_path and privileges: CREATE OR REPLACE keeps them). Applied as a new migration because applied migrations
-- are checksummed and never edited.

set local role ebmr_owner;

create or replace function recipe.insert_version(p_family uuid, p_derived_from uuid, p_content jsonb, p_content_hash text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, platform, kernel, pg_temp as $$
declare
  v_id     uuid := gen_random_uuid();
  v_number integer;
  v_state  jsonb;
  v_open   record;
begin
  perform 1 from recipe.mbr_family where id = p_family for update;
  select v.version_number, recipe.version_state(v.id) as state into v_open
    from recipe.mbr_version v
   where v.family_id = p_family and recipe.version_state(v.id) in ('DRAFT', 'IN_VERIFICATION', 'SUBMITTED', 'CHECKED')
   order by v.version_number
   limit 1;
  if found then
    raise exception using errcode = 'P0001',
      message = format('Version %s of this family is still in preparation (%s): a family has one version in preparation at a time; '
                       'continue that version, or return it to DRAFT and discard it, before starting another (PR-06; EBMR-RCP-436)',
                       v_open.version_number, v_open.state);
  end if;
  v_number := coalesce((select max(version_number) from recipe.mbr_version where family_id = p_family), 0) + 1;
  insert into recipe.mbr_version (id, family_id, version_number, author_person, author_account, derived_from)
  values (v_id, p_family, v_number, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', p_derived_from);
  insert into recipe.mbr_draft_entry (version_id, cycle, person_id, account_id, xact_id)
  values (v_id, 1, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 0);
  insert into recipe.mbr_content (version_id, revision, content, content_hash, reason, edited_by_person, edited_by_account)
  values (v_id, 1, p_content, p_content_hash, p_reason, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');
  v_state := platform.create_aggregate_state('mbr_version', 'mbr_version', v_id);
  return jsonb_build_object('version_id', v_id, 'version_number', v_number, 'content_hash', p_content_hash,
                            'state', v_state ->> 'state', 'state_version', (v_state ->> 'version')::bigint);
end
$$;

reset role;
