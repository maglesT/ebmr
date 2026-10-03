/**
 * JSON request bodies are UTF-8 that decodes exactly (review F33). Fastify's own parser reads a body through a replacing
 * decoder: a byte sequence that stands for no character became U+FFFD, a character the client never sent, and a record
 * stored it as if it had. Such a body is refused (400, answered as a SCHEMA refusal), before any hook, validation or
 * handler sees it; every other body goes to Fastify's own JSON parser, which refuses prototype and constructor
 * poisoning as before. The text then meets the contract's check (storableText): no U+0000, no lone surrogate.
 */
import type { FastifyInstance } from 'fastify';

export const NOT_UTF8_BODY = 'The request body is not UTF-8 text: a byte sequence in it stands for no character, so it was not read.';

export function installStrictJsonBodies(app: FastifyInstance): void {
  const parse = app.getDefaultJsonParser('error', 'error');
  // ignoreBOM: a byte order mark stays in the text, as Fastify's own reading kept it (and the JSON parser decides).
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    let text: string;
    try {
      text = decoder.decode(body as Buffer);
    } catch {
      done(Object.assign(new Error(NOT_UTF8_BODY), { statusCode: 400 }), undefined);
      return;
    }
    void parse(request, text, done);
  });
}
