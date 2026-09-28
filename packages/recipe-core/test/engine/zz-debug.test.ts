import { appendFileSync } from 'node:fs';
const log = (...a: unknown[]): void => appendFileSync('/tmp/claude-0/-home-user/0f393df3-64ef-5de6-9328-48ce9ce2b1a5/scratchpad/debug.log', a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
import { it } from 'vitest';
import { decodeState, encodeState, stateHash } from '../../src/engine/codec.ts';
import { engineSignatures, signingContents } from '../../src/engine/signing-content.ts';
import { autopilot, define, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, Run, T0, SUP1 } from './support.ts';
import { buildFlow, candidateCommands, GENERATED_DATA } from './model-support.ts';
import { Recorder } from './recorder.ts';

function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length > 5) return;
  if (typeof a !== typeof b) { out.push(`${path}: ${typeof a} vs ${typeof b}`); return; }
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${path}: array mismatch`); return; }
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    for (const k of new Set([...ka, ...kb])) diff((a as never)[k], (b as never)[k], `${path}.${k}`, out);
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) out.push(`${path}: proto`);
    return;
  }
  if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) out.push(`${path}: ${String(a)} vs ${String(b)}`);
}

it('debug codec', () => {
  const def = fixtureDefinition('tablet-granulation-compression');
  const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
  autopilot(run, GRANULATION_SCENARIO);
  const back = decodeState(JSON.parse(JSON.stringify(encodeState(run.state))));
  const out: string[] = [];
  diff(structuredClone(run.state), back, '$', out);
  log('CODEC', out);
});

it('debug model', () => {
  const shape = {"t":"loop","b":{"t":"rep","b":{"t":"loop","b":{"t":"phase","timer":0},"max":1,"maxMinutes":0},"min":1,"extra":0,"concurrent":false},"max":1,"maxMinutes":0} as never;
  const def = define(buildFlow(shape));
  const rec = Recorder.issue(def, { batchId: 'B', batchNumber: 'TEST-B1', batchSize: def.mbr.header.batchSizes[0]?.id ?? '', marketSet: ['IN'], inputs: {}, issuedBy: SUP1 }, T0);
  const run = new Run(def, rec.state, T0, { checkInvariants: false });
  for (let i = 0; i < 20; i++) {
    run.state = rec.state;
    const c = candidateCommands(def, run, 0, false, GENERATED_DATA);
    const input = c.progress[0] ?? c.all[0];
    if (!input) break;
    const before = signingContents(def, rec.state);
    const r = rec.exec({ ...input, commandId: `C-${i}` } as never, T0);
    const after = signingContents(def, rec.state);
    const changed = [...after.keys()].filter((k) => before.get(k)?.contentHash !== after.get(k)?.contentHash);
    const engine = engineSignatures(rec.state);
    const kv = rec.kernelValid().filter((id) => engine.has(id));
    const ev = [...engine.entries()].filter(([id, e]) => e.valid && rec.signatures.has(id)).map(([id]) => id).sort();
    log(i, input.type, (input as {step?: string}).step ?? '', r.accepted, r.refusal?.code ?? '', 'changed:', changed.join(','), JSON.stringify(kv) === JSON.stringify(ev) ? 'AGREE' : `DISAGREE k=${kv} e=${ev}`);
    if (JSON.stringify(kv) !== JSON.stringify(ev)) {
      for (const k of changed) {
        const a = before.get(k)?.content, b = after.get(k)?.content; const o: string[] = []; diff(a, b, k, o); log('  ', o);
      }
      break;
    }
  }
});
