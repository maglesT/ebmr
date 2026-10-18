/**
 * Hashes and seal checks through the browser's Web Crypto API (no library, no network). SHA-256 for every file, part,
 * row and audit event; Ed25519 for the seals of the signatures whose key is an Ed25519 key.
 */
const utf8 = new TextEncoder();

export const utf8Bytes = (s: string): Uint8Array => utf8.encode(s);

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array | undefined {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function fromBase64(b64: string): Uint8Array | undefined {
  try {
    const bin = atob(b64.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/** A fresh ArrayBuffer holding exactly these bytes (Web Crypto takes buffers, not views over a larger one). */
const buffer = (b: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(b.length);
  copy.set(b);
  return copy.buffer;
};

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? utf8Bytes(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes))));
}

/** SHA-256 of the previous hash's bytes followed by the payload's UTF-8 bytes (the audit chain's event hash). */
export async function chainHashHex(prevHashHex: string, payload: string): Promise<string | undefined> {
  const prev = fromHex(prevHashHex);
  if (!prev) return undefined;
  const body = utf8Bytes(payload);
  const all = new Uint8Array(prev.length + body.length);
  all.set(prev, 0);
  all.set(body, prev.length);
  return sha256Hex(all);
}

/** The exact bytes a seal covers (the kernel's esig sealMessage): a domain-separation line, key, algorithm, payload. */
export const sealMessage = (keyId: string, algorithm: string, payload: string): Uint8Array => utf8Bytes(`ebmr-esig-seal-v1\n${keyId}\n${algorithm}\n${payload}`);

/** DER bytes of a PEM SPKI public key. */
export function pemToDer(pem: string): Uint8Array | undefined {
  const m = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/.exec(pem);
  return m ? fromBase64(m[1] ?? '') : undefined;
}

/** Checks an Ed25519 seal with the SPKI PEM public key: VALID, INVALID, or UNSUPPORTED when the browser lacks Ed25519. */
export async function verifyEd25519(publicKeyPem: string, message: Uint8Array, seal: Uint8Array): Promise<'VALID' | 'INVALID' | 'UNSUPPORTED'> {
  const der = pemToDer(publicKeyPem);
  if (!der) return 'INVALID';
  let key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    key = await crypto.subtle.importKey('spki', buffer(der), { name: 'Ed25519' }, false, ['verify']);
  } catch (error) {
    return (error as Error).name === 'NotSupportedError' ? 'UNSUPPORTED' : 'INVALID';
  }
  try {
    return (await crypto.subtle.verify({ name: 'Ed25519' }, key, buffer(seal), buffer(message))) ? 'VALID' : 'INVALID';
  } catch {
    return 'INVALID';
  }
}
