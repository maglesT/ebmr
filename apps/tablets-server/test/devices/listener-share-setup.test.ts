/**
 * The server tests' global set-up declares a listener share of its own (support/global-setup.ts, decision X41), which
 * would hide a kernel 0980 that no longer applies the share: every limit the tests then read is the declaration's. So
 * the set-up first reads what migrating its templates left (readRoleLimits) and fails the run on any problem
 * listenerShareProblems finds. This file checks that function on limits given to it (nothing here changes a role: role
 * attributes are cluster-wide and other test files read them meanwhile), and that the read sees the declared share.
 * That the set-up makes the check is shown by kernel 0980 without its call to kernel.apply_listener_share on a cluster
 * whose roles have no limits: the run fails before any test file starts.
 */
import { describe, expect, it } from 'vitest';
import { onServer } from '@ebmr/test-kit';
import { listenerShareProblems, readRoleLimits, TEST_LISTENER_SHARE, type RoleLimits } from '../support/global-setup.ts';

const SLOTS = 97;
const limits = (of: Record<string, number>): RoleLimits => ({ slots: SLOTS, of: new Map(Object.entries(of)) });

describe('the check of the listener share the server tests\' set-up makes before declaring its own', () => {
  it('[meta] reports a listener role below one listener\'s share (8), an application role not at the cluster\'s slots less its listener role\'s share, and a missing role; nothing for a share of 8 or more levelled with its application role', () => {
    // As kernel 0980 leaves the roles when it applies the share (one listener's), or after a declared share.
    expect(listenerShareProblems(limits({ ebmr_app: 89, ebmr_listener: 8, ebmr_sandbox: 89, ebmr_sandbox_listener: 8 }))).toEqual([]);
    expect(listenerShareProblems(limits({ ebmr_app: 57, ebmr_listener: 40, ebmr_sandbox: 49, ebmr_sandbox_listener: 48 }))).toEqual([]);
    // As kernel 0980 leaves a fresh cluster when it does not apply the share: no limit on any of the four roles.
    expect(listenerShareProblems(limits({ ebmr_app: -1, ebmr_listener: -1, ebmr_sandbox: -1, ebmr_sandbox_listener: -1 }))).toEqual([
      "ebmr_listener has connection limit -1, less than one listener's share (8)",
      "ebmr_sandbox_listener has connection limit -1, less than one listener's share (8)",
    ]);
    // A listener role with less than one listener needs, its application role levelled with it.
    expect(listenerShareProblems(limits({ ebmr_app: 89, ebmr_listener: 8, ebmr_sandbox: 90, ebmr_sandbox_listener: 7 }))).toEqual([
      "ebmr_sandbox_listener has connection limit 7, less than one listener's share (8)",
    ]);
    // Application roles not levelled with their listener role's share: unlimited, or one slot off either way.
    expect(listenerShareProblems(limits({ ebmr_app: -1, ebmr_listener: 40, ebmr_sandbox: 56, ebmr_sandbox_listener: 40 }))).toEqual([
      "ebmr_app has connection limit -1, not the cluster's 97 slots less ebmr_listener's share (57)",
      "ebmr_sandbox has connection limit 56, not the cluster's 97 slots less ebmr_sandbox_listener's share (57)",
    ]);
    expect(listenerShareProblems(limits({ ebmr_app: 90, ebmr_listener: 8, ebmr_sandbox: 89, ebmr_sandbox_listener: 8 }))).toEqual([
      "ebmr_app has connection limit 90, not the cluster's 97 slots less ebmr_listener's share (89)",
    ]);
    // A role that is not there.
    expect(listenerShareProblems(limits({ ebmr_app: 89, ebmr_listener: 8, ebmr_sandbox: 89 }))).toEqual(['ebmr_sandbox_listener does not exist']);
    expect(listenerShareProblems(limits({ ebmr_listener: 8, ebmr_sandbox: 89, ebmr_sandbox_listener: 8 }))).toEqual(['ebmr_app does not exist']);
  });

  it('[meta] the read sees all four roles, at least the share the set-up declared on both listener roles, and the cluster\'s slots for roles that are not superusers', async () => {
    const read = await onServer((s) => readRoleLimits(s));
    const slots = await onServer(
      async (s) =>
        (
          await s.query<{ max: number; superuser: number; reserved: number }>(
            `select current_setting('max_connections')::int as max, current_setting('superuser_reserved_connections')::int as superuser,
                    coalesce(current_setting('reserved_connections', true), '0')::int as reserved`,
          )
        ).rows.map((r) => r.max - r.superuser - r.reserved)[0],
    );
    expect(read.slots).toBe(slots);
    // At least the declared share: packages/kernel/test/security/listener-roles.test.ts, which may run meanwhile, raises
    // each listener role's share for a moment.
    for (const listener of ['ebmr_listener', 'ebmr_sandbox_listener']) expect(read.of.get(listener), listener).toBeGreaterThanOrEqual(TEST_LISTENER_SHARE);
    expect([...read.of.keys()].sort()).toEqual(['ebmr_app', 'ebmr_listener', 'ebmr_sandbox', 'ebmr_sandbox_listener']);
  });
});
