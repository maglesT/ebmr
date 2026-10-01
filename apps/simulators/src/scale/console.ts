/**
 * The simulator console (plain HTML, forms only, no script): what the balance shows, the load on the pan, zero and
 * tare, and buttons for the owner's demo. It refreshes itself every second. SIMULATOR: not a real instrument.
 */
import { FAULTS, type ModelState } from './model.ts';

/** One-click loads for the owner's demo script (docs/demo/phase-2-first-clickable.md): empty pan, tares, grosses. */
export const DEMO_LOADS = ['0.000', '0.200', '0.800', '1.000', '1.250', '10.400', '51.250'] as const;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function button(action: string, label: string, fields: Record<string, string> = {}): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<form method="post" action="/console/${esc(action)}">${hidden}<button type="submit">${esc(label)}</button></form>`;
}

export function consoleHtml(state: ModelState, containerMass: string): string {
  const d = state.display;
  const shown =
    d.kind === 'OVERLOAD' ? 'OVERLOAD' : d.kind === 'UNDERLOAD' ? 'UNDERLOAD' : `${d.value} ${state.unit} ${d.stable ? '(stable)' : '(settling)'}`;
  const faults = FAULTS.map((f) => {
    const on = state.faults.includes(f);
    return `<li>${esc(f)}: <strong>${on ? 'ON' : 'off'}</strong> ${button('fault', on ? `Clear ${f}` : `Inject ${f}`, { fault: f, on: on ? 'false' : 'true' })}</li>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="1">
<title>Scale simulator</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; max-width: 760px; background: #fff; color: #111; }
  .banner { background: #fde68a; padding: 8px 12px; font-weight: 700; border-radius: 6px; }
  .display { font: 700 40px/1.2 ui-monospace, monospace; padding: 16px; background: #111; color: #4ade80; border-radius: 8px; margin: 12px 0; }
  form { display: inline-block; margin: 4px; }
  button { font-size: 16px; padding: 8px 14px; min-height: 44px; }
  ul { list-style: none; padding: 0; }
  li { margin: 4px 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
</style>
</head>
<body>
<p class="banner">SIMULATOR (DEMO-ONLY): a simulated MT-SICS balance, not a real instrument.</p>
<h1>Scale simulator ${esc(state.serial)}</h1>
<div class="display" aria-live="polite">${esc(shown)}</div>
<dl>
  <dt>On the pan</dt><dd>${esc(state.load)} ${esc(state.unit)}</dd>
  <dt>Zero point</dt><dd>${esc(state.zeroOffset)} ${esc(state.unit)}</dd>
  <dt>Tare</dt><dd>${esc(state.tare)} ${esc(state.unit)}</dd>
  <dt>Readability</dt><dd>${esc(state.resolution)} ${esc(state.unit)}, capacity ${esc(state.capacity)} ${esc(state.unit)}</dd>
</dl>
<h2>Set the load on the pan</h2>
<p>One click puts exactly this mass on the pan (the weights of the demo script).</p>
${DEMO_LOADS.map((m) => button('set', `${m} ${state.unit}`, { mass: m })).join('\n')}
<p><a href="/console/load">Set another load…</a></p>
<h2>Load</h2>
${button('place', `Place container (${containerMass} ${state.unit})`, { mass: containerMass })}
${button('add', '+0.5 kg', { mass: '0.500' })}
${button('add', '+5 g', { mass: '0.005' })}
${button('remove', 'Remove everything')}
${button('zero', 'Zero')}
${button('tare', 'Tare')}
${button('reset', 'Reset')}
<h2>Faults</h2>
<ul>${faults}</ul>
${button('clear-faults', 'Clear all faults')}
</body>
</html>`;
}

/** The page to type an exact load (no automatic refresh, so typing is not interrupted). */
export function loadFormHtml(unit: string, problem: string | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scale simulator: set the load</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; max-width: 760px; background: #fff; color: #111; }
  .banner { background: #fde68a; padding: 8px 12px; font-weight: 700; border-radius: 6px; }
  .problem { background: #fee2e2; color: #7f1d1d; padding: 8px 12px; border-radius: 6px; }
  input, button { font-size: 20px; padding: 8px 14px; min-height: 44px; }
</style>
</head>
<body>
<p class="banner">SIMULATOR (DEMO-ONLY): a simulated MT-SICS balance, not a real instrument.</p>
<h1>Set the load on the pan</h1>
${problem ? `<p class="problem" role="alert">${esc(problem)}</p>` : ''}
<form method="post" action="/console/set">
  <label>Mass on the pan (${esc(unit)})<br><input name="mass" inputmode="decimal" autocomplete="off" required pattern="[0-9]{1,3}([.][0-9]{1,3})?" placeholder="51.250" autofocus></label>
  <button type="submit">Set</button>
</form>
<p><a href="/">Back to the simulator</a></p>
</body>
</html>`;
}
