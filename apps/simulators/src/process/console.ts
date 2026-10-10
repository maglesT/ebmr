/**
 * The process simulator console (plain HTML, forms only, no script): the controller's actual values, setpoints as
 * read back and active alarms, with buttons for the owner's demo (start, stop, a setpoint by hand, faults, reset). It
 * refreshes itself every second. SIMULATOR: not real equipment.
 */
import { FAULTS, type ProcessModelState } from './model.ts';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function button(action: string, label: string, fields: Record<string, string> = {}): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<form method="post" action="/console/${esc(action)}">${hidden}<button type="submit">${esc(label)}</button></form>`;
}

export function consoleHtml(state: ProcessModelState, problem: string | null = null): string {
  const name = state.equipment === 'PRESS' ? 'Tablet press' : 'Film coater';
  const rows = state.values
    .map((v) => {
      const sp = state.setpoints.find((s) => s.tag === v.tag);
      return `<tr><td>${esc(v.tag)}</td><td>${esc(v.value)} ${esc(v.unit)}</td><td>${sp ? `${esc(sp.value)} ${esc(sp.unit)}` : ''}</td></tr>`;
    })
    .join('');
  const alarms = state.alarms.length === 0 ? '<p>No active alarm.</p>' : `<ul>${state.alarms.map((a) => `<li class="alarm">${esc(a.code)} on ${esc(a.tag)}</li>`).join('')}</ul>`;
  const faults = FAULTS.map((f) => {
    const on = state.faults.includes(f);
    return `<li>${esc(f)}: <strong>${on ? 'ON' : 'off'}</strong> ${button('fault', on ? `Clear ${f}` : `Inject ${f}`, { fault: f, on: on ? 'false' : 'true' })}</li>`;
  }).join('');
  const setpointTags = state.setpoints.map((s) => `<option value="${esc(s.tag)}">${esc(s.tag)} (${esc(s.unit)})</option>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="1">
<title>${esc(name)} simulator</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; max-width: 760px; background: #fff; color: #111; }
  .banner { background: #fde68a; padding: 8px 12px; font-weight: 700; border-radius: 6px; }
  .alarm { color: #7f1d1d; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border-bottom: 1px solid #ddd; padding: 4px 8px; text-align: left; font-family: ui-monospace, monospace; }
  form { display: inline-block; margin: 4px; }
  button, input, select { font-size: 16px; padding: 8px 14px; min-height: 44px; }
  ul { list-style: none; padding: 0; }
  li { margin: 4px 0; }
</style>
</head>
<body>
<p class="banner">SIMULATOR (DEMO-ONLY): a simulated ${esc(name.toLowerCase())}, not real equipment.</p>
<h1>${esc(name)} simulator ${esc(state.serial)}</h1>
${problem ? `<p class="alarm" role="alert">${esc(problem)}</p>` : ''}
<p>${state.running ? 'Running' : 'Stopped'}, scan ${esc(state.scan)}</p>
${button('start', 'Start')}${button('stop', 'Stop')}${button('reset', 'Reset')}
<table><thead><tr><th>Tag</th><th>Actual</th><th>Setpoint (read back)</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Alarms</h2>
${alarms}
<h2>Change a setpoint at the machine</h2>
<form method="post" action="/console/setpoint"><select name="tag">${setpointTags}</select> <input name="value" inputmode="decimal" autocomplete="off" required placeholder="12.50"> <button type="submit">Set</button></form>
<h2>Faults</h2>
<ul>${faults}</ul>
${button('clear-faults', 'Clear all faults')}
</body>
</html>`;
}
