-- Injectables plan I-0 (docs/build-plan/injectables/platform-fit.md; ADR 0001 amendment of 4 November 2026): on the
-- platform one database holds every edition, and the edition is data. A library block belongs to an edition: the
-- definition's own `edition` member (generic, tablets or injectables), or tablets when it names none, as every block was
-- before. The member sits inside the definition, so the content hash QA approves covers it (PR-05).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.library_block_edition(definition)        the edition of a definition: its member, or 'tablets'
--   recipe.library_edition_problem(content, edition) NULL, or the first block snapshot of the master whose edition is
--                                                   neither 'generic' nor the master's own edition
--   check library_block_edition                     a stored definition names a known edition (EBMR-LIB-023 at draft
--                                                   through the check below; the constraint keeps the table's shape)
--   trigger a4b_library_edition_at_approval         QA's approval of a master is refused while a block of another
--                                                   edition is in it (EBMR-LIB-024; PR-05)
--
-- A later edition (the API edition's `substance`) replaces the constraint and recipe.library_editions() in its own
-- migration; nothing else names the list.

set local role ebmr_owner;

create function recipe.library_editions() returns text[]
language sql immutable set search_path = pg_catalog as $$ select array['generic', 'tablets', 'injectables'] $$;

create function recipe.library_block_edition(p_definition jsonb) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(p_definition -> 'edition') = 'string' then p_definition ->> 'edition' else 'tablets' end
$$;

alter table recipe.library_block
  add constraint library_block_edition check (recipe.library_block_edition(definition) = any (recipe.library_editions()));

-- The draft refuses an unknown edition with its own message (the constraint alone would give a bare check violation).
create function recipe.library_block_edition_check() returns trigger
language plpgsql set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if not (recipe.library_block_edition(new.definition) = any (recipe.library_editions())) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LIB-023 the block %s names the edition %s; it is one of %s', new.code,
                       new.definition -> 'edition', array_to_string(recipe.library_editions(), ', '));
  end if;
  return new;
end
$$;

create trigger a0_library_block_edition before insert on recipe.library_block for each row execute function recipe.library_block_edition_check();

create function recipe.library_edition_problem(p_content jsonb, p_edition text) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  d jsonb;
  e text;
begin
  for d in select x from jsonb_array_elements(case when jsonb_typeof(p_content -> 'blockDefinitions') = 'array' then p_content -> 'blockDefinitions' else '[]'::jsonb end) x loop
    e := recipe.library_block_edition(d);
    if e <> 'generic' and e is distinct from p_edition then
      return format('%s@%s belongs to the %s edition and this master to the %s edition', d ->> 'code', d ->> 'version', e, coalesce(p_edition, 'unknown'));
    end if;
  end loop;
  return null;
end
$$;

create function recipe.library_edition_at_approval_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_edition text;
  v_prob    text;
begin
  if new.aggregate_type = 'mbr_version' and new.event = 'APPROVE' then
    select f.edition into v_edition from recipe.mbr_version v join recipe.mbr_family f on f.id = v.family_id where v.id = new.aggregate_id;
    v_prob := recipe.library_edition_problem((recipe.current_content(new.aggregate_id)).content, v_edition);
    if v_prob is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-LIB-024 this master cannot be approved: %s (PR-05; ADR 0001 amendment)', v_prob);
    end if;
  end if;
  return new;
end
$$;

create trigger a4b_library_edition_at_approval before insert on platform.state_history for each row execute function recipe.library_edition_at_approval_check();

revoke all on function recipe.library_block_edition_check(), recipe.library_edition_problem(jsonb, text), recipe.library_edition_at_approval_check() from public;
grant execute on function recipe.library_editions(), recipe.library_block_edition(jsonb) to ebmr_app;

reset role;
