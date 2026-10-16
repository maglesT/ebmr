/**
 * The reads the plant status screens show, read again after every act (route ids, so `useRefresh` invalidates each by
 * its prefix): an acknowledgment changes the alarm lists, the status board's and the room's open alarms; a spill changes
 * the room list and its conditions.
 */
import { routes } from '@ebmr/api-contract';

export const ALARM_READS: readonly string[] = [
  routes.alarms.list.id, routes.alarms.batchLog.id, routes.alarms.alarm.id, routes.equipmentDisplays.statusBoard.id, routes.plantRules.roomConditions.id,
];

export const ROOM_READS: readonly string[] = [routes.plantRules.rooms.id, routes.plantRules.roomConditions.id, routes.equipmentDisplays.statusBoard.id];

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');

/** A unit, room or line code as the contract accepts it (a filter that is not one is not sent). */
export const PLANT_CODE = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
