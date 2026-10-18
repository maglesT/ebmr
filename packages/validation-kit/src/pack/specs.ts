/**
 * The functional and design specifications (Phase 7 slice 7c), from the code and the database inventory of the bundle
 * (interfaces section 1b).
 *
 * Functional specification: the modules (from the controls' implementing modules and the route namespaces), the
 * routes per namespace, the permissions per role, the block catalog, the rule keys, and each life-cycle state chart
 * drawn from its published definition (a Mermaid state diagram).
 * Design specification: the guard tables (triggers), the permission matrix (roles by permissions by scope kinds), the
 * constraint, privilege, trigger and SECURITY DEFINER inventory, the audited tables (the audit event catalogue), the
 * signature meanings, the message catalogue (EBMR-*), and the architecture boundaries.
 */
import { compareText } from '../bundle/validate.ts';
import type { Bundle } from '../bundle/types.ts';
import { code, heading, list, para, table, type Doc } from './doc.ts';

/** A Mermaid state diagram of one machine. */
export function mermaidStateChart(states: readonly string[], transitions: readonly { from: string; event: string; to: string }[]): string {
  const id = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
  const lines = ['stateDiagram-v2'];
  for (const s of states) lines.push(`  state "${s}" as ${id(s)}`);
  for (const t of transitions) lines.push(`  ${id(t.from)} --> ${id(t.to)}: ${t.event}`);
  return lines.join('\n');
}

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort(compareText);

export function functionalSpec(b: Bundle): Doc {
  const inv = b.inventory;
  const modules = uniq(b.register.controls.flatMap((c) => Object.keys(c.implementedBy)));
  const namespaces = uniq(inv.routes.map((r) => r.namespace));
  const roles = uniq(inv.permissions.flatMap((p) => p.roles));
  const blocks: Doc['blocks'] = [
    para(`What ${b.release.product} ${b.release.version} does, as built: generated from the code and the database of the release, never written by hand.`),
    heading('Modules'),
    table(
      ['Module', 'Controls it implements'],
      modules.map((m) => [m, b.register.controls.filter((c) => m in c.implementedBy).map((c) => c.id).join(', ')]),
    ),
    heading('Routes'),
    para('Every route of the API contract by namespace. A route names no permission when the database decides it in the command (the usual case: the permission is checked where the data is written).'),
  ];
  for (const ns of namespaces) {
    blocks.push(heading(ns, 3));
    blocks.push(table(['Method', 'Route', 'Permission'], inv.routes.filter((r) => r.namespace === ns).map((r) => [r.method, r.route, r.permission ?? 'checked in the database'])));
  }
  blocks.push(heading('Permissions per role'));
  blocks.push(table(['Role', 'Permissions'], roles.map((r) => [r, inv.permissions.filter((p) => p.roles.includes(r)).map((p) => p.permission).join(', ')])));
  blocks.push(heading('Block catalog'));
  blocks.push(table(['Block type', 'Version', 'Controls'], inv.blocks.map((x) => [x.blockType, String(x.version), x.controls.join(', ') || '-'])));
  blocks.push(heading('Rule keys'));
  blocks.push(list(inv.ruleKeys.map((k) => k.key)));
  blocks.push(heading('Life-cycle state charts'));
  for (const m of inv.stateCharts) {
    blocks.push(heading(m.machine, 3));
    blocks.push(table(['From', 'Event', 'To'], m.transitions.map((t) => [t.from, t.event, t.to])));
    blocks.push(code('mermaid', mermaidStateChart(m.states, m.transitions)));
  }
  return { id: 'functional-spec', title: 'Functional specification', status: 'RELEASED', blocks };
}

/** The architecture boundaries the build enforces (.dependency-cruiser.cjs; REPO-GUIDE.md "Rules that CI enforces"). */
export const ARCHITECTURE_BOUNDARIES: readonly string[] = [
  'The two editions (apps) never import each other; shared packages never import an app.',
  'The compliance kernel and the expression language import nothing else in the repository; the recipe core imports only the kernel and the expression language.',
  'Product code never imports repository tooling (tools/), nor the test kit (except the demo and E2E set-up CLI).',
  'Browser code never reaches a database driver, a node core module or the node-only parts of the recipe core.',
  'Analytics imports no repository package; only its runner imports it, and the runner reaches no GMP write path (ADR 0020).',
  'Shared packages are pinned exactly (workspace:<version>, ADR 0015): a shared-package change reaches an edition only when that edition bumps its pin.',
  'GMP rules are enforced in the database under the application\'s own credentials (ADR 0012): the application role writes no GMP table directly; SECURITY DEFINER functions check the actor, the permission in scope and the guards.',
];

export function designSpec(b: Bundle): Doc {
  const inv = b.inventory;
  const roles = uniq(inv.permissions.flatMap((p) => p.roles));
  const definers = inv.functions.filter((f) => f.securityDefiner);
  return {
    id: 'design-spec',
    title: 'Design specification',
    status: 'RELEASED',
    blocks: [
      para(`How ${b.release.product} ${b.release.version} enforces its requirements: generated from the database of the release (a read-only inventory) and from the code.`),
      heading('Architecture boundaries'),
      list([...ARCHITECTURE_BOUNDARIES]),
      heading('Migrations'),
      table(['Namespace', 'File', 'SHA-256'], inv.migrations.map((m) => [m.namespace, m.name, m.sha256])),
      heading('Guard tables (triggers)'),
      table(['Table', 'Trigger', 'Enabled', 'Function'], inv.triggers.map((t) => [t.table, t.name, t.enabled ? 'yes' : 'NO', t.function])),
      heading('Permission matrix'),
      table(['Permission', 'Scope kinds', ...roles], inv.permissions.map((p) => [p.permission, p.scopeKinds.join(', ') || '-', ...roles.map((r) => (p.roles.includes(r) ? 'x' : ''))])),
      heading('SECURITY DEFINER functions'),
      table(['Function', 'Arguments', 'Owner', 'May execute'], definers.map((f) => [`${f.schema}.${f.name}`, f.argTypes, f.owner, f.executeRoles.join(', ') || '(owner only)'])),
      heading('Constraints'),
      table(['Table', 'Constraint', 'Kind', 'Definition SHA-256'], inv.constraints.map((c) => [c.table, c.name, c.kind, c.definitionSha256])),
      heading('Privileges'),
      table(['Role', 'Object', 'Privilege'], inv.privileges.map((p) => [p.role, p.object, p.privilege])),
      heading('Database roles'),
      table(['Role', 'Login', 'Superuser', 'Create role', 'Bypass RLS', 'Inherit', 'Connection limit'], inv.roles.map((r) => [r.name, yn(r.login), yn(r.superuser), yn(r.createRole), yn(r.bypassRls), yn(r.inherit), String(r.connectionLimit)])),
      heading('Settings'),
      table(['Setting', 'Value', 'Expected'], inv.settings.map((s) => [s.name, s.value, s.expected ?? '-'])),
      heading('Audit event catalogue (audited tables)'),
      list(inv.auditedTables.map((t) => t.table)),
      heading('Signature meanings'),
      list(inv.meanings.map((m) => m.meaning)),
      heading('Message catalogue'),
      table(['Code', 'Text', 'Source'], inv.messages.map((m) => [m.code, m.text, m.sourceFile])),
    ],
  };
}

const yn = (x: boolean): string => (x ? 'yes' : 'no');
