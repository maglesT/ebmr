/**
 * The DEMO-ONLY credential card on the operations screen (Phase 7 slice 7k; requirement R3.13 of the hosted-demo trials):
 * what `pnpm demo` prints, for the presenter who has only the site: the first administrator and process owner (their
 * passwords are new at each set-up) and every demo persona of persona set 0, each with how and where they sign in. It is
 * read from the set-up's own seed file in the keys directory (`<keys directory>/<gmp|sandbox>-seed.json`), never from the
 * database, and only a demo installation answers it (EBMR_DEMO=1 and the database's demo marker, decision D6): a GMP or
 * sandbox installation that is not a demo one refuses it, whatever the role, so no real credential is ever shown.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CredentialCardView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';

interface SeedFile {
  installation: 'GMP' | 'SANDBOX';
  database: string;
  bootstrap: Record<'admin' | 'owner', { legalName: string; loginName: string; roleCode: string; password: string }>;
  personas: { set?: number; legalName: string; loginName: string; roleCode: string; alsoRoles?: string[]; kiosk: boolean; homeTerminal: string; password: string; badgeUid?: string | null; pin?: string | null }[];
}

export function credentialCardView(app: AppContext): CredentialCardView {
  if (!app.demo.enabled) {
    throw refusal(403, {
      code: 'DEMO_ONLY',
      kind: 'NOT_ALLOWED',
      whatHappened: 'The credential card is shown on a demo installation only.',
      why: 'This installation is not a demo one (EBMR_DEMO=1 and the demo marker of its database, decision D6): no credential is shown here.',
      controls: ['DI-05', 'DI-14'],
      whatYouCanDo: ['Ask the system administrator for your own sign-in.'],
    });
  }
  const prefix = app.installation === 'GMP' ? 'gmp' : 'sandbox';
  const file = app.config.keysDir ? join(app.config.keysDir, `${prefix}-seed.json`) : null;
  if (!file || !existsSync(file)) {
    throw refusal(409, {
      code: 'CREDENTIAL_CARD_MISSING',
      kind: 'NOT_ALLOWED',
      whatHappened: 'There is no credential card on this server.',
      why: 'The demo set-up\'s seed file is not in the keys directory (EBMR_KEYS_DIR or EBMR_DEMO_KEYS_FILE).',
      whatYouCanDo: ['Set the demo up again (pnpm demo:setup, or Demo data on this screen).'],
    });
  }
  const seed = JSON.parse(readFileSync(file, 'utf8')) as SeedFile;
  const boot = (['admin', 'owner'] as const).map((k) => {
    const a = seed.bootstrap[k];
    return { legalName: a.legalName, roles: [a.roleCode], terminal: null, method: 'PASSWORD' as const, loginName: a.loginName, password: a.password, badgeUid: null, pin: null, bootstrap: true };
  });
  const personas = seed.personas
    .filter((p) => (p.set ?? 0) === 0)
    .map((p) => ({
      legalName: p.legalName,
      roles: [p.roleCode, ...(p.alsoRoles ?? [])],
      terminal: p.homeTerminal,
      method: p.kiosk ? ('BADGE_PIN' as const) : ('PASSWORD' as const),
      loginName: p.loginName,
      password: p.kiosk ? null : p.password,
      badgeUid: p.kiosk ? (p.badgeUid ?? null) : null,
      pin: p.kiosk ? (p.pin ?? null) : null,
      bootstrap: false,
    }));
  return { installation: seed.installation, database: seed.database, entries: [...boot, ...personas] };
}
