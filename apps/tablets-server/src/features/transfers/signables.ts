/**
 * The signed acts of the transfers namespace (Phase 6 slice 6i). Each signs the record the database act works on and
 * runs that act with the signature in the same transaction; the database decides and a refusal signs nothing
 * (esig/db-acts.ts).
 *
 *   TRANSFER_RECEIPT_DECIDE    transfer_receipt <id>   TRANSFER_RECEIPT_ACCEPTED or _REFUSED (local QA), state RECEIVED
 *                              site.decide_transfer_receipt (site services 0981; L-41, DI-39)
 *   PEER_INSTALLATION_APPROVE  peer_installation <id>  PEER_INSTALLATION_APPROVED (QA), state PROPOSED
 *                              platform.approve_peer_installation (kernel 1220; DI-31)
 */
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type ReceiptDecide = Extract<SignableAction, { kind: 'TRANSFER_RECEIPT_DECIDE' }>;
type PeerApprove = Extract<SignableAction, { kind: 'PEER_INSTALLATION_APPROVE' }>;

export function receiptDecideHandler(app: AppContext): SignableActionHandler<ReceiptDecide> {
  return dbActHandler<ReceiptDecide>(app, {
    kind: 'TRANSFER_RECEIPT_DECIDE',
    aggregateTypes: ['transfer_receipt'],
    target: (a) => ({ aggregateType: 'transfer_receipt', aggregateId: a.receiptId, meaning: `TRANSFER_RECEIPT_${a.decision}`, expectedState: 'RECEIVED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select site.decide_transfer_receipt($1, $2, $3, $4)', [a.receiptId, a.decision, signatureId, a.reason ?? null]);
      return { receiptId: a.receiptId, decision: a.decision };
    },
  });
}

export function peerApproveHandler(app: AppContext): SignableActionHandler<PeerApprove> {
  return dbActHandler<PeerApprove>(app, {
    kind: 'PEER_INSTALLATION_APPROVE',
    aggregateTypes: ['peer_installation'],
    target: (a) => ({ aggregateType: 'peer_installation', aggregateId: a.peerId, meaning: 'PEER_INSTALLATION_APPROVED', expectedState: 'PROPOSED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select platform.approve_peer_installation($1, $2)', [a.peerId, signatureId]);
      return { peerId: a.peerId };
    },
  });
}
