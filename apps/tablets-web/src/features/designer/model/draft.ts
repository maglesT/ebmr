/**
 * The unsaved authoring draft (decision D7): while an author edits a DRAFT version, the unsaved content is kept in
 * this browser's localStorage so a reload or a closed tab loses nothing. It holds MBR content only, keyed by the
 * person who made it, the version and the revision it was based on. Never signatures, credentials, tokens, approval
 * or verification state, and never anything executed. A restored draft is shown as UNSAVED until the author saves it
 * as a new revision (which the server checks like any other save: 409 when the revision it was based on is no longer
 * the latest).
 *
 * A draft belongs to the person who made it (review F50; DI-04, PR-02, PR-06): it is stored under that person's id and
 * offered to nobody else, so on a shared office PC another author can neither see a colleague's unsaved edits nor save
 * them as their own revision, and a checker never sees them in place of the saved content. Every designer draft in
 * this browser is removed when someone signs out here (boot.tsx), and drafts kept before the person was part of the
 * key (format 1) are never offered: their author is unknown.
 */
import { flow } from '@ebmr/recipe-core/pure';

export const DRAFT_FORMAT = 'ebmr.designer-draft';

export interface Draft {
  format: typeof DRAFT_FORMAT;
  formatVersion: 2;
  /** The signed-in person who made the edits (the only person the draft is ever offered to). */
  personId: string;
  versionId: string;
  /** The saved revision the edits started from. */
  baseRevision: number;
  /** Its content hash (to tell the draft apart from the saved content). */
  baseHash: string;
  content: flow.MbrContent;
}

/** The part of the Storage API the draft needs (window.localStorage, or a stand-in in tests). */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Every designer draft key starts with this (format 1 and 2), so a sign-out can remove them all. */
export const DRAFT_KEY_PREFIX = 'ebmr.designer.draft.';

export const draftKey = (personId: string, versionId: string): string => `${DRAFT_KEY_PREFIX}v2.${personId}.${versionId}`;

/** The key of a format-1 draft (keyed by version only, its author unknown): never offered, removed when seen. */
export const legacyDraftKey = (versionId: string): string => `${DRAFT_KEY_PREFIX}v1.${versionId}`;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Stores the unsaved content; returns false when the browser refuses (private mode, quota) or nobody is signed in. */
export function saveDraft(d: Omit<Draft, 'format' | 'formatVersion'>, s: DraftStorage | null = storage()): boolean {
  if (!s || d.personId === '') return false;
  const value: Draft = { format: DRAFT_FORMAT, formatVersion: 2, personId: d.personId, versionId: d.versionId, baseRevision: d.baseRevision, baseHash: d.baseHash, content: d.content };
  try {
    s.setItem(draftKey(d.personId, d.versionId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * The stored draft of a version made by this person, or null. Anything malformed, not well-formed MBR content, or
 * naming another person or version is dropped; a format-1 draft of the version (its author unknown) is removed.
 */
export function loadDraft(personId: string, versionId: string, s: DraftStorage | null = storage()): Draft | null {
  if (!s) return null;
  try {
    s.removeItem(legacyDraftKey(versionId));
  } catch {
    // Nothing to remove.
  }
  if (personId === '') return null;
  let raw: string | null;
  try {
    raw = s.getItem(draftKey(personId, versionId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Draft>;
    const keys = Object.keys(d).sort().join(',');
    if (keys !== 'baseHash,baseRevision,content,format,formatVersion,personId,versionId' || d.format !== DRAFT_FORMAT || d.formatVersion !== 2) throw new Error('not a draft');
    if (d.personId !== personId || d.versionId !== versionId) throw new Error('not this person\'s draft of this version');
    if (typeof d.baseRevision !== 'number' || typeof d.baseHash !== 'string') throw new Error('not a draft');
    const parsed = flow.parseMbr(d.content);
    if (!parsed.ok) throw new Error('not MBR content');
    return { format: DRAFT_FORMAT, formatVersion: 2, personId, versionId, baseRevision: d.baseRevision, baseHash: d.baseHash, content: parsed.mbr };
  } catch {
    clearDraft(personId, versionId, s);
    return null;
  }
}

export function clearDraft(personId: string, versionId: string, s: DraftStorage | null = storage()): void {
  try {
    s?.removeItem(draftKey(personId, versionId));
  } catch {
    // Nothing to clear.
  }
}

/** Removes every designer draft this browser keeps, whoever made it (at sign-out). */
export function clearAllDrafts(s: Pick<Storage, 'key' | 'length' | 'removeItem'> | null = storage()): void {
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k !== null && k.startsWith(DRAFT_KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // A store that cannot be used holds no draft.
  }
}
