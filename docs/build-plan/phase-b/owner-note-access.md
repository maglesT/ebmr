# Owner note: access on the platform (Batchwright Phase B)

For the owner, through the lead, 3 Nov 2026. No control in `compliance/controls/` is edited and no `expert_decision`
is touched. This note records what changes and why, for the owner to accept.

## 1. Grants are site-wide on the platform

Today a Batchwright role grant can be limited to a site, an area or a product (`iam.role_grant` scope). For example,
an operator can be granted only for the granulation area or only for one product. Platform permission codes are
held per person and per product, with no scope (platform D-16). On the platform, a person holding
`ebmr.step.execute` may therefore execute steps in every area and for every product of the site.

- **What still limits people:**
  - each person's training and qualification gates, checked at every action as today (DI-17, PR-15, IN-04);
  - segregation by person (DI-35, ESIG-042, EBMR-LIB-007);
  - the room, line-clearance and status interlocks, which do not depend on grants.
- **Binding clause:** none requires per-area or per-product grants. Authority must be limited to authorised
  individuals (US 211.68(b), 11.10(d) and (g); EU Annex 11 §12; Schedule M). A site-wide code given only to the
  people authorised for it meets that requirement. The lead confirmed this on 3 Nov 2026.
- **Affected Batchwright tests:** the test "a grant covers only its own site, area and product" (DI-17) keeps running
  on the standalone build. On the platform build, area and product scope do not exist.
- **For the owner to accept:** site-wide codes on the platform. A site that needs area limits does it through its
  access procedure: tick the code only for people authorised in every area, until a later platform release adds
  scope.

## 2. Controls core now performs (control → platform rule)

On the platform build, these Batchwright functions are switched off and core does them. The evidence for the
platform build comes from core's tests named by platform rule. The standalone build keeps its own tests.

| Batchwright control (function moved) | Platform rule in core |
|---|---|
| DI-14 unique personal accounts | PL-03 one verified identity per person, never reused |
| DI-15 identity verification, credential issuance, unique identifiers | PL-03 |
| DI-16 access lifecycle: recorded grants, access lists, recertification, prompt removal | PL-02 grants recorded, PL-12 access review report, PL-01 only active employees |
| DI-19 credential protection: password policy, lockout, misuse alerts | PL-04 password controls, controlled reset, misuse alerts |
| DI-38 signature components and re-authentication (the re-authentication part) | PL-05 re-authentication at e-signature through the sign-on |
| DI-17 and IN-04 authority per action (the source of each person's codes) | PL-01 per-product authority |

These stay in Batchwright, unchanged, on both builds:

- the authority check at every action;
- qualification gates;
- DI-18, administration never does GMP work, kept as the per-session work mode;
- DI-35 segregation;
- the signature catalogue, manifestation and record linking (DI-35 to DI-37, DI-39);
- the idle locks.

**Badge sign-in, badge tap and badge + PIN signing** (part of DI-19 and DI-38) are off on the platform build, because
core has passwords only. Shared terminals sign in at core.

**For the owner to accept:** this control → rule map as the evidence route on the platform build.
