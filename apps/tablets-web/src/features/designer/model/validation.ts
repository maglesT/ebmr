/**
 * Debounced server validation of the content being edited (decision D10: the server validates in A1; plan section
 * 8: 600 ms after the last change). Each change cancels the request in flight; only the answer for the latest
 * content is shown. Validation writes nothing (POST without an idempotency key).
 */
import { useEffect, useRef, useState } from 'react';
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
  const [state, setState] = useState<ValidationState>({ report: null, pending: true, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const controller = new AbortController();
    setState((s) => ({ ...s, pending: true }));
    const timer = setTimeout(() => {
      void api.call(routes.designer.validate, { body: { versionId, content: asWire(content) }, signal: controller.signal }).then((r) => {
        if (mine !== seq.current) return;
        setState(r.ok ? { report: r.value, pending: false, error: null } : { report: null, pending: false, error: r.error });
      });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [versionId, content, generation, delayMs]);
  return state;
}
