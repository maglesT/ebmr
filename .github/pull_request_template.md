## What changed

<!-- One or two sentences in plain language. -->

## Controls and invariants

<!-- Control IDs (DI-xx, PR-xx, ST-xx, IN-xx) and invariants (INV-xx) this change implements, tests or affects. -->

## Risk and validation impact

- Risk class: low / medium / high
- Touches the compliance kernel, site services, `compliance/` or database migrations: yes / no
- Validation impact: none / regenerate trace matrix / needs a validation delta

## Checks

- [ ] `pnpm run ci` passes locally
- [ ] New or changed behaviour has tests tagged with the control IDs it proves
- [ ] No `Date.now()` or JavaScript `number` for GMP values in domain code
