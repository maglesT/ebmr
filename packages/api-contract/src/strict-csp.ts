/**
 * Import this module FIRST in the browser entry (`import '@ebmr/api-contract/strict-csp'`): zod decides at
 * schema construction whether to compile parsers with `new Function`, and even its capability probe is reported
 * as a CSP violation under script-src 'self'. Running jitless keeps the SPA free of eval (plan section 5).
 */
import { z } from 'zod';

z.config({ jitless: true });
