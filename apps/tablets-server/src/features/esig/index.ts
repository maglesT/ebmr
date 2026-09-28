/**
 * Feature `esig` (module C1; plan section 6): the e-signature ceremony endpoints, both installations.
 *
 *  1. GET content: the exact canonical text to be signed, its hash and content version. A signable handler
 *     previews it (for engine actions: the step as it will be after the sweep and finalisation); otherwise the
 *     kernel's esig.content_for_signing. `intent` is the meaning code the signer is asked to sign.
 *  2. POST challenges (FRESH_ON_SHARED: the signer's own tap attributes it on a kiosk): one idempotent command
 *     runs handler.prepareForChallenge and esig.create_challenge, which refuses a client hash that is not the
 *     server's (EBMR-ESIG-013: "the record changed while you were reviewing it").
 *  3. POST sign: the signer authenticates for the challenge on the authentication pool (identity.authenticate,
 *     purpose SIGNATURE; a failure is recorded and counts toward lockout), then ONE idempotent command whose
 *     actor carries that event (it attributes the command and is consumed by the signature):
 *       handler.dryRun, with a placeholder signature. Refused: the command commits only what the handler records
 *       on purpose (its refusal record), nothing is signed, and the refusal is answered. Accepted with another
 *       content hash than the challenge's: the same, answered CONTENT_CHANGED;
 *       esig.sign and the seal (kernel: the only writer of signatures; unsealed signatures cannot commit);
 *       handler.apply with the real signature.
 *     Any failure rolls the whole command back (signature, seal, consumed event); esig.logSigningFailure then
 *     records it outside the rolled-back transaction (INV-10).
 *  4. GET signatures: the stored manifestations of a record, with their current validity (DI-36, INV-09).
 *
 * Credentials: badge and PIN on kiosks (the badge of the challenge's tap is kept by the server, see badges.ts),
 * user ID and password on office PCs; never logged, cached or re-sent. A lost sign response is reconciled by the
 * browser reloading the signatures, never by sending the credentials again.
 */
import { routes, type ChallengeView, type ManifestationView, type Refusal, type SignableAction, type SignableContentView } from '@ebmr/api-contract';
import { commands, esig, identity } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import { otherTerminal } from '../../platform/auth/attribution.ts';
import { without } from '../../platform/auth/device-proof.ts';
import { isShopFloor, type ResolvedSession } from '../../platform/auth/session.ts';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes, pathOf } from '../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { ChallengeBadgeStore } from './badges.ts';
import { kernelContent, type EsigSignableContext } from './content.ts';
import { ESIG_GUIDANCE } from './guidance.ts';
import { esigStubHandler } from './stub.ts';
import { manifestationView, meaningInfo, meaningPhrase, readChallenge, type StoredChallenge } from './views.ts';

export const guidance = ESIG_GUIDANCE;

/** DEMO-ONLY: the stub signable exists only on demo installations (the E2E ceremony spec and the owner demo). */
export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.demo.enabled) registry.register(esigStubHandler(app));
}

export { esigStubHandler } from './stub.ts';

const badgeStores = new WeakMap<AppContext, ChallengeBadgeStore>();

/** The server's store of challenge badges (one per AppContext). */
export function challengeBadges(app: AppContext): ChallengeBadgeStore {
  let s = badgeStores.get(app);
  if (!s) {
    s = new ChallengeBadgeStore();
    badgeStores.set(app, s);
  }
  return s;
}

function handlerFor(app: AppContext, kind: SignableAction['kind']): SignableActionHandler {
  const h = app.signables.forKind(kind);
  if (!h) {
    throw refusal(422, {
      code: 'SIGNABLE_NOT_ENABLED',
      kind: 'NOT_ENABLED',
      whatHappened: 'This kind of signature is not available on this installation.',
      why: `No signable action ${kind} is registered here.`,
      controls: ['DI-35'],
      whatYouCanDo: ['Check that you are on the right installation.'],
    });
  }
  return h;
}

function mismatch(why: string): Error {
  return refusal(422, {
    code: 'ESIG_ACTION_MISMATCH',
    kind: 'INVALID_INPUT',
    whatHappened: 'The signing request does not match the action it would sign. Nothing was signed.',
    why,
    controls: ['DI-37'],
    whatYouCanDo: ['Reload the screen and start the signing again.'],
  });
}

function sealKeyOf(app: AppContext): esig.SealKeyProvider {
  if (!app.sealKey) {
    throw refusal(503, {
      code: 'SIGNING_NOT_CONFIGURED',
      kind: 'NOT_ENABLED',
      whatHappened: 'Signing is not available on this installation: no seal key is configured.',
      why: 'Every signature is sealed with the installation key (EBMR_SEAL_KEY_FILE; a KMS or HSM in production).',
      controls: ['DI-37'],
      whatYouCanDo: ['Stop and report it.'],
      whoCanHelp: ['The system administrator'],
    });
  }
  return app.sealKey;
}

const contentChanged = (why: string): Refusal => ({
  code: 'CONTENT_CHANGED',
  kind: 'CONTENT_CHANGED',
  whatHappened: 'The record changed while you were reviewing it. Nothing was signed.',
  why,
  controls: ['DI-37'],
  whatYouCanDo: ['Review the current content, then sign again.'],
  whoCanHelp: [],
});

function signableContext(session: ResolvedSession, actor: EsigSignableContext['actor'], meaning: string): EsigSignableContext {
  return { actor, room: session.roomCode, deviceClass: session.deviceClass, meaning };
}

/** A refusal answered for a signing, recorded in the kernel's signing-failure log first (after any rollback). */
async function logged(app: AppContext, challengeId: string, error: unknown): Promise<void> {
  await esig.logSigningFailure(app.pools.app, challengeId, error);
}

type SignWork = { refused: { status: number; refusal: Refusal } } | { signed: { manifestation: ManifestationView; result: Record<string, unknown> | null } };

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const badges = challengeBadges(app);

  bindRoutes(
    scope,
    app,
    routes.esig,
    {
      content: async ({ query, requireSession, actor }) => {
        const s = requireSession();
        const handler = app.signables.forAggregateType(query.aggregateType);
        const view: SignableContentView = handler ? await handler.previewContent(signableContext(s, actor(), query.intent), query) : await kernelContent(app.pools.app, query);
        if (view.aggregateType !== query.aggregateType || view.aggregateId !== query.aggregateId) throw mismatch('The preview names another record than the one asked for.');
        return view;
      },

      createChallenge: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
        const s = requireSession();
        sealKeyOf(app);
        const handler = handlerFor(app, body.action.kind);
        const d = handler.describe(body.action);
        if (d.aggregateType !== body.aggregateType || d.aggregateId !== body.aggregateId) throw mismatch(`The action signs ${d.aggregateType} ${d.aggregateId}.`);
        if (d.meaning !== '' && d.meaning !== body.meaning) throw mismatch(`The action is signed ${d.meaning}, not ${body.meaning}.`);
        await meaningInfo(app.pools.app, body.meaning);
        const a = actor();
        const ctx = signableContext(s, a, body.meaning);
        const out = await withIdempotentActorCommand(app.pools.app, a, idempotencyKey ?? '', requestHash, async (client) => {
          await handler.prepareForChallenge(client, ctx, body.action);
          const ch = await esig.createChallenge(client, {
            aggregateType: body.aggregateType,
            aggregateId: body.aggregateId,
            contentVersion: body.contentVersion,
            meaning: body.meaning,
            clientContentHash: body.clientContentHash,
          });
          const stored = await readChallenge(client, ch.challengeId);
          if (!stored) throw new Error('the new challenge could not be read back');
          const preview = ch.manifestationPreview;
          const view: ChallengeView = {
            challengeId: ch.challengeId,
            aggregateType: body.aggregateType,
            aggregateId: body.aggregateId,
            contentVersion: ch.contentVersion,
            contentHash: ch.contentHash,
            meaning: ch.meaning.code,
            expiresAt: app.formatInstant(stored.expiresUs),
            expiresInSeconds: Math.max(1, stored.secondsLeft),
            requires: isShopFloor(s.deviceClass) ? ['PIN'] : ['USER_ID', 'PASSWORD'],
            manifestation: {
              legalName: typeof preview['printed_name'] === 'string' ? preview['printed_name'] : s.legalName,
              loginName: typeof preview['user_id'] === 'string' ? preview['user_id'] : s.loginName,
              role: typeof preview['role_code'] === 'string' ? preview['role_code'] : (s.roleCode ?? ''),
              meaning: ch.meaning.code,
              meaningText: meaningPhrase(ch.meaning.title),
              zone: typeof preview['site_zone'] === 'string' ? preview['site_zone'] : app.config.siteZone,
            },
          };
          return view as unknown as commands.JsonValue;
        });
        const view = out.result as unknown as ChallengeView;
        if (out.replayed) {
          const stored = await readChallenge(app.pools.app, view.challengeId);
          if (!stored || stored.secondsLeft <= 0) {
            throw refusal(409, { code: 'EBMR-ESIG-033', kind: 'STALE', whatHappened: 'The time to sign ran out. Nothing was signed.', why: 'This signing request has expired.', controls: ['DI-38'], whatYouCanDo: ['Start the signing again.'] });
          }
          view.expiresInSeconds = stored.secondsLeft;
        }
        // Kiosk: keep the badge of this tap for the PIN step (see badges.ts). Never logged or stored.
        if (isShopFloor(s.deviceClass) && body.attribution) badges.remember(view.challengeId, { badgeUid: body.attribution.badgeUid, tokenHash: s.tokenHash, personId: s.personId });
        return view;
      },

      sign: async ({ body, request, requireSession, actor, idempotencyKey, requestHash }) => {
        const s = requireSession();
        const sealKey = sealKeyOf(app);
        const handler = handlerFor(app, body.action.kind);
        const d = handler.describe(body.action);
        const ch: StoredChallenge | null = await readChallenge(app.pools.app, body.challengeId);
        if (!ch || ch.sessionId !== s.sessionId) {
          throw refusal(409, { code: 'EBMR-ESIG-031', kind: 'STALE', whatHappened: 'This signing request is not known here. Nothing was signed.', why: 'The challenge does not exist or belongs to another session.', controls: ['DI-38'], whatYouCanDo: ['Start the signing again.'] });
        }
        if (d.aggregateType !== ch.aggregateType || d.aggregateId !== ch.aggregateId || (d.meaning !== '' && d.meaning !== ch.meaning)) {
          throw mismatch('The action to apply is not the one the challenge was issued for.');
        }
        const { fingerprint, device } = await app.devices.identify(body.proof, { method: request.method, path: pathOf(request), body: without(body, 'proof') });
        if (device.deviceId !== s.deviceId) throw otherTerminal();
        const floor = isShopFloor(s.deviceClass);
        const c = body.credentials;
        if ((c.kind === 'PIN') !== floor) {
          throw refusal(422, {
            code: 'LOGIN_METHOD',
            kind: 'NOT_ALLOWED',
            whatHappened: floor ? 'On a kiosk you sign with your badge and PIN.' : 'On an office PC you sign with your user ID and password.',
            why: `${s.deviceCode} is a ${s.deviceClass} terminal.`,
            controls: ['DI-38'],
            whatYouCanDo: ['Sign with the components this terminal asks for.'],
          });
        }
        let identifier: string;
        let secret: string;
        if (c.kind === 'PIN') {
          const badge = badges.peek(ch.challengeId, s.tokenHash, s.personId);
          if (!badge) {
            throw refusal(409, { code: 'ESIG_TAP_AGAIN', kind: 'STALE', whatHappened: 'The badge tap of this signing is no longer known. Nothing was signed.', why: 'A signing on a kiosk uses the badge tapped for it within its time limit.', controls: ['DI-38'], whatYouCanDo: ['Start the signing again and tap your badge.'] });
          }
          identifier = badge;
          secret = c.pin;
        } else {
          identifier = c.loginName;
          secret = c.password;
        }
        let ev: identity.AuthenticationEvent;
        try {
          ev = await identity.authenticate(app.pools.authn, { method: c.kind === 'PIN' ? 'BADGE_PIN' : 'PASSWORD', identifier, secret, deviceFingerprint: fingerprint, purpose: 'SIGNATURE', challengeId: ch.challengeId });
        } catch (error) {
          await logged(app, ch.challengeId, error);
          if (error instanceof identity.AuthenticationFailedError && (error.locked || error.reason === 'ACCOUNT_LOCKED')) badges.forget(ch.challengeId);
          throw error;
        }
        badges.forget(ch.challengeId);
        if (ev.personId !== ch.signerPerson || ev.accountId !== ch.signerAccount) {
          const e = refusal(403, {
            code: 'EBMR-IAM-093',
            kind: 'INDEPENDENCE',
            whatHappened: 'Only the signer can confirm their own signature; nobody signs for another person. Nothing was signed.',
            why: 'The credentials entered belong to another person than the one named on the signature.',
            controls: ['DI-38'],
            whatYouCanDo: ['The person named on the signature enters their own credentials.'],
          });
          await logged(app, ch.challengeId, new Error(`EBMR-IAM-093 the signature authentication belongs to another person (no proxy signing)`));
          throw e;
        }
        const a = { ...actor(), authEventId: ev.authEventId };
        const ctx = signableContext(s, a, ch.meaning);
        let work: SignWork;
        try {
          const out = await withIdempotentActorCommand(app.pools.app, a, idempotencyKey ?? '', requestHash, async (client) => {
            const dry = await handler.dryRun(client, ctx, body.action);
            let result: SignWork;
            if (!dry.accepted) {
              result = { refused: { status: dry.status, refusal: dry.refusal } };
            } else if (dry.contentHash !== ch.contentHash || dry.contentVersion !== ch.contentVersion) {
              result = { refused: { status: 409, refusal: contentChanged(`The record is now at content version ${dry.contentVersion}; the challenge was for version ${ch.contentVersion}.`) } };
            } else {
              const sig = await esig.sign(client, { challengeId: ch.challengeId, authEventId: ev.authEventId, expectedState: d.expectedState ?? null }, sealKey);
              const applied = await handler.apply(client, ctx, body.action, { signatureId: sig.signatureId, meaning: ch.meaning, signer: ch.signerPerson });
              result = { signed: { manifestation: manifestationView(sig.manifestation, ch.signerPerson, true), result: applied } };
            }
            return result as unknown as commands.JsonValue;
          });
          work = out.result as unknown as SignWork;
        } catch (error) {
          if (!(error instanceof HttpRefusal)) await logged(app, ch.challengeId, error);
          throw error;
        }
        if ('refused' in work) {
          await logged(app, ch.challengeId, new Error(`${work.refused.refusal.code} ${work.refused.refusal.why || work.refused.refusal.whatHappened}`));
          throw new HttpRefusal(work.refused.status, work.refused.refusal);
        }
        return work.signed;
      },

      signatures: async ({ query }) => {
        const list = await esig.recordSignatures(app.pools.app, query.aggregateType, query.aggregateId);
        const signatures: ManifestationView[] = [];
        for (const r of list) {
          const stored = await esig.getManifestation(app.pools.app, r.signatureId);
          signatures.push(manifestationView(stored.manifestation, r.signerPerson, stored.valid));
        }
        return { signatures };
      },
    },
    { rateLimits: { sign: { max: 20, timeWindow: '1 minute', by: 'SESSION' } } },
  );
  return Promise.resolve();
}
