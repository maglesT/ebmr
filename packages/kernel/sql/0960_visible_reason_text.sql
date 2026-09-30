-- Kernel, audit trail and state engine: a reason half says something a person can read (DI-22, DI-24;
-- EBMR-AUDIT-002; review findings V1 and P29, round-1 verification).
--
-- kernel.is_blank (0010) is the kernel's test of a blank reason half: the audit trigger refuses an UPDATE or
-- DELETE of an audited row when either half is blank by it (outline 5.4), and the state engine completes a blank
-- half of a transition's reason with a text of its own (platform.engine_reason, 0550). It matched
-- [[:space:]], which in this database's character classes (C.UTF-8) is ASCII white space only: a reason made of
-- no-break spaces, zero-width spaces, bidirectional marks or other characters that show nothing passed as text,
-- and the audit trail kept a "reason" nobody can read. records.is_blank (0400) repeated the same test for the
-- records module's own refusals.
--
-- The built-in guard platform.reason_given (0550), the reason guard of every life-cycle transition that needs a
-- reason, checked the reason code alone. A transition made with a code and a blank text passed it, and the
-- engine then wrote the text of the state row's audit entry itself ('RETURN: SUBMITTED -> DRAFT'). The person's
-- reason for the change was never recorded, only a description the system wrote so that the audit check passed.
--
-- From this migration on:
--   * kernel.is_blank counts a text as blank when it is NULL or holds nothing but characters that show nothing on
--     their own: the C0 and C1 controls, Unicode White_Space, the format characters (general category Cf: soft
--     hyphen, zero-width space and joiners, bidirectional marks and isolates, word joiner and the invisible
--     operators, byte order mark, interlinear annotation marks, the prepended number and end-of-verse marks,
--     Egyptian hieroglyph format controls, shorthand format controls, musical format characters, tags), the
--     default-ignorable code points (combining grapheme joiner, variation selectors, Hangul fillers, Khmer
--     inherent vowels, Mongolian variation selectors, the reserved default-ignorable ranges) and the Braille
--     blank. The class is written as explicit code points (Unicode 17 tables), so the answer never depends on
--     the database's locale or on a library's Unicode version. The execution engine holds the same class
--     (recipe-core engine guards.ts, isBlankText) and a test compares the two over every code point;
--   * records.is_blank is kernel.is_blank, so the records module refuses exactly what the audit trigger refuses;
--   * platform.reason_given refuses a transition unless the command carries a reason code AND a reason text,
--     neither blank by kernel.is_blank. It is registered again with a description that says so (the machines'
--     sealed hashes cover guard codes only, 0550 machine_canonical_text, so no published machine changes);
--   * platform.engine_reason (unchanged) completes only a half that is blank by kernel.is_blank. On a transition
--     guarded by platform.reason_given the guard has already refused any such half, with the same test on the same
--     validated context (platform.transition passes v_ctx to both), so the engine never writes any part of the
--     reason of a transition that needs one. Transitions that need no reason (a signed SUBMIT, CHECK or APPROVE,
--     a START_VERIFICATION) keep the completion: they are new events, not changes of recorded data.
--
-- Stricter only: every text blank before is blank now. Same signatures, volatility, owner, search_path and
-- privileges as 0010, 0400 and 0550 (kernel.is_blank executable by ebmr_app; records.is_blank and the guard private
-- to the owner); none is SECURITY DEFINER, as before. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- True when p is NULL or holds only characters that show nothing (see above). U+0000 cannot occur in a text value.
create or replace function kernel.is_blank(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p !~ '[^\u0001- \u007f- ­͏؀-؅؜۝܏࢐࢑࣢ᅟᅠ ឴឵᠋-᠏ -‏ -  -⁯⠀　ㅤ︀-️﻿ﾠ￰-￻\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]', true)
$$;

-- The records module's blank test is the kernel's (its refusals come first, with their own messages).
create or replace function records.is_blank(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select kernel.is_blank(p)
$$;

-- Built-in guard: the command carries the reason of the person who makes the transition, both halves.
create or replace function platform.guard_reason_given(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable set search_path = pg_catalog, pg_temp as $$
  select case when kernel.is_blank(p_actor ->> 'reason_code') or kernel.is_blank(p_actor ->> 'reason_text')
              then 'a reason is required for this transition: the reason code and the reason text of the person who makes it, '
                   'neither blank; the system writes no part of it (DI-22, DI-24; EBMR-AUDIT-002)' end
$$;
select platform.register_guard('platform.reason_given', 'platform.guard_reason_given(text, uuid, jsonb, jsonb, jsonb)',
  'The command states the reason of the person who makes the transition: a reason code and a reason text, neither blank (DI-22, DI-24)');

reset role;
