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
  receive: {
    'opcua.endpoint_session': 'plant.receive_opcua_endpoint_session',
    'opcua.series_chunk': 'plant.receive_series_chunk',
    'opcua.alarm': 'plant.receive_equipment_alarm',
    'opcua.equipment_event': 'plant.receive_equipment_event',
  },
  mirrorClasses: [],
  contract: OPCUA,
};
