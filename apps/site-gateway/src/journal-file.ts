/**
 * Reading a gateway journal file at start without holding it in memory (hosted demo, 1 November 2026: the process
 * journal passed 2 GiB, the most one readFile can return, and the gateway no longer started).
 *
 *   setAsideTail   an unterminated last line (a crash mid-write: never synced, answered or sent) is copied to the next
 *                  free `<partial>-<n>` file and cut off; only the file's last bytes are read to find it.
 *   forEachLine    the file's whole lines in order, read in chunks (latin1, as the journals write them), split on "\n"
 *                  only, each handed to the caller with its 0-based index; the caller's checks fail closed.
 */
import { createReadStream, existsSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';

/** Bytes read per step (a seam for the tests, which use small chunks so a line spans several reads). */
export const READ_CHUNK_BYTES = 1 << 20;

/** Where the last line of `file` ends after any unterminated tail is set aside, and that tail's evidence file. */
export interface TailResult {
  size: number;
  quarantined: { file: string; bytes: number } | null;
}

/**
 * Sets aside an unterminated last line of `file` as `${partialBase}-<n>` (the first free n) and cuts it off; returns
 * the file's size after that. A missing or empty file is size 0.
 */
export async function setAsideTail(file: string, partialBase: string, chunkBytes = READ_CHUNK_BYTES): Promise<TailResult> {
  if (!existsSync(file)) return { size: 0, quarantined: null };
  const fh = await open(file, 'r+');
  try {
    const size = (await fh.stat()).size;
    if (size === 0) return { size: 0, quarantined: null };
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return { size, quarantined: null };
    // Search backwards for the last newline; everything after it is the unfinished line.
    let cut = 0;
    const buf = Buffer.alloc(chunkBytes);
    for (let end = size; end > 0 && cut === 0; ) {
      const start = Math.max(0, end - chunkBytes);
      const { bytesRead } = await fh.read(buf, 0, end - start, start);
      const at = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (at >= 0) cut = start + at + 1;
      end = start;
    }
    const tail = Buffer.alloc(size - cut);
    await fh.read(tail, 0, tail.length, cut);
    let n = 1;
    while (existsSync(`${partialBase}-${n}`)) n += 1;
    await writeFile(`${partialBase}-${n}`, tail, { mode: 0o600 });
    await fh.truncate(cut);
    await fh.sync();
    return { size: cut, quarantined: { file: `${partialBase}-${n}`, bytes: tail.length } };
  } finally {
    await fh.close();
  }
}

/**
 * Calls `onLine` for each whole line of `file` (without its "\n"), in order, with its 0-based index; returns the
 * number of lines. The file must end at a line end (setAsideTail first); a missing file has no lines.
 */
export async function forEachLine(file: string, onLine: (line: string, index: number) => void, chunkBytes = READ_CHUNK_BYTES): Promise<number> {
  if (!existsSync(file)) return 0;
  let rest = '';
  let index = 0;
  for await (const chunk of createReadStream(file, { encoding: 'latin1', highWaterMark: chunkBytes })) {
    const text = rest + (chunk as string);
    let from = 0;
    for (let at = text.indexOf('\n', from); at >= 0; at = text.indexOf('\n', from)) {
      onLine(text.slice(from, at), index);
      index += 1;
      from = at + 1;
    }
    rest = text.slice(from);
  }
  if (rest !== '') throw new Error(`${file} does not end at a line end`);
  return index;
}
