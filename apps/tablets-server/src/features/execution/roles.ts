/**
 * Engine roles (Phase 2 apps plan section 7, "Role map"; decision D4; INV-26).
 *
 * In a command: tab.engine_roles() evaluates, for the DECLARED kernel role, the permission of every engine
 * role mapped to it (tab.engine_role_map) at the actor's location, and stores each evaluation; the engine
 * actor carries only the allowed ones, and recipe.append_execution accepts an engine role only with such an
 * evaluation made in the same command. The client never names a role.
 *
 * For display (the actions a screen offers): the same map without evaluating authority. A screen may offer
 * an action the command then refuses; it never decides anything.
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
