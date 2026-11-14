-- ST-29 layering (injectables review pass, I-6, item 2; lead's option (a), 14 November 2026): the APS list of a change
-- record reaches QA's signed content through a kernel content extension (kernel 1407) instead of a replaced kernel
-- function. Tablets 1910 replaced the kernel's platform.change_record_content with a copy that reads
-- plant.aps_required_line; on a fresh installation that copy also replaces kernel 1407's definition, since the kernel's
-- migrations run first. The provider row of config_change_record (the kernel's function) is not touched.
-- From here on, 1910 no longer defines the final text of the kernel function: this file and kernel 1407 do, and a fresh
-- installation and an upgrade end with the same body (tools/drills/test/content-extension-upgrade.test.ts).
--
-- Handbook: modules/tablets-server.md
--
--   platform.change_record_content(id)
--                             restored to kernel 1407's definition exactly (1195's content, passed through
--                             esig.extend_content): the kernel reads only its own tables again.
--   plant.change_record_aps_lines(id)
--                             the content extension aps_lines of config_change_record: {"aps_lines": [sorted codes]} when
--                             the record lists units, {} otherwise. The merged content is 1910's, key for key, so the
--                             content hash of every signature already given is unchanged (INV-09) and a list changed after
--                             QA's signature still fails it.

set local role ebmr_owner;

-- Kernel 1195's provider, its content passed through the extensions registered for config_change_record.
create or replace function platform.change_record_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  r platform.change_record;
begin
  select * into r from platform.change_record c where c.number = p_id;
  if r.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', esig.extend_content('config_change_record', r.number,
                 jsonb_build_object('number', r.number, 'title', r.title, 'description', r.description, 'areas', to_jsonb(r.areas),
                                    'raised_by', r.raised_by_person, 'raised_at', to_char(r.raised_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
    'state', platform.change_record_state(r.id),
    'entered_by', jsonb_build_array(r.raised_by_person));
end
$$;

-- The units a change record requires an APS for, sorted by code, as the keys its signed content gains.
create function plant.change_record_aps_lines(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
  select coalesce((select jsonb_build_object('aps_lines', jsonb_agg(e.code order by e.code))
                     from plant.aps_required_line a join plant.equipment e on e.id = a.equipment_id
                     join platform.change_record c on c.id = a.change_record_id
                    where c.number = p_id
                   having count(*) > 0), '{}'::jsonb)
$$;

revoke all on function plant.change_record_aps_lines(text) from public;

select esig.register_content_extension('config_change_record', 'aps_lines', 'plant.change_record_aps_lines(text)',
  'The units the change requires an APS for (ST-29, tablets 1910): their codes, sorted');

reset role;
