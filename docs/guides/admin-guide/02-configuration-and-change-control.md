# Configuration and change control

Configuration that can change how GMP work is done is under change control (DI-09). The database refuses a change of
such configuration unless the command names a configuration change record that QA approved for that area and that is
not closed yet (EBMR-CFG-001 to -004). The check is a trigger on each configuration table, so it holds for every writer,
today's and later ones. A software release writes its own configuration as the release, under the release's own change
control.

## The configuration areas

| Area | What it holds |
|---|---|
| `ROLE`, `ROLE_PERMISSION` | roles and the rights of each role |
| `IAM_POLICY`, `ESIG_POLICY` | password, session and signature policies |
| `ESIG_MEANING`, `DSC_MEANING`, `DSC_ANCHOR`, `DSC_ANCHOR_RETIREMENT` | signature meanings and digital signature certificate anchors |
| `PLATFORM_SETTING` | platform settings |
| `MARKET_POLICY`, `SITE_VALUE` | market policies and site values |
| `RBE_RULE` | review-by-exception rules |
| `RETENTION_RULE`, `RETENTION_RULE_SET` | retention of records |
| `CONTROLLED_PRODUCT` | the controlled-substance flag of products |
| `ANALYTICS_METHOD`, `ANALYTICS_REFERENCE` | analytics method versions and reference sets |
| `SYSTEM_DESCRIPTION` | the approved system description (the interfaces) |

## Making a change

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Raise a change record naming the areas it may change | `/config/change-records` | `CONFIG.CHANGE_RAISE` | none |
| Approve it (QA, not the person who raised it) | `/config/change-records` | `CONFIG.CHANGE_APPROVE` | `CONFIG_CHANGE_APPROVED` |
| Make the change, naming the change record | the screen or interface of the area | the area's right | as the area asks |
| Close the change record | `/config/change-records` | `CONFIG.CHANGE_CLOSE` | none |
| See the configuration of any past instant, and what changed between two | `/config/history` | `RECORD.READ` | none |

Every configuration row ever written is kept as a version with the instant it became valid and the change record it was
written under, so an inspector can see what was in force when any batch ran.

## Settings an administrator changes

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Change a platform setting | the platform interface | `PLATFORM.SETTINGS_CHANGE` | none |
| Change an identity or signature policy | the IAM interface | `IAM.POLICY_MANAGE` | none |
| Record the periodic review of the system (system owner) | the platform interface | `SYSTEM.PERIODIC_REVIEW` | none |
