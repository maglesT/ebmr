/**
 * Feature `administration` (Phase 7 slice 7g-1, decision 0025; contract ns/people.ts and ns/device-registry.ts): the
 * screens of people and access and of the device registry, on both installations (each has its own people and
 * terminals). Every act is the database's own function, run as the person's command with a reason the audit trail
 * records; the database decides who may and keeps the segregation of duties (the administrator requests a grant or a
 * break-glass window, a second person approves it; nobody verifies, unlocks or grants themselves; INV-11). The reads are
 * the administration roles' (ADMIN_READERS); a read shows metadata only, never a secret.
 *
 * Slice 7g-5 (contract ns/access-governance.ts): role-permission requests and their decision, delegations of signing
 * authority (the delegator requests, a third person approves) and the US e-signature certification letter, each the
 * kernel's own function (iam.add_role_permission, decide_role_permission, remove_role_permission, request_delegation,
 * decide_delegation, revoke_delegation, record_us_esig_certification).
 */
import { routes } from '@ebmr/api-contract';
import { commands, continuity, identity, type ActorContext } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { compact } from '../common/people.ts';
import { certificationStatus, certificationViews, delegableMeanings, delegationViews, personOfLogin, requestViews, roleApprovesDelegations, rolePermissionsView } from './governance.ts';
import { adapterViews, bindingViews, DEVICE_REASON, gatewayKeyViews, oneAdapter, oneTerminal, registryView } from './devices.ts';
import {
  ACCESS_REASON,
  ADMIN_READERS,
  badgeTechnologies,
  grantViews,
  issueSecret,
  notFound,
  oneGrant,
  onePerson,
  oneWindow,
  personOf,
  personViews,
  recertificationViews,
  roleOptions,
  siteCodeOf,
  windowViews,
} from './people.ts';

/**
 * A row the database refuses as a duplicate by a unique index (an adapter code, one adapter per integration account, a
 * badge UID) answers with the database's own message rather than as an unexpected error; nothing was saved.
 */
function duplicateAsRefusal(error: unknown): unknown {
  const e = error as { code?: unknown; message?: unknown; detail?: unknown; cause?: { code?: unknown; message?: unknown; detail?: unknown } };
  const pgError = e.code === '23505' ? e : e.cause?.code === '23505' ? e.cause : null;
  if (!pgError) return error;
  return refusal(409, {
    code: 'EBMR-API-DUPLICATE',
    kind: 'NOT_ALLOWED',
    whatHappened: 'The database refused this as a duplicate. Nothing was saved.',
    why: [pgError.message, pgError.detail].filter((x): x is string => typeof x === 'string' && x !== '').join(': '),
    whatYouCanDo: ['Use another code, or end the existing one first.'],
  });
}

/** One act as an idempotent command of the person (the stored result is an id or null, never a secret). */
async function act(pool: pg.Pool, who: ActorContext, key: string | null, requestHash: string, work: (c: pg.PoolClient) => Promise<string | null | void>): Promise<string | null> {
  try {
    const out = await withIdempotentActorCommand(pool, who, key ?? '', requestHash, async (c) => (await work(c)) ?? null);
    return out.result;
  } catch (error) {
    throw duplicateAsRefusal(error);
  }
}

/** One act that is not idempotent (its request carries a badge UID or its answer a secret). */
async function plain<T>(pool: pg.Pool, who: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withActorCommand(pool, who, work);
  } catch (error) {
    throw duplicateAsRefusal(commands.asKernelError(error));
  }
}

const one = <T>(list: T[], what: string): T => {
  const [v] = list;
  if (!v) throw notFound(what);
  return v;
};

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const P = routes.people;
  bindRoutes(scope, app, P, {
    directory: async ({ requireRole }) => {
      requireRole(...ADMIN_READERS);
      return { people: await personViews(app, pool), badgeTechnologies: await badgeTechnologies(pool), siteCode: await siteCodeOf(pool) };
    },
    createPerson: async ({ body, actor, idempotencyKey, requestHash }) => {
      const id = await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: `record ${body.legalName}` }), idempotencyKey, requestHash, (c) =>
        identity.createPerson(c, body.kind, body.legalName, body.employeeRef),
      );
      return onePerson(app, pool, id ?? '');
    },
    renamePerson: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, (c) => identity.renamePerson(c, params.personId, body.legalName));
      return onePerson(app, pool, params.personId);
    },
    verifyIdentity: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: `identity check: ${body.purpose}` }), idempotencyKey, requestHash, (c) =>
        identity.recordIdentityVerification(c, { personId: params.personId, purpose: body.purpose, method: body.method, documentType: body.documentType, evidenceRef: body.evidenceRef, occurredAt: body.occurredAt }),
      );
      return onePerson(app, pool, params.personId);
    },
    processLeaver: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, (c) => identity.processLeaver(c, params.personId, body.reason));
      return onePerson(app, pool, params.personId);
    },
    createAccount: async ({ body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: `open account ${body.loginName}` }), idempotencyKey, requestHash, (c) =>
        identity.createAccount(c, { personId: body.personId, loginName: body.loginName, kind: body.kind, generic: body.generic, breakGlass: body.breakGlass }),
      );
      return onePerson(app, pool, body.personId);
    },
    activateAccount: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const person = await personOf(pool, 'account', params.accountId);
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, (c) => identity.activateAccount(c, params.accountId));
      return onePerson(app, pool, person);
    },
    setAccountStatus: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const person = await personOf(pool, 'account', params.accountId);
      const fn = { SUSPEND: 'iam.suspend_account', REINSTATE: 'iam.reinstate_account', DEACTIVATE: 'iam.deactivate_account' }[body.action];
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        await c.query(`select ${fn}($1, $2)`, [params.accountId, body.reason]);
      });
      return onePerson(app, pool, person);
    },
    unlockAccount: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const person = await personOf(pool, 'account', params.accountId);
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        await c.query('select iam.unlock_account($1, $2)', [params.accountId, body.reason]);
      });
      return onePerson(app, pool, person);
    },
    issueCredential: async ({ params, body, actor }) => {
      const issued = await issueSecret(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), params.accountId, body.kind);
      const { rows } = await pool.query<{ login_name: string; expires_us: string | null }>(
        `select a.login_name, case when c.expires_at is null then null else (extract(epoch from c.expires_at) * 1000000)::numeric(20, 0)::text end as expires_us
           from iam.credential c join iam.account a on a.id = c.account_id where c.id = $1`,
        [issued.credentialId],
      );
      const r = rows[0];
      if (!r) throw notFound('credential');
      return { credentialId: issued.credentialId, accountId: params.accountId, loginName: r.login_name, kind: body.kind, secret: issued.secret, expiresAt: r.expires_us === null ? null : app.formatInstant(r.expires_us) };
    },
    issueBadge: async ({ params, body, actor }) => {
      const person = await personOf(pool, 'account', params.accountId);
      await plain(pool, actor({ reasonCode: ACCESS_REASON, reasonText: `issue badge ${body.label}` }), (c) =>
        identity.issueBadge(c, {
          accountId: params.accountId,
          uid: body.badgeUid.toUpperCase(),
          technology: body.technology,
          label: body.label,
          identityVerificationId: body.identityVerificationId,
          ...(body.replacesBadgeId ? { replacesBadgeId: body.replacesBadgeId } : {}),
        }),
      );
      return onePerson(app, pool, person);
    },
    recordBadgeTest: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const person = await personOf(pool, 'badge', params.badgeId);
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: `badge test ${body.kind} ${body.result}` }), idempotencyKey, requestHash, (c) =>
        identity.recordBadgeTest(c, params.badgeId, body.kind, body.result, body.notes),
      );
      return onePerson(app, pool, person);
    },
    activateBadge: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const person = await personOf(pool, 'badge', params.badgeId);
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, (c) => identity.activateBadge(c, params.badgeId));
      return onePerson(app, pool, person);
    },
    withdrawBadge: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const person = await personOf(pool, 'badge', params.badgeId);
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        await c.query(body.action === 'LOST' ? 'select iam.report_badge_lost($1, $2)' : 'select iam.revoke_badge($1, $2)', [params.badgeId, body.reason]);
      });
      return onePerson(app, pool, person);
    },
    grants: async ({ requireRole }) => {
      requireRole(...ADMIN_READERS);
      return { grants: await grantViews(app, pool), roles: await roleOptions(pool) };
    },
    requestGrant: async ({ body, actor, idempotencyKey, requestHash }) => {
      const id = await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, (c) =>
        identity.requestRoleGrant(c, {
          accountId: body.accountId,
          roleCode: body.roleCode,
          scope: compact(body.scope) as { site?: string; area?: string; product?: string },
          ...(body.validFrom ? { validFrom: body.validFrom } : {}),
          ...(body.validTo ? { validTo: body.validTo } : {}),
          reason: body.reason,
        }),
      );
      return oneGrant(app, pool, id ?? '');
    },
    decideGrant: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, (c) => identity.decideRoleGrant(c, params.grantId, body.approve, body.reason));
      return oneGrant(app, pool, params.grantId);
    },
    revokeGrant: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, (c) => identity.revokeRoleGrant(c, params.grantId, body.reason));
      return oneGrant(app, pool, params.grantId);
    },
    recertification: async ({ requireRole }) => {
      requireRole(...ADMIN_READERS);
      return recertificationViews(app, pool);
    },
    recertify: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const id = await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.comment }), idempotencyKey, requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select iam.recertify_account($1, $2, $3) as id', [params.accountId, body.outcome, body.comment]);
        return rows[0]?.id ?? null;
      });
      return { recertificationId: id ?? '' };
    },
    breakGlass: async ({ requireRole }) => {
      requireRole(...ADMIN_READERS);
      return { windows: await windowViews(app, pool) };
    },
    requestBreakGlass: async ({ body, actor, idempotencyKey, requestHash }) => {
      const id = await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select iam.request_break_glass($1, $2, $3) as id', [body.accountId, body.reason, body.minutes]);
        return rows[0]?.id ?? null;
      });
      return oneWindow(app, pool, id ?? '');
    },
    approveBreakGlass: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        await c.query('select iam.approve_break_glass($1)', [params.windowId]);
      });
      return oneWindow(app, pool, params.windowId);
    },
    reviewBreakGlass: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.comment }), idempotencyKey, requestHash, async (c) => {
        await c.query('select iam.review_break_glass($1, $2, $3)', [params.windowId, body.outcome, body.comment]);
      });
      return oneWindow(app, pool, params.windowId);
    },
  });

  const D = routes.deviceRegistry;
  bindRoutes(scope, app, D, {
    list: async ({ requireRole }) => {
      requireRole(...ADMIN_READERS);
      return registryView(app, pool, await siteCodeOf(pool));
    },
    registerTerminal: async ({ body, actor, idempotencyKey, requestHash }) => {
      const site = await siteCodeOf(pool);
      if (!site) {
        throw refusal(409, { code: 'EBMR-API-NO-SITE', kind: 'NOT_ALLOWED', whatHappened: 'The installation has no site yet.', why: 'No terminal is registered, so the site code is not known.', whatYouCanDo: ['Bootstrap the installation first.'] });
      }
      const id = await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: `register ${body.code}` }), idempotencyKey, requestHash, (c) =>
        identity.registerDevice(c, { code: body.code, deviceClass: body.deviceClass, site, ...(body.room ? { room: body.room } : {}), ...(body.line ? { line: body.line } : {}), fingerprint: body.fingerprint, description: body.description }),
      );
      return oneTerminal(app, pool, id ?? '');
    },
    relocateTerminal: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        await c.query('select iam.relocate_device($1, $2, $3, $4)', [params.deviceId, body.room ?? null, body.line ?? null, body.reason]);
      });
      return oneTerminal(app, pool, params.deviceId);
    },
    setTerminalStatus: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: body.reason }), idempotencyKey, requestHash, (c) => identity.setDeviceStatus(c, params.deviceId, body.status, body.reason));
      return oneTerminal(app, pool, params.deviceId);
    },
    attestHardening: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const t = await oneTerminal(app, pool, params.deviceId);
      if (t.deviceClass !== 'SHARED' && t.deviceClass !== 'GRADE_A_B') {
        throw refusal(409, { code: 'EBMR-API-NOT-A-KIOSK', kind: 'NOT_ALLOWED', whatHappened: 'Only a shared or Grade A/B kiosk is attested.', why: `${t.code} is a ${t.deviceClass} device.`, whatYouCanDo: ['Choose a kiosk.'] });
      }
      const deviceClass = t.deviceClass;
      await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: `hardening of ${t.code}: ${body.evidenceRef}` }), idempotencyKey, requestHash, (c) =>
        continuity.recordHardeningAttestation(c, {
          deviceId: params.deviceId,
          deviceClass,
          usbMassStorageBlocked: body.usbMassStorageBlocked,
          kioskModeEnforced: body.kioskModeEnforced,
          malwareProtectionActive: body.malwareProtectionActive,
          osPatchWithinSla: body.osPatchWithinSla,
          ...(body.osBuild ? { osBuild: body.osBuild } : {}),
          method: body.method,
          evidenceRef: body.evidenceRef,
          ...(body.validityDays ? { validityDays: body.validityDays } : {}),
        }),
      );
      return oneTerminal(app, pool, params.deviceId);
    },
    bindDevice: async ({ body, actor, idempotencyKey, requestHash }) => {
      const id = await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: `bind ${body.deviceCode}` }), idempotencyKey, requestHash, async (c) => {
        const sql =
          body.kind === 'BALANCE'
            ? { q: 'select tab.bind_instrument($1, $2, $3, $4, $5) as id', p: [body.gatewayKeyId, body.deviceCode, body.serial, body.unit ?? null, body.resolution ?? null] }
            : body.kind === 'PRINT'
              ? { q: 'select tab.bind_print_device($1, $2, $3, $4) as id', p: [body.gatewayKeyId, body.deviceCode, body.serial, body.deviceKind ?? null] }
              : { q: 'select tab.bind_process_device($1, $2, $3, $4) as id', p: [body.gatewayKeyId, body.deviceCode, body.serial, body.deviceKind ?? null] };
        const { rows } = await c.query<{ id: string }>(sql.q, sql.p);
        return rows[0]?.id ?? null;
      });
      return one(await bindingViews(app, pool, { kind: body.kind, id: id ?? '' }), 'device binding');
    },
    endBinding: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const fn = { BALANCE: 'tab.end_instrument_binding', PRINT: 'tab.end_print_device', PROCESS: 'tab.end_process_device' }[body.kind];
      await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        await c.query(`select ${fn}($1, $2, $3)`, [params.bindingId, DEVICE_REASON, body.reason]);
      });
      return one(await bindingViews(app, pool, { kind: body.kind, id: params.bindingId }), 'device binding');
    },
    enrolGatewayKey: async ({ body, actor, idempotencyKey, requestHash }) => {
      const id = await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: `enrol the key of ${body.gatewayCode}` }), idempotencyKey, requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select tab.enrol_gateway_key($1, $2, $3) as id', [body.gatewayCode, body.publicKeySpki, body.loginName]);
        return rows[0]?.id ?? null;
      });
      return one(await gatewayKeyViews(app, pool, id ?? ''), 'gateway key');
    },
    revokeGatewayKey: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        await c.query('select tab.revoke_gateway_key($1, $2, $3)', [params.keyId, DEVICE_REASON, body.reason]);
      });
      return one(await gatewayKeyViews(app, pool, params.keyId), 'gateway key');
    },
    bindGatewayFeed: async ({ body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select tab.bind_gateway_feed($1, $2, $3, $4) as id', [body.adapterCode, body.gatewayCode, DEVICE_REASON, body.reason]);
        return rows[0]?.id ?? null;
      });
      return oneAdapter(app, pool, body.adapterCode);
    },
    registerAdapter: async ({ body, actor, idempotencyKey, requestHash }) => {
      await act(pool, actor({ reasonCode: DEVICE_REASON, reasonText: `register adapter ${body.code}` }), idempotencyKey, requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select iam.register_integration_adapter($1, $2, $3, $4, $5) as id', [body.code, body.sourceSystem, body.accountId, body.deviceId, body.description]);
        return rows[0]?.id ?? null;
      });
      return one(await adapterViews(app, pool, body.code), 'adapter');
    },
  });

  const G = routes.accessGovernance;
  const delegationsFor = async (who: { personId: string; roleCode: string | null }, delegationId?: string) =>
    delegationViews(app, pool, { all: await roleApprovesDelegations(pool, who.roleCode), viewer: who.personId, ...(delegationId ? { delegationId } : {}) });
  bindRoutes(scope, app, G, {
    rolePermissions: async ({ requireRole }) => {
      requireRole(...ADMIN_READERS);
      return rolePermissionsView(app, pool);
    },
    requestRolePermission: async ({ body, actor, idempotencyKey, requestHash }) => {
      const id = await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, (c) =>
        identity.requestRolePermission(c, { roleCode: body.roleCode, permission: body.permissionCode, reason: body.reason }),
      );
      return one(await requestViews(app, pool, id ?? ''), 'role-permission request');
    },
    decideRolePermission: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const who = { ...actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), ...(body.changeRecord ? { changeRecord: body.changeRecord } : {}) };
      await act(pool, who, idempotencyKey, requestHash, (c) => identity.decideRolePermission(c, params.requestId, body.approve, body.reason));
      return one(await requestViews(app, pool, params.requestId), 'role-permission request');
    },
    removeRolePermission: async ({ body, actor, idempotencyKey, requestHash }) => {
      const who = { ...actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), changeRecord: body.changeRecord };
      await act(pool, who, idempotencyKey, requestHash, (c) => identity.removeRolePermission(c, body.roleCode, body.permissionCode));
      return rolePermissionsView(app, pool);
    },
    delegations: async ({ requireSession }) => {
      const s = requireSession();
      const mayApprove = await roleApprovesDelegations(pool, s.roleCode);
      return { delegations: await delegationsFor(s), meanings: await delegableMeanings(pool), mayApprove };
    },
    requestDelegation: async ({ body, actor, idempotencyKey, requestHash, requireSession }) => {
      const s = requireSession();
      const delegate = await personOfLogin(pool, body.delegateLoginName);
      if (!delegate) throw notFound('user ID');
      const id = await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select iam.request_delegation($1, $2::jsonb, $3, $4, $5, $6, $7, $8) as id', [
          delegate,
          JSON.stringify(compact(body.scope)),
          body.markets,
          body.meanings,
          body.validFrom,
          body.validTo,
          body.sopRef,
          body.reason,
        ]);
        return rows[0]?.id ?? null;
      });
      return one(await delegationsFor(s, id ?? ''), 'delegation');
    },
    decideDelegation: async ({ params, body, actor, idempotencyKey, requestHash, requireSession }) => {
      const s = requireSession();
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        await c.query('select iam.decide_delegation($1, $2, $3)', [params.delegationId, body.approve, body.reason]);
      });
      return one(await delegationsFor(s, params.delegationId), 'delegation');
    },
    revokeDelegation: async ({ params, body, actor, idempotencyKey, requestHash, requireSession }) => {
      const s = requireSession();
      await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: body.reason }), idempotencyKey, requestHash, async (c) => {
        await c.query('select iam.revoke_delegation($1, $2)', [params.delegationId, body.reason]);
      });
      return one(await delegationsFor(s, params.delegationId), 'delegation');
    },
    usEsigCertifications: async ({ query, requireRole }) => {
      requireRole(...ADMIN_READERS);
      const status = await certificationStatus(pool, query.legalEntity ?? '');
      return {
        mode: status.mode,
        certifications: await certificationViews(app, pool),
        status: query.legalEntity ? { legalEntity: status.legalEntity, onFile: status.onFile, blocking: status.blocking } : null,
      };
    },
    recordUsEsigCertification: async ({ body, actor, idempotencyKey, requestHash }) => {
      const id = await act(pool, actor({ reasonCode: ACCESS_REASON, reasonText: `US e-signature certification of ${body.legalEntity}: ${body.letterRef}` }), idempotencyKey, requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select iam.record_us_esig_certification($1, $2, $3::date, $4) as id', [
          body.legalEntity,
          body.letterRef,
          body.submittedOn,
          body.agencyAcknowledgementRef ?? null,
        ]);
        return rows[0]?.id ?? null;
      });
      return one(await certificationViews(app, pool, id ?? ''), 'certification');
    },
  });
  return Promise.resolve();
}
