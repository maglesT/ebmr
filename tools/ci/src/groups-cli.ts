/** Prints the end-to-end groups CI knows (tools/e2e/groups.ts), space-separated, for ci.yml's changes job. */
import { ALL_E2E_GROUPS } from '../../e2e/groups.ts';

console.log(ALL_E2E_GROUPS.join(' '));
