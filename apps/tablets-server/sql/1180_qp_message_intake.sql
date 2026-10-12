-- Tablets: the intake of a structured EU certification message (Phase 4 slice 4a; DI-39; recipe-core 0824).
--   tab.take_qp_certification_message(message text, signature text) returns jsonb   granted to the application role: the
--   message is the JSON text exactly as received, the signature its Ed25519 signature (base64, 64 bytes) by the key of
--   the importer the message names (recipe.eu_importer). The signature is verified here, in the database
--   (tab.ed25519_verify, tablets 0270), and the message is handed with the verdict to recipe.take_qp_message (owner only),
--   which acknowledges every message, ACCEPTED or REFUSED with its reason. The answer is that acknowledgement.

set local role ebmr_owner;

create function tab.take_qp_certification_message(p_message text, p_signature text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  m     jsonb;
  v_key bytea;
  v_sig bytea;
  v_ok  boolean := false;
begin
  begin
    m := p_message::jsonb;
  exception when others then
    m := null;
  end;
  if jsonb_typeof(m) = 'object' then
    select i.public_key into v_key from recipe.eu_importer i where i.code = m ->> 'importerCode';
  end if;
  begin
    v_sig := decode(coalesce(p_signature, ''), 'base64');
  exception when others then
    v_sig := null;
  end;
  if v_key is not null and v_sig is not null and length(v_sig) = 64 then
    v_ok := coalesce(tab.ed25519_verify(v_key, convert_to(p_message, 'UTF8'), v_sig), false);
  end if;
  return recipe.take_qp_message(p_message, v_ok);
end
$$;

revoke all on function tab.take_qp_certification_message(text, text) from public;
grant execute on function tab.take_qp_certification_message(text, text) to ebmr_app;

reset role;
