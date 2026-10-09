/**
 * The terminal's device key (DI-20; plan section 5): a non-extractable WebCrypto ECDSA P-256 private key kept
 * in IndexedDB of this origin (GMP and sandbox origins keep separate keys). The server derives the device from
 * the public key's fingerprint; nothing the browser says about itself is trusted.
 *
 * The demo device picker imports a seeded DEMO-ONLY private key as non-extractable (demo databases only).
 */
import { base64ToBytes } from './base64.ts';

export interface StoredDeviceKey {
  privateKey: CryptoKey;
  /** SPKI DER, base64. */
  publicKeySpki: string;
  /** The terminal code the picker chose (display only; the server decides). */
  label: string;
}

const DB = 'ebmr-device';
const STORE = 'keys';
const ID = 'device';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

export async function loadDeviceKey(): Promise<StoredDeviceKey | null> {
  if (typeof indexedDB === 'undefined') return null;
  const value = await withStore<StoredDeviceKey | undefined>('readonly', (s) => s.get(ID) as IDBRequest<StoredDeviceKey | undefined>);
  return value ?? null;
}

export async function saveDeviceKey(key: StoredDeviceKey): Promise<void> {
  await withStore('readwrite', (s) => s.put(key, ID));
}

export async function forgetDeviceKey(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(ID));
}

/** Imports a DEMO-ONLY PKCS#8 key as non-extractable (the private key can sign but never leaves WebCrypto). */
export async function importDemoKey(privateKeyPkcs8: string, publicKeySpki: string, label: string): Promise<StoredDeviceKey> {
  const privateKey = await crypto.subtle.importKey('pkcs8', base64ToBytes(privateKeyPkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const stored = { privateKey, publicKeySpki, label };
  await saveDeviceKey(stored);
  return stored;
}
