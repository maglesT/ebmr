/**
 * The local signing bridge of the India DSC (Phase 6 slice 6f; IN-10, D-P6f-3): the signer's Class 3 token signs on this
 * client, never on the server. The bridge is a small program on the signer's PC (the token vendor's middleware behind a
 * localhost endpoint) that signs the statement's UTF-8 with the token's key and returns the signature and the
 * certificate chain; the server then verifies the chain against the configured anchor before anything is stored.
 *
 * A page may install its own bridge on `window.ebmrDscBridge` (the demo's test-CA token simulator, the tests); otherwise
 * the default posts the statement to the bridge on 127.0.0.1. No private key ever reaches the browser or the server.
 */
import type { DscSubmission } from '@ebmr/api-contract';

export interface DscBridge {
  sign(statement: string): Promise<DscSubmission>;
}

declare global {
  interface Window {
    ebmrDscBridge?: DscBridge;
  }
}

/** The default local bridge endpoint (the token middleware listens on the loopback interface only). */
export const DSC_BRIDGE_URL = 'http://127.0.0.1:8746/sign';

const httpBridge: DscBridge = {
  async sign(statement) {
    const r = await fetch(DSC_BRIDGE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ statement }) });
    if (!r.ok) throw new Error(`the signing token answered ${r.status}`);
    return (await r.json()) as DscSubmission;
  },
};

export function dscBridge(): DscBridge {
  return (typeof window !== 'undefined' && window.ebmrDscBridge) || httpBridge;
}
