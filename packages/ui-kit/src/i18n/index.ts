import { EN, type MessageKey } from './en.ts';

export { EN, type MessageKey };

/** The English text of a key with {placeholders} filled in. */
export function t(key: MessageKey, params: Readonly<Record<string, string | number>> = {}): string {
  return EN[key].replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
