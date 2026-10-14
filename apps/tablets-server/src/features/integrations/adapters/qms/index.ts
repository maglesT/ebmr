/**
 * The QMS adapter (Phase 6 slice 6a, builder B; D-P6a-3, D-P6a-6): qms.deviation_status, qms.capa and
 * qms.change_control to the receiving commands of site services 0925; its heartbeat keeps the QMS_STATUS mirror fresh.
 * The release does not trust the mirror alone: qmsReleaseFetch asks the QMS for the lot's status live, with version
 * tokens, inside the release signing transaction and records the answer (site.record_qms_release_fetch), which the
 * database's release guard requires (recipe-core 0951). A QMS that cannot be reached, answers late or cuts the answer
 * refuses the release (EBMR-QMS-020), naming the QMS and who to call.
 */
import { QMS } from '@ebmr/integration-sdk/adapter';
import type pg from 'pg';
import { refusal } from '../../../../platform/http/refusal.ts';
import type { FeedAdapterSpec } from '../framework.ts';

export const QMS_ADAPTER: FeedAdapterSpec = {
  system: 'QMS',
  prefix: 'qms',
  receive: {
    'qms.deviation_status': 'site.receive_qms_deviation_status',
    'qms.capa': 'site.receive_qms_capa',
    'qms.change_control': 'site.receive_qms_change_control',
  },
  mirrorClasses: ['QMS_STATUS'],
  contract: QMS,
};

export interface QmsLink {
  /** The QMS's base URL (EBMR_QMS_URL); unset: no QMS configured. */
  baseUrl: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** The QMS link from the environment (EBMR_QMS_URL, EBMR_QMS_TIMEOUT_MS; default 2000 ms). */
export function qmsLinkFromEnv(env: NodeJS.ProcessEnv = process.env): QmsLink {
  const t = Number(env['EBMR_QMS_TIMEOUT_MS'] ?? '2000');
  return { baseUrl: env['EBMR_QMS_URL'] && env['EBMR_QMS_URL'] !== '' ? env['EBMR_QMS_URL'] : null, timeoutMs: Number.isInteger(t) && t > 0 ? t : 2000 };
}

const unreachable = (why: string) =>
  refusal(
    503,
    {
      code: 'EBMR-QMS-020',
      kind: 'NOT_ALLOWED',
      whatHappened: 'The QMS could not be asked for the lot\'s status, so the release is refused. Nothing was signed.',
      why: `The release fetches the lot's QMS status live inside the signing (D-P6a-3): ${why}`,
      controls: ['DI-31', 'IN-05'],
      whatYouCanDo: ['Try again when the QMS answers.', 'Check the integration health page for the QMS adapter.'],
      whoCanHelp: ['The QMS system owner', 'The system administrator (integrations)'],
    },
    true,
  );

/**
 * In MIRROR mode, asks the QMS for the lot's deviations with their version tokens and records the answer in the
 * signing transaction (`client`); in STAND_IN nothing is fetched. Throws a refusal naming the QMS when it cannot be
 * reached; the database refuses a changed token (EBMR-QMS-011) and an open deviation (EBMR-QMS-015 at the decision).
 */
export async function qmsReleaseFetch(client: pg.PoolClient, link: QmsLink, lotId: string): Promise<void> {
  const { rows } = await client.query<{ mode: string; lot_code: string | null }>(
    'select site.qms_mode() as mode, (select lot_code from site.material_lot where id = $1) as lot_code',
    [lotId],
  );
  const mode = rows[0]?.mode;
  const lotCode = rows[0]?.lot_code;
  if (mode !== 'MIRROR' || !lotCode) return;
  if (!link.baseUrl) throw unreachable('no QMS address is configured (EBMR_QMS_URL).');
  let answer: unknown;
  try {
    const r = await (link.fetchImpl ?? fetch)(`${link.baseUrl}/qms/v1/lots/${encodeURIComponent(lotCode)}/deviations`, { signal: AbortSignal.timeout(link.timeoutMs) });
    if (r.status !== 200) throw new Error(`the QMS answered ${r.status.toString()}`);
    answer = JSON.parse(await r.text()) as unknown;
  } catch (error) {
    throw unreachable(`the QMS did not answer in ${link.timeoutMs.toString()} ms (${error instanceof Error ? error.message : String(error)}).`);
  }
  const deviations = (answer as { deviations?: unknown } | null)?.deviations;
  if (!Array.isArray(deviations)) throw unreachable('the QMS answer carries no list of deviations.');
  await client.query('select site.record_qms_release_fetch($1, $2::jsonb)', [lotId, JSON.stringify(deviations)]);
}
