/**
 * The stand-alone record viewer (Phase 7 slice 7b-2; DI-08 clause 2): open the folder of a full export, optionally give
 * the export SHA-256 from the installation's export register, and the page verifies every file, chain and seal before
 * it shows anything. Read-only and offline: the page's policy allows no network, and it has nothing that writes, signs
 * or saves.
 */
import { verifyExport, type ExportFile } from './verify/export.ts';
import { renderChecking, renderReport } from './view.ts';

const folder = document.getElementById('folder') as HTMLInputElement;
const expected = document.getElementById('expected') as HTMLInputElement;
const result = document.getElementById('result') as HTMLElement;
let opened: ExportFile[] | null = null;
let run = 0;

async function show(): Promise<void> {
  if (!opened) return;
  const mine = ++run;
  result.replaceChildren(renderChecking(opened.length));
  const report = await verifyExport(opened, { manifestSha256: expected.value });
  if (mine === run) result.replaceChildren(renderReport(report));
}

async function open(): Promise<void> {
  const list = [...(folder.files ?? [])];
  result.replaceChildren(renderChecking(list.length));
  const files: ExportFile[] = [];
  for (const f of list) files.push({ path: f.webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  opened = files;
  await show();
}

folder.addEventListener('change', () => void open());
expected.addEventListener('change', () => void show());
