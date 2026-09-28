-- Recipe core: the fixed reason of a life-cycle update never stands in for half of the command's own
-- reason (DI-22, DI-24; EBMR-AUDIT-002).
--
-- The kernel's audit trigger (kernel 0010) refuses an UPDATE or DELETE of an audited row unless the command
-- context carries a reason code and a reason text, neither of them blank (outline 5.4: both halves for every
-- change after first entry). recipe.push_reason (0100) completes the reason of a life-cycle update made by
-- recipe code (a draft attribute of an MBR version, 0150; an authorisation cell superseded or ended, 0160;
-- a stub batch issued or moved on, 0170) with a fixed reason naming the act, and only when the command gave
-- no reason code: a command that gives its own reason code owns its reason and gives the text as well.
--
-- What changes here is one case of a command WITHOUT a reason code. 0100 then replaced the whole reason, so
-- a reason text the user did give was dropped from the audit entry. Now:
--   - the command gave no reason code (NULL or empty, exactly the test of 0100): the fixed code naming the act
--     is used, with the command's own reason text where it gave one and the fixed text where it did not;
--   - the command gave anything else as its reason code, a code of only white space included: nothing is
--     completed. A code of only white space is blank (kernel.is_blank) and a blank reason text stays blank,
--     so the kernel refuses the update (EBMR-AUDIT-002). The system never overwrites a code the command sent,
--     never writes a text next to the user's code as if it were the user's reason, and never lets a command
--     that sent a malformed reason through with both halves written by the system.
-- The completed context is installed with kernel.set_actor_context only when it differs from the validated
-- context. The validated context from before the switch is returned, and recipe.restore_actor re-installs
-- it with kernel.set_actor_context (never set_config), so the command's own context is again the one most
-- recently installed and the only one that counts. A completed reason never outlives the act it names.
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- The command's validated context, completed with the fixed reason (p_code, p_text) of the act when the
-- command gave no reason code (NULL or empty); returns the context as it was before, for recipe.restore_actor.
create or replace function recipe.push_reason(p_code text, p_text text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
declare
  v     jsonb := recipe.require_actor();  -- kernel.current_actor(): the validated context
  v_new jsonb := v;
begin
  -- Only a code the command did not give at all (NULL or empty, as 0100) is completed; a code of only white
  -- space is left as sent, and the audit trigger refuses it (EBMR-AUDIT-002).
  if coalesce(v ->> 'reason_code', '') = '' then
    v_new := v_new || jsonb_build_object('reason_code', p_code);
    if kernel.is_blank(v ->> 'reason_text') then
      v_new := v_new || jsonb_build_object('reason_text', p_text);
    end if;
  end if;
  if v_new is distinct from v then
    perform kernel.set_actor_context(v_new);
  end if;
  return v;
end
$$;

-- Privileges are kept by CREATE OR REPLACE: push_reason stays private to the owner (0100).

reset role;
