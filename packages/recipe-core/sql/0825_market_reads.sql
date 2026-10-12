-- Recipe core: the reads of the market tabs (Phase 4 slice 4a; contract ns/release.ts release.markets). Read-only
-- definers so the application role reads a lot's market changes (with the change record's number and the deviation's
-- reference) and its EU certifications (with the signing role) without grants on deviations or signatures.
--   recipe.lot_market_changes(lot) one row per signed change of a market of the lot or a batch of its records, oldest first.
--   recipe.lot_qp_certifications(lot) the EU certification register entries of the lot, oldest first.

set local role ebmr_owner;

create function recipe.lot_market_changes(p_lot uuid)
returns table (id uuid, change text, market text, subject_kind text, subject_id uuid, person_id uuid, us text, signature_id uuid, change_record text,
               deviation_ref text, removed_after_failure boolean, evaluation jsonb)
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select c.id, c.change, c.market, c.subject_kind, c.subject_id, c.person_id, (extract(epoch from c.recorded_at) * 1000000)::numeric(20, 0)::text, c.signature_id,
         (select r.number from recipe.change_record r where r.id = c.change_record_id), (select d.ref from site.deviation d where d.id = c.deviation_id),
         c.removed_after_failure, c.evaluation
    from recipe.market_change c
   where (c.subject_kind = 'LOT' and c.subject_id = p_lot) or (c.subject_kind = 'BATCH' and c.subject_id = any (recipe.release_batches(p_lot)))
   order by c.recorded_at, c.seq
$$;

-- The EU certification register entries of the lot, with the recorder's signing role and the transcription's checker.
create function recipe.lot_qp_certifications(p_lot uuid)
returns table (id uuid, source text, outcome text, certifier text, mia_number text, certified_us text, importer_code text, reference text, verified boolean,
               person_id uuid, source_role text, verified_by uuid, reason text)
language sql stable security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
  select c.id, c.source, c.outcome, c.certifier, c.mia_number, (extract(epoch from c.certified_at) * 1000000)::numeric(20, 0)::text, i.code, c.reference,
         (c.source <> 'TRANSCRIBED' or k.certification_id is not null), c.person_id,
         coalesce((select s.signer_role_code from esig.signature s where s.id = c.signature_id), ''), k.person_id, c.reason
    from recipe.qp_certification c left join recipe.eu_importer i on i.id = c.importer_id left join recipe.qp_transcription_check k on k.certification_id = c.id
   where c.lot_id = p_lot order by c.recorded_at, c.id
$$;

revoke all on function recipe.lot_market_changes(uuid), recipe.lot_qp_certifications(uuid) from public;
grant execute on function recipe.lot_market_changes(uuid), recipe.lot_qp_certifications(uuid) to ebmr_app;

reset role;
