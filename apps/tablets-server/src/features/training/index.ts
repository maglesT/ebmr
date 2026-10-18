/**
 * Feature `training` (Phase 6 slice 6g, SANDBOX only; DI-05, INV-18; D-P6g-2, D-P6g-0-9): training mode is the sandbox
 * installation with its TEST, NOT GMP watermark, the sandbox personas and the scripted exercises (exercises.ts). The
 * person's attempts are kept in the sandbox (kernel 1211: sandbox.start_training, sandbox.complete_training_step,
 * refused in a GMP database). The feature is registered on the sandbox only, and its routes are SANDBOX routes, so a
 * GMP server answers 404.
 */
import { routes, type TrainingAttemptView, type TrainingOverviewView } from '@ebmr/api-contract';
import { sandbox } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { GuidanceEntry } from '../../platform/http/guidance.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { usOf } from '../common/people.ts';
import { EXERCISES, exerciseOf } from './exercises.ts';

type Db = Pick<pg.Pool, 'query'>;

export const guidance: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-SBX-039': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'Training runs only on the sandbox installation; nothing of it is kept in a GMP database.',
    whatYouCanDo: ['Open the training (sandbox) installation, marked TEST, NOT GMP.'],
    whoCanHelp: ['The system administrator'],
    controls: ['DI-05'],
  },
  'EBMR-SBX-040': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no such step in a training attempt of yours.',
    whatYouCanDo: ['Open the exercise again and mark one of its own steps.'],
    whoCanHelp: ['Your trainer'],
    controls: ['DI-05'],
  },
  'EBMR-TRN-001': {
    status: 404,
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no such training exercise.',
    whatYouCanDo: ['Choose an exercise from the training page.'],
    whoCanHelp: ['Your trainer'],
    controls: ['DI-05'],
  },
};

interface AttemptRow {
  id: string;
  exercise_code: string;
  exercise_version: number;
  step_count: number;
  started_us: string;
  done: number[];
}

const ATTEMPT_SQL = `select a.id, a.exercise_code, a.exercise_version, a.step_count, ${usOf('a.started_at')} as started_us,
       coalesce((select array_agg(s.step_no order by s.step_no) from sandbox.training_step s where s.attempt_id = a.id), '{}') as done
  from sandbox.training_attempt a`;

const attemptView = (app: AppContext, r: AttemptRow): TrainingAttemptView => ({
  attemptId: r.id,
  exerciseCode: r.exercise_code,
  exerciseVersion: r.exercise_version,
  startedAt: app.formatInstant(r.started_us),
  done: r.done,
  complete: r.done.length >= r.step_count,
});

/**
 * One training attempt of the person (Phase 7 slice 7b-1, 6jc-R15; DI-05): another person's attempt, or none with this
 * id, is refused as EBMR-SBX-040 (the same answer as the database's sandbox.complete_training_step), never shown.
 */
export async function trainingAttemptOf(app: AppContext, db: Db, id: string, personId: string): Promise<TrainingAttemptView> {
  const { rows } = await db.query<AttemptRow>(`${ATTEMPT_SQL} where a.id = $1 and a.person_id = $2`, [id, personId]);
  const row = rows[0];
  if (row === undefined) {
    throw refusal(404, { code: 'EBMR-SBX-040', kind: 'INVALID_INPUT', whatHappened: 'There is no training attempt of yours with this id.', whatYouCanDo: ['Open the exercise again from the training page.'] });
  }
  return attemptView(app, row);
}

async function overview(app: AppContext, db: Db, personId: string): Promise<TrainingOverviewView> {
  const { rows: personas } = await db.query<{ person_id: string; legal_name: string; login_name: string; roles: string[] }>(
    `select p.id as person_id, p.legal_name, a.login_name,
            coalesce((select array_agg(distinct g.role_code order by g.role_code) from iam.role_grant g
                       where g.account_id = a.id and g.status = 'APPROVED' and (g.valid_to is null or g.valid_to > clock_timestamp())), '{}') as roles
       from iam.person p join iam.account a on a.person_id = p.id
      where p.kind = 'NATURAL' and p.status = 'ACTIVE' and a.kind = 'HUMAN' and a.status = 'ACTIVE' and p.legal_name like 'TEST-%'
      order by p.legal_name, a.login_name`,
  );
  const { rows: attempts } = await db.query<AttemptRow>(`${ATTEMPT_SQL} where a.person_id = $1 order by a.started_at desc, a.id`, [personId]);
  const watermark = sandbox.watermarkFor('TRAINING');
  if (watermark === null) throw new Error('training needs the TEST, NOT GMP watermark (DI-05)');
  return {
    watermark,
    personas: personas.filter((p) => p.roles.length > 0).map((p) => ({ personId: p.person_id, legalName: p.legal_name, loginName: p.login_name, roles: p.roles })),
    exercises: EXERCISES.map((e) => ({
      code: e.code,
      version: e.version,
      title: e.title,
      summary: e.summary,
      roles: [...e.roles],
      steps: e.steps.map((s) => ({ ...s })),
      attempts: attempts.filter((a) => a.exercise_code === e.code).map((a) => attemptView(app, a)),
    })),
  };
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.training, {
    overview: async ({ requireSession }) => {
      const s = requireSession();
      return overview(app, pool, s.personId);
    },
    start: async ({ body, actor, requireSession, idempotencyKey, requestHash }) => {
      const exercise = exerciseOf(body.exerciseCode);
      if (exercise === undefined) {
        throw refusal(404, { code: 'EBMR-TRN-001', kind: 'INVALID_INPUT', whatHappened: `There is no training exercise ${body.exerciseCode}.`, whatYouCanDo: ['Choose an exercise from the training page.'] });
      }
      const { result: id } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) =>
        (await c.query<{ id: string }>('select sandbox.start_training($1, $2, $3)::text as id', [exercise.code, exercise.version, exercise.steps.length])).rows[0]!.id,
      );
      return trainingAttemptOf(app, pool, id, requireSession().personId);
    },
    completeStep: async ({ params, body, actor, requireSession, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) =>
        (await c.query<{ done: boolean }>('select sandbox.complete_training_step($1, $2) as done', [params.attemptId, body.step])).rows[0]!.done,
      );
      return trainingAttemptOf(app, pool, params.attemptId, requireSession().personId);
    },
  });
  return Promise.resolve();
}
