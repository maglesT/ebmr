-- Recipe core: the batch side names its GMP batches and output containers to site services (Phase 3 slice 5a-0; site
-- services 0730 site.subject_resolver). Site services is applied before recipe-core and never reads its tables, so the
-- deviation-lite links, the deviation reference check (site.deviation_ref_problem) and the QC extra-testing decision
-- learn a batch's number, edition, site, product and strength through this resolver.
--
-- recipe.site_subject_identity(kind, id) returns {batchId, batchNumber, edition, siteCode, productCode, strength, ref}:
--   BATCH      a planned or issued GMP batch: the stub batch linked to its register allocation (recipe-core 0500), the
--              allocation's number, edition and site, the family's product and strength;
--   CONTAINER  an output container (recipe-core 0420) of such a batch, ref = its label code;
-- NULL for anything else (a sandbox test run among them: sandbox runs keep reference-only links, D-S5-2, DI-05).

set local role ebmr_owner;

create function recipe.site_subject_identity(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, site, pg_temp as $$
declare
  v_batch uuid := p_id;
  v_ref   text;
  v       jsonb;
begin
  if p_kind = 'CONTAINER' then
    select c.batch_id, c.label_code into v_batch, v_ref from plant.output_container c where c.id = p_id;
    if v_batch is null then
      return null;
    end if;
  elsif p_kind is distinct from 'BATCH' then
    return null;
  end if;
  select jsonb_build_object('batchId', b.id, 'batchNumber', a.batch_number, 'edition', a.edition, 'siteCode', a.site_code,
                            'productCode', f.product_code, 'strength', f.strength, 'ref', coalesce(v_ref, a.batch_number))
    into v
    from recipe.stub_batch b
    join recipe.batch_allocation_link l on l.batch_id = b.id
    join site.batch_number_allocation a on a.id = l.allocation_id
    join recipe.mbr_family f on f.id = b.family_id
   where b.id = v_batch;
  return v;
end
$$;

select site.register_subject_resolver('recipe.site_subject_identity(text, uuid)');

reset role;
