/**
 * Engine texts as people read them (lead TODO T4 of the Phase 2 exit; DI-34). The engine and the blocks write their
 * refusals and exception titles with the MBR's internal ids: step keys ("p-disp-pcm@"), step ids, item ids
 * ("pcmDispensed") and person ids. A screen names the step by its document number and name ("1.1.5 Paracetamol
 * dispensing"), the item by its name and the person by their name.
 *
 * Display only: the stored refusal, the exception's recorded title and every signed content keep the engine's own
 * text (the record is never rewritten; DI-37). Only ids the MBR or the record knows are replaced, as whole tokens; a
 * step or item id that reads as an ordinary word (lower-case letters only, such as "mix" or "net") is replaced only
 * where the text names it as a step ("step mix"), never inside a sentence.
 */
import { engine, flow } from '@ebmr/recipe-core';

export interface PeopleTextContext {
  def: engine.BatchDefinition;
  /** The name of a person id the record knows, else null (the id is then left as it is). */
  person?: (id: string) => string | null;
}

/** An id that cannot be mistaken for a word of the sentence: it carries a digit, a capital, '-', '_' or '/'. */
const IDENTIFIER_LIKE = /[0-9A-Z_/-]/;
const PERSON_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A token holding '@': a step key, possibly followed by a sentence's punctuation. */
const STEP_KEY_TOKEN = /[^\s'"(),;:@]+@[^\s'"(),;:]*/g;
const FRAME = /^([^=]+)=(0|[1-9][0-9]{0,8})(?:\/(.*))?$/s;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function framesOf(context: string): flow.Frame[] | null {
  const frames: flow.Frame[] = [];
  let rest = context;
  while (rest.length > 0) {
    const m = FRAME.exec(rest);
    if (!m) return null;
    frames.push({ construct: m[1] ?? '', index: Number(m[2]) });
    rest = m[3] ?? '';
  }
  return frames;
}

/** The engine's text with the ids it names replaced by what people call them. */
export function peopleText(c: PeopleTextContext, text: string): string {
  const numbering = engine.numberingOf(c.def);
  const label = (stepId: string, frames: readonly flow.Frame[]): string => {
    const name = numbering.byId.get(stepId)?.name ?? c.def.steps.get(stepId)?.node.name ?? stepId;
    return `${flow.instanceNumber(numbering, stepId, frames).text} ${name}`;
  };
  // Replacements go in as placeholders first, so a name put in is never read again as an id.
  const put: string[] = [];
  const hold = (s: string): string => `\u0000${put.push(s) - 1}\u0000`;
  const asStep = (before: string, stepId: string, frames: readonly flow.Frame[]): string => (/\b[Ss]tep $/.test(before) ? hold(label(stepId, frames)) : hold(`step ${label(stepId, frames)}`));

  // Step keys: "<step>@<construct>=<index>/...", a sentence's full stop or comma after it left in place.
  let out = text.replace(STEP_KEY_TOKEN, (token, offset: number, whole: string) => {
    const trail = /[.]*$/.exec(token)?.[0] ?? '';
    const key = trail ? token.slice(0, token.length - trail.length) : token;
    const at = key.indexOf('@');
    const stepId = key.slice(0, at);
    const frames = framesOf(key.slice(at + 1));
    if (!c.def.steps.has(stepId) || frames === null) return token;
    return `${asStep(whole.slice(0, offset), stepId, frames)}${trail}`;
  });

  // Step ids without a key: always after "step"; elsewhere only when the id cannot be read as a word.
  const stepIds = [...c.def.steps.keys()].sort((a, b) => b.length - a.length);
  for (const id of stepIds) {
    const re = new RegExp(`(?<![\\w@/-])(${escape(id)})(?![\\w@/-])`, 'g');
    out = out.replace(re, (match, _id: string, offset: number, whole: string) => {
      const before = whole.slice(0, offset);
      if (/\b[Ss]tep $/.test(before) || IDENTIFIER_LIKE.test(id)) return asStep(before, id, []);
      return match;
    });
  }

  // Item ids (parameters, calculations, yield results) that cannot be read as a word.
  const items = new Map<string, string>();
  for (const p of c.def.mbr.parameters) items.set(p.id, p.name);
  for (const k of c.def.mbr.calculations) items.set(k.id, k.name);
  for (const y of c.def.mbr.yieldCheckpoints) if (!items.has(y.result)) items.set(y.result, y.name);
  for (const [id, name] of [...items].sort((a, b) => b[0].length - a[0].length)) {
    if (!IDENTIFIER_LIKE.test(id) || id === name) continue;
    out = out.replace(new RegExp(`(?<![\\w@/-])${escape(id)}(?![\\w@/-])`, 'g'), () => hold(name));
  }

  // Person ids the record knows.
  if (c.person) {
    const person = c.person;
    out = out.replace(PERSON_ID, (id) => {
      const name = person(id);
      return name ? hold(name) : id;
    });
  }
  // eslint-disable-next-line no-control-regex -- U+0000 marks the placeholders put in above; engine text never holds it.
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => put[Number(i)] ?? '');
}
