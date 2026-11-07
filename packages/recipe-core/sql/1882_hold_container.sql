-- Plant, output containers: the quality unit holds a container of its own decision (API plan A4c, lead decision of
-- 7 November; controls AS-21, L-30, TB-11, DI-17, DI-18, DI-22).
-- Handbook: modules/recipe-core.md
--
-- Why. Until now a container reached HELD only through plant.apply_hold, when a failing or missed in-process check of a
-- press covered its open interval (0422, 0541), under the floor's right (machine output_container v1, HOLD, permission
-- step.execute). A closed container that no press check covers, such as the mother liquor of an API batch, therefore
-- never reached HELD, so QA could never release it (plant.release_container: HELD or SORTED -> RELEASED_BY_QA), and a
-- later batch's G-24@2 step of case RECOVERY could never take it (recipe.source_container_facts, 0621: RECOVERY is a
-- container RELEASED_BY_QA). Recovery from mother liquor (ICH Q7 14.40, 14.43) could not be recorded.
--
-- Basis. ICH Q7 2.22 lists among the quality unit's own responsibilities the release or rejection of materials and
-- intermediates; Q7 8.17 and 14.10 want material that is not yet dispositioned, or that fails, identified and kept
-- under quarantine control until the quality unit decides. A hold is that quarantine, the release its decision.
--
-- What:
--   * machine output_container version 2 (1881_machine_output_container_v2.sql, generated from
--     src/containers/machine.ts): version 1 and the event QA_HOLD, CLOSED or RELEASED_BY_QA -> HELD, permission
--     qa.floor_approve, guard platform.reason_given. A published version is immutable, so the event is a new version;
--     a container follows the version it was opened under (ADR 0010), so containers opened before 1881 keep v1 and
--     cannot be held by QA (the engine refuses the event, EBMR-PLAT-067; the screen does not offer it).
--   * plant.hold_container(container, expected version): QA.FLOOR_APPROVE in the container's product scope (the right
--     plant.release_container and plant.reject_container ask), through plant.dispose_container and the state engine.
--
-- The record. The engine's insert-only, audited platform.state_history row is the hold's record: event QA_HOLD, the
-- person, account and role, the permission, the database time and the person's reason code and text (from the command
-- context, as for SORT and REJECT). plant.container_hold is not used: each of its rows names the in-process check that
-- held the container (ipc_check_id is not null), and a QA hold has none; no column is added to that audited table.
--
-- Refusals. No new message: every one is an existing refusal the engine or the record needs.
--   * an administrator: iam.assert_not_administrator (DI-18);
--   * an unknown container: EBMR-CNT-030 (plant.dispose_container), the record names an existing container;
--   * a person without QA.FLOOR_APPROVE: EBMR-IAM-040 (DI-17), the hold is the quality unit's act;
--   * a stale version or a state with no QA_HOLD (OPEN, HELD, SORTED, REJECTED, or a v1 container): EBMR-PLAT-066/067,
--     the engine's state machine;
--   * no reason code or text: EBMR-PLAT-068 (platform.reason_given, DI-22), the record must say why it is held.
-- What a QA hold leaves unchanged: plant.container_usable_problem keeps a HELD container out of use until QA releases
-- it, and plant.container_release_problem (0741) has no in-process hold to explain for it, so QA releases it under its
-- OUTPUT_CONTAINER_RELEASED signature once a typed net is verified (0740).
--
-- Owned by ebmr_owner, pg_temp last (ADR 0016). Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

create function plant.hold_container(p_container uuid, p_expected_version bigint) returns jsonb
language sql volatile security definer set search_path = pg_catalog, plant, pg_temp as $$
  select plant.dispose_container(p_container, 'QA_HOLD', 'QA.FLOOR_APPROVE', p_expected_version, '{}'::jsonb)
$$;
revoke all on function plant.hold_container(uuid, bigint) from public;
grant execute on function plant.hold_container(uuid, bigint) to ebmr_app;

reset role;
