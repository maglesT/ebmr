/**
 * Feature `notifications` (Phase 4 slice 3c, GMP): the notification centre (contract ns/notifications.ts; recipe-core
 * 0810; control IN-39 clause 2). The database writes each notification in the transaction of the act that causes it (a
 * manufacturer release or rejection notifies PRODUCTION and QA) and decides who may acknowledge one; this feature reads
 * them for the session's departments and runs the acknowledgement as the person's own command.
 */
import { routes, type NotificationDepartment, type NotificationView } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

interface Row {
  id: string;
  department: NotificationDepartment;
  event: NotificationView['event'];
  subject_id: string;
  subject_label: string;
  message: string;
  cause_signature_id: string;
  caused_by_person: string;
  caused_by_role: string;
  at_us: string;
  acks: { person: string; role: string; us: string }[];
}

/** The departments a role belongs to (recipe.notification_department_role). */
export async function departmentsOf(db: Db, role: string | null): Promise<NotificationDepartment[]> {
  if (role === null) return [];
  const { rows } = await db.query<{ d: NotificationDepartment }>('select department as d from recipe.notification_department_role where role_code = $1 order by department', [role]);
  return rows.map((r) => r.d);
}

/** Notifications by department, by subject or by id, newest first, as views for `me`. */
export async function notificationViews(
  app: AppContext,
  db: Db,
  me: { personId: string; departments: readonly NotificationDepartment[] },
  filter: { departments?: readonly string[]; subjectId?: string; id?: string; openForMe?: boolean },
): Promise<NotificationView[]> {
  const { rows } = await db.query<Row>(
    `select n.id, n.department, n.event, n.subject_id, n.subject_label, n.message, n.cause_signature_id, n.caused_by_person, n.caused_by_role,
            ${usOf('n.created_at')} as at_us,
            coalesce((select jsonb_agg(jsonb_build_object('person', a.person_id, 'role', a.role_code, 'us', ${usOf('a.acknowledged_at')}) order by a.acknowledged_at)
                      from recipe.notification_acknowledgement a where a.notification_id = n.id), '[]'::jsonb) as acks
     from recipe.notification n
     where ($1::text[] is null or n.department = any ($1::text[]))
       and ($2::uuid is null or n.subject_id = $2::uuid)
       and ($3::uuid is null or n.id = $3::uuid)
     order by n.created_at desc, n.department
     limit 500`,
    [filter.departments ?? null, filter.subjectId ?? null, filter.id ?? null],
  );
  const people = await peopleOf(db, [...rows.map((r) => r.caused_by_person), ...rows.flatMap((r) => r.acks.map((a) => a.person))]);
  const views = rows.map((r): NotificationView => {
    const mine = r.acks.some((a) => a.person === me.personId);
    return {
      notificationId: r.id,
      department: r.department,
      event: r.event,
      subjectKind: 'FINISHED_LOT',
      subjectId: r.subject_id,
      subjectLabel: r.subject_label,
      message: r.message,
      signatureId: r.cause_signature_id,
      by: personRef(people, r.caused_by_person, r.caused_by_role),
      at: app.formatInstant(r.at_us),
      acknowledgements: r.acks.map((a) => ({ by: personRef(people, a.person, a.role), at: app.formatInstant(a.us) })),
      acknowledgedByMe: mine,
      mayAcknowledge: !mine && me.departments.includes(r.department),
    };
  });
  return filter.openForMe ? views.filter((v) => v.mayAcknowledge) : views;
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.notifications, {
    list: async ({ query, requireSession }) => {
      const s = requireSession();
      const departments = await departmentsOf(pool, s.roleCode);
      const me = { personId: s.personId, departments };
      // About one subject: every department's notifications (the cockpit shows that both were notified); otherwise the
      // session's own departments.
      const notifications = await notificationViews(app, pool, me, {
        ...(query.subjectId !== undefined ? { subjectId: query.subjectId } : { departments }),
        openForMe: query.open === 'true',
      });
      return { departments, notifications };
    },
    acknowledge: async ({ params, actor, requireSession, idempotencyKey, requestHash }) => {
      const s = requireSession();
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.acknowledge_notification($1)', [params.notificationId]);
        return params.notificationId;
      });
      const [view] = await notificationViews(app, pool, { personId: s.personId, departments: await departmentsOf(pool, s.roleCode) }, { id: params.notificationId });
      if (!view) {
        throw refusal(404, { code: 'EBMR-NTF-002', kind: 'INVALID_INPUT', whatHappened: 'The notification was not found.', why: 'There is no such notification.', whatYouCanDo: ['Reload the notification centre.'] });
      }
      return view;
    },
  });
  return Promise.resolve();
}
