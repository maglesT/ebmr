/**
 * A catalog-test clause the owner's approved MODIFY decision left out of the control's minimum (`not_required`; lead
 * ruling, I-6, and lead audit of #241). Shared by register:validate (validate.ts) and the trace (trace.ts), and kept
 * apart from both so neither imports the other.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { ROOT, type ClauseRecord, type ControlRecord } from './register.ts';

/** Text compared word for word: runs of white space count as one space. */
export const words = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The path a not-required clause's decision starts with (lead audit of #241): an owner decision under docs/decisions/,
 * or a control-decisions.md under docs/build-plan/. No `..` segment, so the path cannot leave those folders.
 */
const DECISION_PATH = /^(docs\/(?:decisions\/[\w.-]+\.md|build-plan\/(?:[\w.-]+\/)*control-decisions\.md))(?=$|\s)/;

/** The fewest words a quoted reason may have, counted after white space is normalised (lead audit of #241). */
export const MIN_QUOTE_WORDS = 5;

/** A letter, digit or underscore: what a quote may not start or end next to, so it never cuts a word. */
const WORD_CHAR = '[\\p{L}\\p{N}_]';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `quote` occurs in `text` (both normalised) on whole-word boundaries at both ends. */
export function quotedWholeWords(text: string, quote: string): boolean {
  return new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(words(quote))}(?!${WORD_CHAR})`, 'u').test(words(text));
}

/**
 * The problems with a clause the approved decision left out (lead ruling, I-6; lead audit of #241): it is allowed on a
 * MODIFY control only; its decision starts with the path of an owner decision (docs/decisions/) or a
 * control-decisions.md (docs/build-plan/), which exists and names the control; and its reason, at least five words,
 * is quoted from that document word for word on whole-word boundaries, so the register cannot claim a decision the
 * document does not hold. The trace runs the same check (trace.ts).
 */
export function notRequiredErrors(c: ControlRecord, i: number, n: NonNullable<ClauseRecord['not_required']>, root: string = ROOT): string[] {
  const at = `${c.id}: clause ${i + 1} is marked not required`;
  if (c.expert_decision.status !== 'MODIFY') return [`${at}, but its expert decision is ${c.expert_decision.status}, not MODIFY`];
  // A malformed entry is the schema's error (reported above); this check reads only the strings it holds.
  if (typeof n.decision !== 'string' || typeof n.reason !== 'string') return [];
  const path = DECISION_PATH.exec(n.decision.trim())?.[1];
  if (path === undefined || path.split('/').includes('..')) {
    return [`${at}, but its decision does not start with the path of an owner decision (docs/decisions/) or a control-decisions.md (docs/build-plan/): "${n.decision}"`];
  }
  const file = resolve(root, path);
  const inside = relative(resolve(root, 'docs'), file);
  if (inside.startsWith('..') || isAbsolute(inside)) return [`${at}, but its decision document ${path} is outside docs/`];
  if (!existsSync(file) || !statSync(file).isFile()) return [`${at}, but its decision document ${path} does not exist`];
  const text = readFileSync(file, 'utf8');
  if (!new RegExp(`(?<![\\w-])${escapeRegExp(c.id)}(?![\\w-])`).test(text)) return [`${at}, but its decision document ${path} does not name ${c.id}`];
  const count = words(n.reason) === '' ? 0 : words(n.reason).split(' ').length;
  if (count < MIN_QUOTE_WORDS) return [`${at}, but its reason quotes ${count} word(s); at least ${MIN_QUOTE_WORDS} are needed: "${n.reason}"`];
  if (!quotedWholeWords(text, n.reason)) return [`${at}, but its reason is not quoted word for word, on whole words, from ${path}: "${n.reason}"`];
  return [];
}
