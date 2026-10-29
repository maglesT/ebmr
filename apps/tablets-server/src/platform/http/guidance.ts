/**
 * The guidance catalogue: plain-language "what happened, what you can do, who can help" for each refusal code
 * (Phase 2 apps plan section 4). `why` is always the engine's or the kernel's own message; the catalogue adds
 * the guidance around it. Each feature registers its entries (features/<name>/index.ts `guidance`).
 */
import type { RefusalKind } from '@ebmr/api-contract';

export interface GuidanceEntry {
  status: number;
  kind: RefusalKind;
  whatHappened: string;
  whatYouCanDo: string[];
  whoCanHelp: string[];
  controls?: string[];
  retryable?: boolean;
}

/** "test run" and "test runs" that name the batch at hand, not the sandbox's own ("sandbox test run", "test runs in the sandbox"). */
const TEST_RUN = /(?<!sandbox )\b([Tt])est run(s?)\b(?! in the sandbox)/g;

/**
 * Slice 7u (R10 #10): a guidance text as the installation says it. The execution guidance is shared by sandbox test runs
 * and GMP batches; on the GMP installation it never speaks of a test run ("the refusal is recorded in the batch"). The
 * sandbox keeps its wording.
 */
export function forInstallation(text: string, installation: 'GMP' | 'SANDBOX' | undefined): string {
  if (installation !== 'GMP') return text;
  return text.replace(TEST_RUN, (_m, t: string, s: string) => `${t === 'T' ? 'B' : 'b'}atch${s ? 'es' : ''}`);
}

export class GuidanceCatalogue {
  private readonly entries = new Map<string, { entry: GuidanceEntry; owner: string }>();

  /** `installation`: the installation the server runs; GMP guidance never speaks of a test run (forInstallation). */
  constructor(private readonly installation?: 'GMP' | 'SANDBOX') {}

  private said(entry: GuidanceEntry): GuidanceEntry {
    if (this.installation !== 'GMP') return entry;
    return { ...entry, whatHappened: forInstallation(entry.whatHappened, 'GMP'), whatYouCanDo: entry.whatYouCanDo.map((t) => forInstallation(t, 'GMP')) };
  }

  register(owner: string, entries: Readonly<Record<string, GuidanceEntry>>): void {
    for (const [code, entry] of Object.entries(entries)) {
      const existing = this.entries.get(code);
      if (existing && existing.owner !== owner) throw new Error(`guidance for ${code} is registered by ${existing.owner} and ${owner}`);
      this.entries.set(code, { entry, owner });
    }
  }

  /** The entry for a code, else for its prefix family (e.g. EBMR-IAM-), else undefined. */
  lookup(code: string): GuidanceEntry | undefined {
    const exact = this.entries.get(code);
    if (exact) return this.said(exact.entry);
    const family = /^(EBMR-[A-Z]+-|[A-Z0-9]+-)/.exec(code)?.[1];
    const entry = family ? this.entries.get(`${family}*`)?.entry : undefined;
    return entry ? this.said(entry) : undefined;
  }

  codes(): string[] {
    return [...this.entries.keys()].sort();
  }
}

/** Platform guidance (C0): session, device proof, CSRF, installation, idempotency, schema. */
export const PLATFORM_GUIDANCE: Readonly<Record<string, GuidanceEntry>> = {
  SCHEMA: {
    status: 400,
    kind: 'INVALID_INPUT',
    whatHappened: 'The request was not in the expected form.',
    whatYouCanDo: ['Reload the page and try again.'],
    whoCanHelp: ['The system administrator, if it happens again'],
  },
  NO_SESSION: {
    status: 401,
    kind: 'NOT_ALLOWED',
    whatHappened: 'You are not signed in on this installation.',
    whatYouCanDo: ['Sign in again.'],
    whoCanHelp: [],
  },
  SESSION_LOCKED: {
    status: 423,
    kind: 'LOCKED',
    whatHappened: 'This session is locked.',
    whatYouCanDo: ['Unlock it with your own credentials, or sign in as another person.'],
    whoCanHelp: [],
    controls: ['DI-38'],
  },
  ROLE_CHOICE_REQUIRED: {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Choose the role you are working in before you continue.',
    whatYouCanDo: ['Pick one of your roles.'],
    whoCanHelp: [],
  },
  CSRF: {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The request did not carry this page’s security token, so it was refused.',
    whatYouCanDo: ['Reload the page and try again.'],
    whoCanHelp: ['The system administrator, if it happens again'],
    controls: ['DI-13'],
  },
  ORIGIN: {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The request did not come from this installation’s own pages, so it was refused.',
    whatYouCanDo: ['Open the installation from its own address and try again.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-13'],
  },
  DEVICE_PROOF: {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This terminal could not prove which registered device it is.',
    whatYouCanDo: ['Reload the page. If it happens again, the terminal needs to be enrolled.'],
    whoCanHelp: ['The system administrator (device enrolment)'],
    controls: ['DI-20'],
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: 428,
    kind: 'INVALID_INPUT',
    whatHappened: 'The request had no idempotency key, so it was not run.',
    whatYouCanDo: ['Reload the page and try again.'],
    whoCanHelp: [],
  },
  TAP_REQUIRED: {
    status: 428,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Tap your badge to confirm it is you.',
    whatYouCanDo: ['Tap your badge on the reader, then send again.'],
    whoCanHelp: [],
    controls: ['DI-14'],
  },
  // Read authorisation decided by the database for the request's session (tablets 0410 and 0420, review F34 and F35).
  'EBMR-TAB-018': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Only an active session working in a role granted to you now can read this.',
    whatYouCanDo: ['Unlock the session, choose your role, or sign in again.'],
    whoCanHelp: [],
    controls: ['DI-16', 'DI-17'],
  },
  'EBMR-TAB-019': {
    status: 404,
    kind: 'NOT_ENABLED',
    whatHappened: 'This record is not signed with that meaning on this installation. Nothing of it is shown.',
    whatYouCanDo: ['Check the record and the meaning you were asked to sign.'],
    whoCanHelp: [],
    controls: ['DI-37'],
  },
  'EBMR-TAB-020': {
    status: 403,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Your role may not read this record. Nothing of it is shown.',
    whatYouCanDo: ['Ask a person whose role reads it (QA, data integrity, access review or audit).'],
    whoCanHelp: ['The system administrator (role grants)'],
    controls: ['DI-17', 'DI-50'],
  },
  NOT_FOUND: {
    status: 404,
    kind: 'NOT_ENABLED',
    whatHappened: 'This function does not exist on this installation.',
    whatYouCanDo: ['Check that you are on the right installation (GMP or sandbox).'],
    whoCanHelp: [],
  },
  NOT_IMPLEMENTED: {
    status: 501,
    kind: 'NOT_ENABLED',
    whatHappened: 'This function is not available yet.',
    whatYouCanDo: ['Use another path for now.'],
    whoCanHelp: ['The system administrator'],
  },
  RATE_LIMITED: {
    status: 429,
    kind: 'LOCKED',
    whatHappened: 'Too many attempts in a short time.',
    whatYouCanDo: ['Wait a minute and try again.'],
    whoCanHelp: ['Your supervisor, if you are locked out'],
    controls: ['DI-19'],
    retryable: true,
  },
  INTERNAL: {
    status: 500,
    kind: 'NOT_SAVED',
    whatHappened: 'The server could not complete the request. Nothing was saved by it.',
    whatYouCanDo: ['Reload the record to see its current state, then try again.'],
    whoCanHelp: ['The system administrator (quote the correlation id)'],
    retryable: true,
  },
  'EBMR-SBX-*': {
    status: 503,
    kind: 'NOT_ENABLED',
    whatHappened: 'This installation is not connected to the right kind of database.',
    whatYouCanDo: ['Stop and report it; do not continue working on this installation.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-05'],
  },
  'EBMR-PLAT-041': {
    status: 409,
    kind: 'STALE',
    whatHappened: 'This request was already sent with different content.',
    whatYouCanDo: ['Reload the record; if your entry is not there, enter it again.'],
    whoCanHelp: [],
  },
  'EBMR-PLAT-042': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'This request belongs to another person’s action.',
    whatYouCanDo: ['Reload the record and enter your own entry.'],
    whoCanHelp: [],
  },
};
