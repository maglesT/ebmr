/**
 * JSON request bodies are UTF-8 that decodes exactly (review F33). Fastify's own parser reads a body through a replacing
 * decoder: a byte sequence that stands for no character became U+FFFD, a character the client never sent, and a record
 * stored it as if it had. Such a body is refused (400, answered as a SCHEMA refusal), before any hook, validation or
 * handler sees it; every other body goes to Fastify's own JSON parser, which refuses prototype and constructor
 * poisoning as before. The text then meets the contract's check (storableText): no U+0000, no lone surrogate.
 * Installed on the browser routes' server (app.ts) and on the gateway listener (devices/listener.ts), which is a
 * Fastify instance of its own (review F33, round 2).
 */
import type { FastifyInstance } from 'fastify';

export const NOT_UTF8_BODY = 'The request body is not UTF-8 text: a byte sequence in it stands for no character, so it was not read.';

/** A JSON body refused because its bytes are not UTF-8 (400): nothing of it was read. */
export class NotUtf8BodyError extends Error {
  readonly statusCode = 400;
  constructor() {
    super(NOT_UTF8_BODY);
    this.name = 'NotUtf8BodyError';
  }
}

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
      done(new NotUtf8BodyError(), undefined);
      return;
    }
    void parse(request, text, done);
  });
}
