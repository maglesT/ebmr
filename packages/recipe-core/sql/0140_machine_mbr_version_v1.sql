-- GENERATED from packages/recipe-core/src/lifecycle/machine.ts by packages/recipe-core/src/lifecycle/write-seeds.ts (kernel state.machineSeedSql). Do not edit.
-- Publishes machine mbr_version version 1 (aggregate type mbr_version).
-- A published version is immutable: change the machine by adding a new version and a new migration.
set local role ebmr_owner;

select platform.publish_machine_version($machine$
{
  "machine": "mbr_version",
  "version": 1,
  "aggregate_type": "mbr_version",
  "description": "MBR version life cycle: preparation, verification, independent check and QA approval (outline 5.2.1; ADR 0014)",
  "create_permission": "mbr.author",
  "initial": "DRAFT",
  "states": [
    "APPROVED",
    "CHECKED",
    "DRAFT",
    "IN_VERIFICATION",
    "RETIRED",
    "SUBMITTED",
    "WITHDRAWN"
  ],
  "final_states": [
    "RETIRED",
    "WITHDRAWN"
  ],
  "transitions": [
    {
      "from": "APPROVED",
      "event": "RETIRE",
      "to": "RETIRED",
      "guards": [
        "platform.reason_given",
        "mbr_version.no_open_authorisation"
      ],
      "signature": null,
      "permission": "mbr.approve"
    },
    {
      "from": "APPROVED",
      "event": "WITHDRAW",
      "to": "WITHDRAWN",
      "guards": [
        "platform.reason_given",
        "mbr_version.never_authorised"
      ],
      "signature": null,
      "permission": "mbr.approve"
    },
    {
      "from": "CHECKED",
      "event": "APPROVE",
      "to": "APPROVED",
      "guards": [
        "mbr_version.signed_in_state",
        "mbr_version.approver_independent",
        "mbr_version.regulatory_confirmed",
        "mbr_version.evidence_complete",
        "mbr_version.effective_date_set",
        "mbr_version.review_due_set",
        "mbr_version.change_control_complete",
        "mbr_version.registered_ranges_kept",
        "mbr_version.in_flight_dispositioned"
      ],
      "signature": "APPROVED",
      "permission": "mbr.approve"
    },
    {
      "from": "CHECKED",
      "event": "RETURN",
      "to": "DRAFT",
      "guards": [
        "platform.reason_given",
        "mbr_version.draft_entry_recorded"
      ],
      "signature": null,
      "permission": "mbr.approve"
    },
    {
      "from": "CHECKED",
      "event": "WITHDRAW",
      "to": "WITHDRAWN",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "mbr.approve"
    },
    {
      "from": "DRAFT",
      "event": "START_VERIFICATION",
      "to": "IN_VERIFICATION",
      "guards": [
        "mbr_version.content_present",
        "mbr_version.validator_passed"
      ],
      "signature": null,
      "permission": "mbr.author"
    },
    {
      "from": "DRAFT",
      "event": "WITHDRAW",
      "to": "WITHDRAWN",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "mbr.author"
    },
    {
      "from": "IN_VERIFICATION",
      "event": "RETURN",
      "to": "DRAFT",
      "guards": [
        "platform.reason_given",
        "mbr_version.draft_entry_recorded"
      ],
      "signature": null,
      "permission": "mbr.author"
    },
    {
      "from": "IN_VERIFICATION",
      "event": "SUBMIT",
      "to": "SUBMITTED",
      "guards": [
        "mbr_version.signed_in_state",
        "mbr_version.prepared_by_author",
        "mbr_version.evidence_complete",
        "mbr_version.change_record_linked",
        "mbr_version.critical_elements_risk_assessed"
      ],
      "signature": "PREPARED",
      "permission": "mbr.sign_prepared"
    },
    {
      "from": "IN_VERIFICATION",
      "event": "WITHDRAW",
      "to": "WITHDRAWN",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "mbr.author"
    },
    {
      "from": "SUBMITTED",
      "event": "CHECK",
      "to": "CHECKED",
      "guards": [
        "mbr_version.signed_in_state",
        "mbr_version.checker_independent"
      ],
      "signature": "CHECKED",
      "permission": "mbr.check"
    },
    {
      "from": "SUBMITTED",
      "event": "RETURN",
      "to": "DRAFT",
      "guards": [
        "platform.reason_given",
        "mbr_version.draft_entry_recorded"
      ],
      "signature": null,
      "permission": "mbr.check"
    },
    {
      "from": "SUBMITTED",
      "event": "WITHDRAW",
      "to": "WITHDRAWN",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "mbr.approve"
    }
  ],
  "definition_hash": "b7ecdfa2f5e95e536db1e1c78f7135b88aeed4b43fb2aecbd9da958ac9e36576"
}
$machine$::jsonb);

reset role;
