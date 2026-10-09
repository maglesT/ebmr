/**
 * The pendingEntry machine (module C4; decision D1; DI-28, INV-40), explored with @xstate/graph: every simple
 * path through the machine is replayed on a real actor and checked for the entry rules.
 */
import { getShortestPaths, getSimplePaths } from '@xstate/graph';
import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';
import type { RefusalEnvelope } from '@ebmr/api-contract';
import { floor } from '../../src/index.ts';

const { pendingEntryMachine } = floor;
type Event = floor.PendingEntryEvent;
type Snapshot = ReturnType<ReturnType<typeof createActor<typeof pendingEntryMachine>>['getSnapshot']>;

const refusal = (kind: RefusalEnvelope['refusal']['kind']): RefusalEnvelope => ({
  refusal: { code: `TEST-${kind}`, kind, whatHappened: kind, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] },
  correlationId: 'c-1',
  retryable: false,
});

const PAYLOAD = { expectedVersion: 7, intent: { type: 'RECORD_DATA', stepKey: 'p-blend@', item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } } };

const EVENTS: Event[] = [
  { type: 'SUBMIT', payload: PAYLOAD, summary: 'Blend time: 15 min', owner: 'person-1' },
  { type: 'TAPPED' },
  { type: 'TAP_CANCELLED' },
  { type: 'SAVED' },
  { type: 'LOST' },
  { type: 'REFUSED', refusal: refusal('NOT_ALLOWED') },
  { type: 'STALE', refusal: refusal('STALE'), changes: ['Step status changed'] },
  { type: 'SWITCH_USER', refusal: refusal('SWITCH_USER') },
  { type: 'RESEND' },
  { type: 'DISCARD' },
  { type: 'RESET' },
  { type: 'SESSION_CHANGED' },
];

function counter(): () => string {
  let n = 0;
  return () => `key-${++n}`;
}

/**
 * Finite state identity for the traversal: the state, whether an entry (key) is held, a resend awaited, the sends
 * of the current key (capped at 2, so paths through a lost send and its resend are distinct) and why an entry
 * was discarded.
 */
const serializeState = (s: Snapshot) => `${String(s.value)}|${s.context.key ? 'k' : '-'}|${s.context.resend ? 'r' : '-'}|${Math.min(s.context.sends, 2)}|${s.context.discardReason ?? '-'}`;

function paths(tapRequired: boolean) {
  return getSimplePaths(pendingEntryMachine, { input: { tapRequired, newKey: counter() }, events: EVENTS, serializeState });
}

/** Replays a path on a fresh actor and returns the snapshot after every event. */
function replay(events: readonly Event[], tapRequired: boolean): { event: Event; before: Snapshot; after: Snapshot }[] {
  const actor = createActor(pendingEntryMachine, { input: { tapRequired, newKey: counter() } }).start();
  const out: { event: Event; before: Snapshot; after: Snapshot }[] = [];
  for (const event of events) {
    const before = actor.getSnapshot();
    actor.send(event);
    out.push({ event, before, after: actor.getSnapshot() });
  }
  actor.stop();
  return out;
}

const eventsOf = (p: ReturnType<typeof paths>[number]) => p.steps.map((s) => s.event).filter((e) => (e.type as string) !== 'xstate.init');

describe('pendingEntry machine (kiosk: a badge tap per send)', () => {
  const all = paths(true);

  it('the traversal reaches every state', () => {
    const reached = new Set(all.map((p) => String(p.state.value)));
    expect([...reached].sort()).toEqual(['awaitingTap', 'discarded', 'editing', 'notSaved', 'refused', 'saved', 'sending', 'stale']);
    expect(all.length).toBeGreaterThan(20);
  });

  it('[DI-28][INV-40] on every path a resend uses the same idempotency key and the same body as the lost send, and needs a fresh tap', () => {
    let resends = 0;
    for (const p of all) {
      const steps = replay(eventsOf(p), true);
      let lostKey: string | null = null;
      let lostPayload: unknown = null;
      for (const s of steps) {
        if (s.event.type === 'LOST' && s.after.value === 'notSaved') {
          lostKey = s.before.context.key;
          lostPayload = s.before.context.payload;
        }
        if (s.after.value === 'sending' && s.before.value !== 'sending') {
          // Every send on a kiosk is entered through a tap, never directly (re-tap required).
          expect(s.event.type, `path ${eventsOf(p).map((e) => e.type).join(' > ')}`).toBe('TAPPED');
          expect(s.after.context.taps).toBe(s.after.context.sends);
          if (s.before.context.resend) {
            resends += 1;
            expect(s.after.context.key).toBe(lostKey);
            expect(s.after.context.payload).toBe(lostPayload);
          }
        }
        if (s.event.type === 'SUBMIT' && s.after.value !== s.before.value) {
          // A new entry always gets a new key.
          expect(s.after.context.key).not.toBeNull();
          expect(s.after.context.key).not.toBe(s.before.context.key);
          expect(s.after.context.sends).toBe(0);
        }
      }
    }
    expect(resends).toBeGreaterThan(0);
  });

  it('[DI-28] NOT SAVED is reached only when the answer was lost, and can only be left by a resend, a discard or a session change', () => {
    for (const p of all) {
      for (const s of replay(eventsOf(p), true)) {
        if (s.after.value === 'notSaved' && s.before.value !== 'notSaved') {
          expect(['LOST', 'TAP_CANCELLED']).toContain(s.event.type);
          if (s.event.type === 'TAP_CANCELLED') expect(s.before.context.resend).toBe(true);
        }
        if (s.before.value === 'notSaved' && s.after.value !== 'notSaved') expect(['RESEND', 'DISCARD', 'SESSION_CHANGED']).toContain(s.event.type);
        if (s.before.value === 'notSaved' && s.event.type === 'SUBMIT') expect(s.after.value).toBe('notSaved');
      }
    }
  });

  it('[INV-40] a session change or another person\'s badge discards whatever is pending: nothing is kept to be sent under another person', () => {
    let checked = 0;
    for (const p of all) {
      for (const s of replay(eventsOf(p), true)) {
        const pending = ['awaitingTap', 'sending', 'notSaved', 'refused', 'stale'].includes(String(s.before.value));
        if ((s.event.type === 'SESSION_CHANGED' && pending) || (s.event.type === 'SWITCH_USER' && s.before.value === 'sending')) {
          checked += 1;
          expect(s.after.value).toBe('discarded');
          expect(s.after.context.key).toBeNull();
          expect(s.after.context.payload).toBeNull();
          expect(s.after.context.discardReason).toBe(s.event.type === 'SWITCH_USER' ? 'SWITCH_USER' : 'SESSION_CHANGED');
          expect(s.after.context.sessionEpoch).toBeGreaterThan(s.before.context.sessionEpoch);
        }
        if (s.before.value === 'discarded') {
          // Nothing leaves "discarded" towards a send except a new entry (new SUBMIT, new key).
          if (s.after.value === 'awaitingTap' || s.after.value === 'sending') expect(s.event.type).toBe('SUBMIT');
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('refused and stale retire the key: the next entry is a new command with a new key', () => {
    const steps = replay(
      [EVENTS[0]!, { type: 'TAPPED' }, { type: 'REFUSED', refusal: refusal('NOT_ALLOWED') }, EVENTS[0]!, { type: 'TAPPED' }, { type: 'STALE', refusal: refusal('STALE'), changes: [] }, EVENTS[0]!],
      true,
    );
    const keys = steps.filter((s) => s.event.type === 'SUBMIT').map((s) => s.after.context.key);
    expect(new Set(keys).size).toBe(3);
    expect(steps.at(-1)?.after.value).toBe('awaitingTap');
  });

  it('a cancelled tap for a new entry returns to editing and sends nothing; for a resend it returns to NOT SAVED with the entry kept', () => {
    const fresh = replay([EVENTS[0]!, { type: 'TAP_CANCELLED' }], true).at(-1)!.after;
    expect(fresh.value).toBe('editing');
    expect(fresh.context.sends).toBe(0);
    expect(fresh.context.payload).toBeNull();
    const resend = replay([EVENTS[0]!, { type: 'TAPPED' }, { type: 'LOST' }, { type: 'RESEND' }, { type: 'TAP_CANCELLED' }], true).at(-1)!.after;
    expect(resend.value).toBe('notSaved');
    expect(resend.context.key).toBe('key-1');
    expect(resend.context.payload).toEqual(PAYLOAD);
  });
});

describe('pendingEntry machine (office PC: no tap)', () => {
  it('[DI-28] a resend goes out at once with the same key and body; the shortest path to every state exists', () => {
    const steps = replay([EVENTS[0]!, { type: 'LOST' }, { type: 'RESEND' }], false);
    expect(steps[0]?.after.value).toBe('sending');
    expect(steps[1]?.after.value).toBe('notSaved');
    expect(steps[2]?.after.value).toBe('sending');
    expect(steps[2]?.after.context.key).toBe(steps[0]?.after.context.key);
    expect(steps[2]?.after.context.payload).toBe(steps[0]?.after.context.payload);
    expect(steps[2]?.after.context.sends).toBe(2);
    expect(steps[2]?.after.context.taps).toBe(0);
    const reached = new Set(getShortestPaths(pendingEntryMachine, { input: { tapRequired: false, newKey: counter() }, events: EVENTS, serializeState }).map((p) => String(p.state.value)));
    expect(reached.has('awaitingTap')).toBe(false);
    expect(reached.has('notSaved')).toBe(true);
  });
});
