/**
 * The unsaved authoring draft (decision D7): while an author edits a DRAFT version, the unsaved content is kept in
 * this browser's localStorage so a reload or a closed tab loses nothing. It holds MBR content only, keyed by version
 * and the revision it was based on. Never signatures, credentials, tokens, approval or verification state, and
 * never anything executed. A restored draft is shown as UNSAVED until the author saves it as a new revision (which
 * the server checks like any other save: 409 when the revision it was based on is no longer the latest).
 */
import { flow } from '@ebmr/recipe-core/pure';

export const DRAFT_FORMAT = 'ebmr.designer-draft';

export interface Draft {
  format: typeof DRAFT_FORMAT;
  formatVersion: 1;
  versionId: string;
  /** The saved revision the edits started from. */
  baseRevision: number;
  /** Its content hash (to tell the draft apart from the saved content). */
  baseHash: string;
  content: flow.MbrContent;
}

/** The part of the Storage API the draft needs (window.localStorage, or a stand-in in tests). */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const draftKey = (versionId: string): string => `ebmr.designer.draft.v1.${versionId}`;

function storage(): DraftStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Stores the unsaved content; returns false when the browser refuses (private mode, quota). */
export function saveDraft(d: Omit<Draft, 'format' | 'formatVersion'>, s: DraftStorage | null = storage()): boolean {
  if (!s) return false;
  const value: Draft = { format: DRAFT_FORMAT, formatVersion: 1, versionId: d.versionId, baseRevision: d.baseRevision, baseHash: d.baseHash, content: d.content };
  try {
    s.setItem(draftKey(d.versionId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** The stored draft of a version, or null (anything malformed or not well-formed MBR content is dropped). */
export function loadDraft(versionId: string, s: DraftStorage | null = storage()): Draft | null {
  if (!s) return null;
  let raw: string | null;
  try {
    raw = s.getItem(draftKey(versionId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Draft>;
    const keys = Object.keys(d).sort().join(',');
    if (keys !== 'baseHash,baseRevision,content,format,formatVersion,versionId' || d.format !== DRAFT_FORMAT || d.formatVersion !== 1 || d.versionId !== versionId) throw new Error('not a draft');
    if (typeof d.baseRevision !== 'number' || typeof d.baseHash !== 'string') throw new Error('not a draft');
    const parsed = flow.parseMbr(d.content);
    if (!parsed.ok) throw new Error('not MBR content');
    return { format: DRAFT_FORMAT, formatVersion: 1, versionId, baseRevision: d.baseRevision, baseHash: d.baseHash, content: parsed.mbr };
  } catch {
    clearDraft(versionId, s);
    return null;
  }
}

export function clearDraft(versionId: string, s: DraftStorage | null = storage()): void {
  try {
    s?.removeItem(draftKey(versionId));
  } catch {
    // Nothing to clear.
  }
}
