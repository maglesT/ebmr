/**
 * Engine roles (Phase 2 apps plan section 7, "Role map"; decision D4; INV-26).
 *
 * In a command: tab.engine_roles() evaluates, for the DECLARED kernel role, the permission of every engine
 * role mapped to it (tab.engine_role_map) at the actor's location, and stores each evaluation; the engine
 * actor carries only the allowed ones, and recipe.append_execution accepts an engine role only with such an
 * evaluation made in the same command. The client never names a role.
 *
 * For display (the actions a screen offers): the same map without evaluating authority, and the command
 * permission map (recipe.execution_command_permission) against the permissions of the declared role, so a
 * screen does not offer what the database would refuse for the role (e.g. linking a deviation to an operator).
 * A screen may still offer an action the command then refuses (scope, lockout, time); it never decides anything.
 */
import type { engine, execution } from '@ebmr/recipe-core';
import type { Db } from './runs.ts';

/** Engine roles of this command's actor, from stored authority evaluations (inside the command). */
export async function engineRoles(client: Db): Promise<execution.RoleEvidence[]> {
  const { rows } = await client.query<{ r: execution.RoleEvidence[] | null }>('select tab.engine_roles() as r');
  return rows[0]?.r ?? [];
}

export function engineActor(personId: string, roles: readonly execution.RoleEvidence[]): engine.Actor {
  return { id: personId, kind: 'PERSON', roles: [...new Set(roles.map((r) => r.role))].sort() };
}

const maps = new WeakMap<object, Map<string, string[]>>();

/** The engine roles mapped to a kernel role (display only; no authority evaluated). */
export async function displayRoles(owner: object, db: Db, kernelRole: string | null): Promise<string[]> {
  let map = maps.get(owner);
  if (!map) {
    const { rows } = await db.query<{ kernel_role: string; engine_role: string }>('select kernel_role, engine_role from tab.engine_role_map order by kernel_role, engine_role');
    map = new Map<string, string[]>();
    for (const r of rows) map.set(r.kernel_role, [...(map.get(r.kernel_role) ?? []), r.engine_role]);
    maps.set(owner, map);
  }
  return kernelRole ? [...(map.get(kernelRole) ?? [])] : [];
}

/**
 * Display only: the permissions the viewer's declared kernel role holds now, and the permissions each command
 * type needs (any one of them; recipe.require_command_permission decides at commit).
 */
export interface DisplayPermissions {
  role: string | null;
  held: ReadonlySet<string>;
  needs: ReadonlyMap<string, readonly string[]>;
}

const commandMaps = new WeakMap<object, Map<string, string[]>>();

export async function displayPermissions(owner: object, db: Db, kernelRole: string | null): Promise<DisplayPermissions> {
  let needs = commandMaps.get(owner);
  if (!needs) {
    const { rows } = await db.query<{ command_type: string; permissions: string[] }>('select command_type, permissions from recipe.execution_command_permission order by command_type');
    needs = new Map(rows.map((r) => [r.command_type, r.permissions]));
    commandMaps.set(owner, needs);
  }
  if (!kernelRole) return { role: null, held: new Set(), needs };
  const { rows } = await db.query<{ p: string[] | null }>('select iam.role_permissions_at($1, clock_timestamp()) as p', [kernelRole]);
  return { role: kernelRole, held: new Set(rows[0]?.p ?? []), needs };
}
