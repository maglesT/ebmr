-- Phase 6 slice 6f: the pharmacopoeia edition review lists the master records too (IN-33, clause "mark IP 2026 effective;
-- all MBRs citing IP 2022 appear on the review list"; a slice 2a residual deferred to Phase 6 by decision 0011).
--
-- Handbook: modules/recipe-core.md
--
-- Schedule M and the Drugs Rules (paraphrased): a product is tested to the pharmacopoeia edition in force; a new edition
-- triggers a review of every limit taken from the old one. site.specification_edition_review (site services 0840)
-- lists the specifications; the limits of an MBR (parameter limit ranges, calculation limits and the criteria of
-- acceptance schemes, each with `pharmacopoeia: {code, edition}`, recipe-core src/limits/model.ts) were not listed.
--
--   recipe.mbr_edition_citations(content)  every object of an MBR's content that cites a pharmacopoeia edition: the
--                                          cited object's id (or title) and the code and edition.
--   recipe.mbr_edition_review()            the MBR versions not RETIRED or WITHDRAWN whose content cites a recorded edition
--                                          older than the one effective now for its pharmacopoeia (the same rule as the
--                                          specifications: an edition not recorded yet is never listed as older):
--                                          [{familyId, familyCode, productCode, versionId, versionNumber, state, citedIn,
--                                            pharmacopoeia, cited, effective}].

set local role ebmr_owner;

create function recipe.mbr_edition_citations(p_content jsonb)
returns table (cited_in text, pharmacopoeia text, edition text)
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select distinct coalesce(o ->> 'id', o ->> 'title', o ->> 'name', '(unnamed)'), o -> 'pharmacopoeia' ->> 'code', o -> 'pharmacopoeia' ->> 'edition'
    from jsonb_path_query(coalesce(p_content, '{}'::jsonb), 'strict $.** ? (@.type() == "object" && exists(@.pharmacopoeia.code) && exists(@.pharmacopoeia.edition))') as q(o)
$$;

create function recipe.mbr_edition_review() returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with current_edition as (
    select distinct on (e.pharmacopoeia) e.pharmacopoeia, e.edition, e.effective_from
      from site.pharmacopoeia_edition e where e.effective_from <= clock_timestamp()
     order by e.pharmacopoeia, e.effective_from desc, e.recorded_at desc
  ), live as (
    select v.id, v.family_id, v.version_number, recipe.version_state(v.id) as state, (recipe.current_content(v.id)).content as content
      from recipe.mbr_version v
     where coalesce(recipe.version_state(v.id), 'DRAFT') not in ('RETIRED', 'WITHDRAWN')
  )
  select coalesce(jsonb_agg(jsonb_build_object('familyId', f.id, 'familyCode', f.code, 'productCode', f.product_code,
                                               'versionId', l.id, 'versionNumber', l.version_number, 'state', l.state,
                                               'citedIn', ci.cited_in, 'pharmacopoeia', ci.pharmacopoeia, 'cited', ci.edition,
                                               'effective', c.edition)
                            order by f.code collate "C", l.version_number, ci.cited_in collate "C"), '[]'::jsonb)
    from live l
    join recipe.mbr_family f on f.id = l.family_id
    cross join lateral recipe.mbr_edition_citations(l.content) ci
    join current_edition c on c.pharmacopoeia = ci.pharmacopoeia and c.edition <> ci.edition
    join site.pharmacopoeia_edition cited on cited.pharmacopoeia = ci.pharmacopoeia and cited.edition = ci.edition
   where cited.effective_from < c.effective_from
$$;

revoke all on function recipe.mbr_edition_citations(jsonb), recipe.mbr_edition_review() from public;
grant execute on function recipe.mbr_edition_citations(jsonb), recipe.mbr_edition_review() to ebmr_app;

reset role;
