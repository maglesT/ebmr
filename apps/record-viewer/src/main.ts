/**
 * The stand-alone record viewer (Phase 7 slice 7b-2; DI-08 clause 2): open the folder of a full export, give the export
 * SHA-256 from the installation's export register, and the page verifies every file, chain and seal before it shows
 * anything. Without that SHA-256 the export is shown as not anchored: its origin is not proven. Read-only and offline:
 * the page's policy allows no network, and it has nothing that writes, signs or saves. Files are read when they are
 * checked or opened (File handles), never all held at once.
 */
import { openChain, verifyExport, type ExportFile } from './verify/export.ts';
import { renderChecking, renderReport, h } from './view.ts';

const folder = document.getElementById('folder') as HTMLInputElement;
const expected = document.getElementById('expected') as HTMLInputElement;
const result = document.getElementById('result') as HTMLElement;
let opened: ExportFile[] | null = null;
let run = 0;
/** What the shown report was made from: the same files and the same expected SHA-256 are not checked twice. */
let shown: { files: ExportFile[]; expected: string } | null = null;

async function show(): Promise<void> {
  const files = opened;
  if (!files) return;
  if (shown && shown.files === files && shown.expected === expected.value) return;
  shown = { files, expected: expected.value };
  const mine = ++run;
  result.replaceChildren(renderChecking(files.length));
  try {
    const report = await verifyExport(files, { manifestSha256: expected.value });
    if (mine === run) result.replaceChildren(renderReport(report, (c) => openChain(files, c)));
  } catch (error) {
    if (mine === run) {
      result.replaceChildren(h('div', { class: 'verdict failed', 'data-testid': 'verdict', 'data-ok': 'false', 'data-verdict': 'FAILED', role: 'alert' },
        h('h2', {}, 'Verification failed: the export could not be checked.'), h('p', {}, (error as Error).message)));
    }
  }
}

function open(): void {
  const list = [...(folder.files ?? [])];
  opened = list.map((f) => ({ path: f.webkitRelativePath || f.name, read: async () => new Uint8Array(await f.arrayBuffer()) }));
  void show();
}

folder.addEventListener('change', open);
expected.addEventListener('change', () => void show());
