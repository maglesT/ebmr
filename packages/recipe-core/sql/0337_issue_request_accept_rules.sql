-- Recipe core, execution store (module C3): a test batch is issued only with a request its MBR accepts, as the engine
-- checks it at issue (Phase 2 exit review F12, the round-6 verification, found while closing it: lane round 1 of round
-- 5; DI-05, DI-10, DI-34; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- recipe.issue_execution (0270, 0298) binds an issue request's batch id, batch number and issuer to the command, and
-- recipe-core 0335 now holds it to the members of the engine's IssueRequest. The values the engine reads against the
-- MBR at issue (engine batch.ts initialState: ENG-ISSUE-SIZE, ENG-ISSUE-MARKETS, ENG-ISSUE-VARIANT, ENG-ISSUE-INPUT)
-- were read by nothing in the database; the release gate's replay re-issues the batch, but until then the request is
-- part of the test run's record (recipe.batch_execution.issue_request and the ISSUE row's command; batch_size and
-- market_set are copied from it). Through the application role, with the engine's state of an honest request, a
-- batch was issued (apps/tablets-server/test/execution/db-guards-row-shape.test.ts, round 7, the issue-request test)
-- whose request named the real-format lot number L2409-0017 as its batch size, as a market, as a variant or a
-- variant's choice, or as an input of its header, and one whose input had another type than the MBR declares.
--
-- What changed (trigger ae_execution_issue_request on recipe.batch_execution, before insert or update of
-- issue_request, after 0335's ad_execution_policy_shape; EBMR-EXE-126): recipe.issue_request_problem applies the engine's
-- issue rules that read only the MBR content and the request: the batch size is one of the MBR's approved sizes; the
-- market set holds IN and only markets the MBR is approved for; every variant of the MBR has one of its values, and no
-- other variant is named; every header and master-data input of the MBR is given with a source that is not blank and a
-- value of its declared type (a decimal written as a decimal, a whole count, a category of its list, true or false, a
-- text, an instant), and no other input is given. Not read here (decision F12.5): a decimal input's unit (the engine
-- converts it; the replay re-issues), an input's source text and a TEXT input's value, which are free text.
--
-- The new functions are owned by ebmr_owner and private to it; the trigger function is SECURITY DEFINER; both pin their
-- search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- DI-05, DI-10, DI-34 (F12, round-6 verification): why issue request p_request is not one MBR content p_content accepts
-- (header); NULL when it is. Its members and their JSON types are 0335's.
create function recipe.issue_request_problem(p_content jsonb, p_request jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  h        jsonb := case when jsonb_typeof(p_content -> 'header') = 'object' then p_content -> 'header' else '{}'::jsonb end;
  sizes    jsonb := case when jsonb_typeof(h -> 'batchSizes') = 'array' then h -> 'batchSizes' else '[]'::jsonb end;
  markets  jsonb := case when jsonb_typeof(h -> 'marketSet') = 'array' then h -> 'marketSet' else '[]'::jsonb end;
  variants jsonb := case when jsonb_typeof(h -> 'variants') = 'array' then h -> 'variants' else '[]'::jsonb end;
  inputs   jsonb := case when jsonb_typeof(p_content -> 'inputs') = 'array' then p_content -> 'inputs' else '[]'::jsonb end;
  r_set    jsonb := case when jsonb_typeof(p_request -> 'marketSet') = 'array' then p_request -> 'marketSet' else '[]'::jsonb end;
  r_var    jsonb := case when jsonb_typeof(p_request -> 'variants') = 'object' then p_request -> 'variants' else '{}'::jsonb end;
  r_in     jsonb := case when jsonb_typeof(p_request -> 'inputs') = 'object' then p_request -> 'inputs' else '{}'::jsonb end;
  v        jsonb;
  g        jsonb;
  k        text;
  ok       boolean;
begin
  if not exists (select 1 from jsonb_array_elements(sizes) b where b -> 'id' = p_request -> 'batchSize') then
    return format('the batch size %s is not one of the approved sizes of its MBR (ENG-ISSUE-SIZE)', coalesce(left(p_request ->> 'batchSize', 64), '(none)'));
  end if;
  if not (r_set @> '["IN"]'::jsonb) then
    return 'its market set does not hold India (IN), which every market set holds (ENG-ISSUE-MARKETS)';
  end if;
  select min(m.v #>> '{}' collate "C") into k from jsonb_array_elements(r_set) m (v) where not (markets @> jsonb_build_array(m.v));
  if k is not null then
    return format('its market set names %s, a market its MBR is not approved for (ENG-ISSUE-MARKETS)', left(k, 64));
  end if;
  for v in select x from jsonb_array_elements(variants) x order by x ->> 'id' collate "C" loop
    if not (jsonb_typeof(r_var -> (v ->> 'id')) = 'string' and coalesce((v -> 'values') @> jsonb_build_array(r_var -> (v ->> 'id')), false)) then
      return format('variant %s of its MBR is not given one of its values (ENG-ISSUE-VARIANT)', v ->> 'id');
    end if;
  end loop;
  select min(x collate "C") into k from jsonb_object_keys(r_var) x where not exists (select 1 from jsonb_array_elements(variants) y where y ->> 'id' = x);
  if k is not null then
    return format('it names %s, which is not a variant of its MBR (ENG-ISSUE-VARIANT)', left(k, 64));
  end if;
  for v in select x from jsonb_array_elements(inputs) x order by x ->> 'id' collate "C" loop
    g := r_in -> (v ->> 'id');
    if jsonb_typeof(g) is distinct from 'object' then
      return format('input %s of its MBR is not given (ENG-ISSUE-INPUT)', v ->> 'id');
    end if;
    if jsonb_typeof(g -> 'source') is distinct from 'string' or recipe.js_trim(g ->> 'source') = '' then
      return format('input %s is given without its source (ENG-ISSUE-INPUT)', v ->> 'id');
    end if;
    ok := case v ->> 'valueType'
      when 'DECIMAL' then g -> 'value' ->> 'kind' = 'DECIMAL' and jsonb_typeof(g -> 'value' -> 'value') = 'string'
                          and (g -> 'value' ->> 'value') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' and (g -> 'value' ->> 'value') !~ '^-0(\.0+)?$'
      when 'COUNT' then g -> 'value' ->> 'kind' = 'COUNT' and jsonb_typeof(g -> 'value' -> 'value') = 'string' and (g -> 'value' ->> 'value') ~ '^(0|[1-9][0-9]*)$'
      when 'BOOLEAN' then g -> 'value' ->> 'kind' = 'BOOLEAN'
      when 'CATEGORY' then g -> 'value' ->> 'kind' = 'CATEGORY' and jsonb_typeof(g -> 'value' -> 'value') = 'string'
                           and coalesce((v -> 'categories') @> jsonb_build_array(g -> 'value' -> 'value'), false)
      when 'TEXT' then g -> 'value' ->> 'kind' = 'TEXT'
      when 'INSTANT' then g -> 'value' ->> 'kind' = 'INSTANT'
      else false
    end;
    if ok is not true then
      return format('input %s is not given as its declared type %s (ENG-ISSUE-INPUT)', v ->> 'id', coalesce(v ->> 'valueType', '(none)'));
    end if;
  end loop;
  select min(x collate "C") into k from jsonb_object_keys(r_in) x where not exists (select 1 from jsonb_array_elements(inputs) y where y ->> 'id' = x);
  if k is not null then
    return format('it gives %s, which is not a header or master-data input of its MBR (ENG-ISSUE-INPUT)', left(k, 64));
  end if;
  return null;
end
$$;

-- DI-05, DI-10, DI-34: a test batch is issued only with a request its MBR accepts (header). EBMR-EXE-126. Raises; returns
-- the row.
create function recipe.execution_issue_request_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_content jsonb;
  v_problem text;
begin
  select pk.content into v_content from recipe.test_package pk where pk.package_hash = new.package_hash;
  v_problem := recipe.issue_request_problem(v_content, new.issue_request);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The issue request of test batch %s cannot be recorded: %s. A batch is issued only with a request its MBR accepts, as the engine checks it at issue, so nothing sits in the record unread (DI-05, DI-10, DI-34). [EBMR-EXE-126]',
                       new.batch_number, v_problem);
  end if;
  return new;
end
$$;

create trigger ae_execution_issue_request before insert or update of issue_request on recipe.batch_execution
  for each row execute function recipe.execution_issue_request_check();

revoke all on function recipe.issue_request_problem(jsonb, jsonb), recipe.execution_issue_request_check() from public;

reset role;
