/**
 * The OPC UA adapter (Phase 6 slice 6b; DI-20, DI-31, DI-32, DI-49; D-P6b-0-1): the server's worker over the site
 * gateway's OPC UA feed (apps/site-gateway/src/opcua-feed.ts, the 6a feed protocol under <root>/opcua/v1). The
 * released tags' values do not come this way: they stay process readings on the gateway uplink (tablets 0820, 1210).
 * This feed carries what the drivers receive besides them, each to its receiving command of the database:
 *
 *   opcua.endpoint_session  plant.receive_opcua_endpoint_session (recipe-core 0961): the session judged against the
 *                           enrolment and the device registry; a refused session raises a WRONG_IDENTITY alarm and
 *                           every later data message of that endpoint is refused until a valid session follows (DI-20)
 *   opcua.series_chunk      plant.receive_series_chunk (0960): native samples as received, hash recomputed (DI-32)
 *   opcua.alarm             plant.receive_equipment_alarm (0960): occurrences that are not tag readings (DI-49)
 *   opcua.equipment_event   plant.receive_equipment_event (0960): state, recipe and fault events in batch context
 *   opcua.series_gap        plant.receive_series_gap (1232, slice 7b-1): what the gateway could not record after a
 *                           crash (unit, tag, interval) raises a SERIES_GAP alarm (DI-32, DI-31)
 *
 * Phase 7 slice 7a (6jc-R9; DI-31): the gateway signs every envelope of the feed (gatewaySignature, SDK
 * feed-signature.ts) and the worker hands each to tab.accept_gateway_envelope (tablets 1405), which checks the signature
 * against the ACTIVE key of the gateway bound to this adapter (tab.gateway_feed_binding) and only then calls the
 * receiving command above for its type; the kernel refuses an OPCUA envelope that reaches any receiving command without
 * that check in the same transaction (kernel 1305, EBMR-INT-030). Refusals EBMR-INT-030 to -033 are WRONG_IDENTITY.
 *
 * Refusals are recorded by the framework worker with their class and alarm (6a pattern); a session refusal is applied
 * (the session is kept, judged REFUSED), so it is ACCEPTED as a message and its verdict acts on the data after it.
 *
 * No mirror data class (D-P6b-L-1): like the EMS, the adapter runs when the site connects its external systems (any data
 * class in MIRROR); a STAND_IN site starts no adapter at all (adapters/start.ts).
 */
import { OPCUA } from '@ebmr/integration-sdk/adapter';
import type { FeedAdapterSpec } from '../framework.ts';

export const OPCUA_ADAPTER: FeedAdapterSpec = {
  system: 'OPCUA',
  prefix: 'opcua',
  // Slice 7a (6jc-R9): every envelope goes through the database's verifier of the gateway's signature, which calls the
  // receiving command of its type (header); json, so the database checks the payload's hash on its text as sent.
  receive: {
    'opcua.endpoint_session': 'tab.accept_gateway_envelope',
    'opcua.series_chunk': 'tab.accept_gateway_envelope',
    'opcua.alarm': 'tab.accept_gateway_envelope',
    'opcua.equipment_event': 'tab.accept_gateway_envelope',
    // Slice 7b-1 (tablets 1432, recipe-core 1232): a stretch of a series the gateway could not record (SERIES_GAP).
    'opcua.series_gap': 'tab.accept_gateway_envelope',
  },
  envelopeType: 'json',
  mirrorClasses: [],
  contract: OPCUA,
};
