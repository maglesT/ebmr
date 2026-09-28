/**
 * Debounced server validation of the content being edited (decision D10: the server validates in A1; plan section
 * 8: 600 ms after the last change). Each change cancels the request in flight; only the answer for the latest
 * content is shown. Validation writes nothing (POST without an idempotency key).
 */
import { useEffect, useMemo, useState } from 'react';
import { routes, type CallError, type ValidationReportView } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { api } from '../../../api/client.ts';
import { asWire } from './wire.ts';

export const VALIDATE_DEBOUNCE_MS = 600;

export interface ValidationState {
  report: ValidationReportView | null;
  /** True while a newer content waits for its answer. */
  pending: boolean;
  error: CallError | null;
}

export function useDebouncedValidation(versionId: string, content: flow.MbrContent, generation: number, delayMs = VALIDATE_DEBOUNCE_MS): ValidationState {
  // One token per request subject; the answer shown is the latest one, and it is pending while it is for an older token.
  const token = useMemo(() => ({ versionId, content, generation }), [versionId, content, generation]);
  const [answer, setAnswer] = useState<{ token: object; report: ValidationReportView | null; error: CallError | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api.call(routes.designer.validate, { body: { versionId: token.versionId, content: asWire(token.content) }, signal: controller.signal }).then((r) => {
        if (controller.signal.aborted) return;
        setAnswer(r.ok ? { token, report: r.value, error: null } : { token, report: null, error: r.error });
      });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [token, delayMs]);
  return { report: answer?.report ?? null, pending: answer?.token !== token, error: answer?.token === token ? answer.error : null };
}
