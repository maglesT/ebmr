-- ST-29 layering (injectables review pass, I-6): the APS list of a change record reaches QA's signed content through the
-- e-signature content-provider registry instead of a replaced kernel function. Tablets 1910 replaced the kernel's
-- platform.change_record_content (kernel 1195) with a copy that reads plant.aps_required_line, so a kernel function read
-- a module's table and a later kernel change to 1195's content would silently be lost under the copy. The kernel already
-- offers the seam: esig.provide calls whichever function is registered for an aggregate type (kernel 0200), the same
-- pattern as the SCOPE hook of ADR-0018 (one per database; a module composes on the kernel's answer).
--
-- Handbook: modules/tablets-server.md
--
--   platform.change_record_content(id)
--                             restored to kernel 1195's body exactly (number, title, description, areas, raiser): the
--                             kernel reads only its own tables again.
--   plant.change_record_content(id)
--                             the provider of aggregate config_change_record from now on: the kernel's answer, with the
--                             listed units (aps_lines, sorted codes) added to its content only when there are some, as
--                             1910 did. The output is the same, key for key, so the content hash of every signature
--                             already given is unchanged (INV-09) and a list changed after QA's signature still fails it.

set local role ebmr_owner;

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
    'content', jsonb_build_object('number', r.number, 'title', r.title, 'description', r.description, 'areas', to_jsonb(r.areas),
                                  'raised_by', r.raised_by_person, 'raised_at', to_char(r.raised_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'state', platform.change_record_state(r.id),
    'entered_by', jsonb_build_array(r.raised_by_person));
end
$$;

create function plant.change_record_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  v_out   jsonb := platform.change_record_content(p_id);
  v_lines jsonb;
begin
  if (v_out ->> 'exists')::boolean then
    select jsonb_agg(e.code order by e.code) into v_lines
      from plant.aps_required_line a join plant.equipment e on e.id = a.equipment_id
      join platform.change_record c on c.id = a.change_record_id
     where c.number = p_id;
    if v_lines is not null then
      v_out := jsonb_set(v_out, '{content}', (v_out -> 'content') || jsonb_build_object('aps_lines', v_lines));
    end if;
  end if;
  return v_out;
end
$$;

select esig.register_content_provider('config_change_record', 'plant.change_record_content(text)',
  'Configuration change record (DI-09): number, title, description, areas and who raised it; the units it requires an APS for (ST-29)');

revoke all on function plant.change_record_content(text) from public;
grant execute on function plant.change_record_content(text) to ebmr_app;

reset role;
