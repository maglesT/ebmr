/**
 * The trend viewer (Phase 6 slice 6b; DI-32): the native series of one tag, either of a batch (the chunks taken while
 * the batch, or one step, held its unit or occupied its room; ns/equipment-data batchSeries) or of a unit or room over a
 * window of source time (ns/equipment-data series, paged by chunk number, every page loaded before drawing). The chart is
 * TrendChart: interactive zoom and pan over the samples as received, for live data and for a restored archive alike.
 * Opened from the batch review (?batchId=) or from the home tile. Phase 6A slice 6A-6: for a batch, a step and a tag, the
 * golden profile overlay (advisory: the band of the reference batches with this batch's curve, analytics/profile) can
 * be shown under the chart; the chart and the sample table above it stay the native data as received (DI-32).
 */
import { getRouteApi } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { routes, type Result, type RouteResponse, type SeriesChunkView } from '@ebmr/api-contract';
import { Button, Field, floor } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { ApiError, useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { ProfileOverlay } from '../analytics/profile/ProfileOverlay.tsx';
import { PLANT_CODE } from './reads.ts';
import { TrendChart } from './TrendChart.tsx';

export interface TrendSearch {
  batchId?: string;
  tag?: string;
  step?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAG = /^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

export function parseTrendSearch(raw: Record<string, unknown>): TrendSearch {
  const pick = (k: string, re: RegExp): string | undefined => {
    const v = raw[k];
    return typeof v === 'string' && re.test(v) ? v : undefined;
  };
  const batchId = pick('batchId', UUID);
  const tag = pick('tag', TAG);
  const step = pick('step', /^.{1,200}$/);
  return { ...(batchId ? { batchId } : {}), ...(tag ? { tag } : {}), ...(step ? { step } : {}) };
}

/** A UTC date and time typed as YYYY-MM-DDTHH:MM[:SS] as epoch microseconds text, or null. */
export function utcInputUs(text: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0'));
  return Number.isFinite(ms) && ms >= 0 ? (BigInt(ms) * 1000n).toString() : null;
}

const route = getRouteApi('/trends');

export function TrendsPage() {
  const search: TrendSearch = route.useSearch();
  const [mode, setMode] = useState<'BATCH' | 'SUBJECT'>(search.batchId ? 'BATCH' : 'SUBJECT');
  const tags = useApiQuery(routes.equipmentData.tags, {});
  const [tag, setTag] = useState(search.tag ?? '');
  const tagView = tags.data?.tags.find((t) => t.tag === tag);
  return (
    <>
      <h1>Trends</h1>
      <p>Native samples as the equipment or the EMS sent them, with their source times. Drag across the chart, or use the buttons, to zoom.</p>
      <Section title="What to show" testId="trend-query">
        <floor.ChoiceGroup
          label="Series of"
          options={[
            { value: 'BATCH', label: 'A batch' },
            { value: 'SUBJECT', label: 'A unit or room' },
          ]}
          value={mode}
          onChange={(v) => setMode(v === 'BATCH' ? 'BATCH' : 'SUBJECT')}
        />
        <floor.ChoiceGroup
          label="Tag"
          options={(tags.data?.tags ?? []).map((t) => ({ value: t.tag, label: `${t.tag} (${t.unit})` }))}
          value={tag}
          onChange={setTag}
        />
        {tags.error ? <RefusalMessage error={tags.error.error} /> : null}
      </Section>
      {mode === 'BATCH' ? <BatchTrend search={search} tag={tag} unit={tagView?.unit ?? ''} /> : <SubjectTrend tag={tag} unit={tagView?.unit ?? ''} kind={tagView?.subjectKind ?? 'EQUIPMENT'} />}
    </>
  );
}

function BatchTrend({ search, tag, unit }: { search: TrendSearch; tag: string; unit: string }) {
  const [batchId, setBatchId] = useState(search.batchId ?? '');
  const [step, setStep] = useState(search.step ?? '');
  const [golden, setGolden] = useState(false);
  const ready = UUID.test(batchId.trim()) && TAG.test(tag);
  const q = useApiQuery(
    routes.equipmentData.batchSeries,
    { params: { batchId: batchId.trim() }, query: { tag, ...(step.trim() ? { step: step.trim() } : {}) } },
    { enabled: ready },
  );
  return (
    <Section title="Series of the batch" testId="trend-batch">
      <Field name="trendBatch" label="Batch id" value={batchId} onChange={setBatchId} />
      <Field name="trendStep" label="Step (optional)" value={step} onChange={setStep} />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {!ready ? <p>Choose a batch and a tag.</p> : null}
      {ready && q.data ? <TrendChart chunks={q.data.chunks} unit={unit} tag={tag} /> : null}
      {ready && step.trim() ? (
        <>
          <Button onPress={() => setGolden((g) => !g)}>{golden ? 'Hide the golden profile' : 'Show the golden profile (advisory)'}</Button>
          {golden ? <ProfileOverlay batchId={batchId.trim()} step={step.trim()} tag={tag} /> : null}
        </>
      ) : null}
    </Section>
  );
}

function SubjectTrend({ tag, unit, kind }: { tag: string; unit: string; kind: 'EQUIPMENT' | 'AREA' }) {
  const [code, setCode] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const subjectCode = code.trim().toUpperCase();
  const fromUs = utcInputUs(from);
  const toUs = utcInputUs(to);
  const ready = PLANT_CODE.test(subjectCode) && TAG.test(tag) && fromUs !== null && toUs !== null && BigInt(fromUs) < BigInt(toUs);
  const key = `${kind}|${subjectCode}|${tag}|${fromUs ?? ''}|${toUs ?? ''}`;
  return (
    <Section title={kind === 'AREA' ? 'Series of a room' : 'Series of a unit'} testId="trend-subject">
      <Field name="trendSubject" label={kind === 'AREA' ? 'Room code' : 'Unit code'} value={code} onChange={setCode} />
      <Field name="trendFrom" label="From (UTC, YYYY-MM-DDTHH:MM)" value={from} onChange={setFrom} />
      <Field name="trendTo" label="To (UTC, YYYY-MM-DDTHH:MM)" value={to} onChange={setTo} />
      {!ready ? <p>Choose a unit or room, a tag and a window.</p> : <PagedSeries key={key} kind={kind} code={subjectCode} tag={tag} unit={unit} fromUs={fromUs} toUs={toUs} />}
    </Section>
  );
}

/** The most pages one window reads (200 chunks a page); a longer window is narrowed first. */
const PAGE_CAP = 50;

/** Every page of the window (by chunk number) gathered in one read, then drawn as one chart. */
function PagedSeries({ kind, code, tag, unit, fromUs, toUs }: { kind: 'EQUIPMENT' | 'AREA'; code: string; tag: string; unit: string; fromUs: string; toUs: string }) {
  const route = routes.equipmentData.series;
  const q = useQuery<{ chunks: SeriesChunkView[]; complete: boolean }, ApiError>({
    queryKey: [route.id, 'all-pages', { kind, code, tag, fromUs, toUs }],
    queryFn: async ({ signal }) => {
      const chunks: SeriesChunkView[] = [];
      let after: string | null = null;
      for (let page = 0; page < PAGE_CAP; page++) {
        const r: Result<RouteResponse<typeof route>> = await api.call(route, { query: { subjectKind: kind, subjectCode: code, tag, fromUs, toUs, ...(after ? { after } : {}) }, signal });
        if (!r.ok) throw new ApiError(r.error);
        chunks.push(...r.value.chunks);
        after = r.value.nextAfter;
        if (after === null) return { chunks, complete: true };
      }
      return { chunks, complete: false };
    },
  });
  return (
    <>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.isPending ? <p>Loading the chunks.</p> : null}
      {q.error ? <Button onPress={() => void q.refetch()}>Try again</Button> : null}
      {q.data && !q.data.complete ? <p data-testid="trend-truncated">The window holds more chunks than one view shows; the first {q.data.chunks.length} are drawn. Narrow the window to see the rest.</p> : null}
      {q.data ? <TrendChart chunks={q.data.chunks} unit={unit} tag={tag} /> : null}
    </>
  );
}
