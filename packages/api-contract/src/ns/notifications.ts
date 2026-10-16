/**
 * Namespace `notifications` (Phase 4 slice 3c, GMP): the notification centre (outline 7.3; control IN-39 clause 2, "both
 * departments are notified"). The database writes every notification in the transaction of the act that causes it
 * (recipe-core 0810: a manufacturer release or rejection notifies PRODUCTION and QA) and keeps it insert-only and
 * audited; a person of the notification's department acknowledges it (once, as themselves: FRESH_ON_SHARED on a shared
 * terminal). The list shows the notifications of the departments the session's role belongs to.
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

export const NotificationDepartment = z.enum(['PRODUCTION', 'QA']);
export type NotificationDepartment = z.infer<typeof NotificationDepartment>;

export const NotificationView = z.strictObject({
  notificationId: Uuid,
  department: NotificationDepartment,
  /** ENVIRONMENT_EXCURSION (Phase 6 slice 6f, recipe-core 1051): a room condition outside its limit during a batch. */
  event: z.enum(['MANUFACTURER_RELEASED', 'MANUFACTURER_REJECTED', 'ENVIRONMENT_EXCURSION']),
  subjectKind: z.enum(['FINISHED_LOT', 'BATCH']),
  subjectId: Uuid,
  subjectLabel: z.string().min(1),
  message: z.string().min(1),
  /** The signature that caused it (a release decision), and its signer. */
  signatureId: Uuid.optional(),
  /** The exception of the batch's register that caused it (an excursion), raised by `by`. */
  exceptionId: z.string().min(1).optional(),
  by: PersonRef,
  at: Instant,
  acknowledgements: z.array(z.strictObject({ by: PersonRef, at: Instant })),
  /** This person acknowledged it. */
  acknowledgedByMe: z.boolean(),
  /** This person may acknowledge it now (their role is of its department and they have not yet). */
  mayAcknowledge: z.boolean(),
});
export type NotificationView = z.infer<typeof NotificationView>;

export const notifications = {
  list: defineRoute({
    id: 'notifications.list',
    method: 'GET',
    path: '/api/notifications',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The notifications of the departments of the session\'s role (or, with subjectId, every notification about that subject), newest first',
    query: z.strictObject({ subjectId: Uuid.optional(), open: z.enum(['true', 'false']).optional() }),
    response: z.strictObject({ departments: z.array(NotificationDepartment), notifications: z.array(NotificationView) }),
  }),
  acknowledge: defineRoute({
    id: 'notifications.acknowledge',
    method: 'POST',
    path: '/api/notifications/:notificationId/acknowledgements',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'This person acknowledges a notification of their department',
    params: z.strictObject({ notificationId: Uuid }),
    body: withAttribution({}),
    response: NotificationView,
  }),
} as const;
