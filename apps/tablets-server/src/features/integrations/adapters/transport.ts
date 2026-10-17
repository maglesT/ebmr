/**
 * The adapters' mutual TLS (Phase 7 slice 7a, 6jc-R9; DI-31, DI-20; interfaces slice-7-0-interfaces.md section 3).
 *
 * An adapter whose `<adapter code>.ca.pem`, `.cert.pem` and `.key.pem` are in EBMR_ADAPTER_TLS_DIR talks to its system
 * over https only: the server presents its client certificate and verifies the peer against that one CA and the base
 * URL's host name (or the configured server name), never against the system trust store. Each answer carries the SHA-256
 * fingerprint of the peer's certificate, which the worker records with every message of the page (inbound_message.
 * transport_peer, kernel 1305). On a GMP installation an adapter whose base URL is off loopback and has no TLS does not
 * start (EBMR-INT-034, adapterTransportProblem in the SDK); loopback without TLS stays allowed (D-P7-10).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from 'node:tls';
import type { AdapterTls } from '@ebmr/integration-sdk/adapter';

/** The fetch an adapter's feed client uses: globalThis.fetch's shape, plus the TLS peer's fingerprint (mtlsFetch). */
export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  /** The SHA-256 fingerprint of the TLS peer certificate (mtlsFetch, ./transport.ts). */
  peer?: string;
  text(): Promise<string>;
}>;

/** The TLS files of adapter `code` in `dir`: all three, or none (undefined); some but not all is a configuration error. */
export function adapterTlsOf(dir: string | null, code: string): AdapterTls | undefined {
  if (!dir) return undefined;
  const files = { ca: join(dir, `${code}.ca.pem`), cert: join(dir, `${code}.cert.pem`), key: join(dir, `${code}.key.pem`) };
  const present = Object.values(files).filter((f) => existsSync(f)).length;
  if (present === 0) return undefined;
  if (present !== 3) throw new Error(`EBMR-INT-034 adapter ${code} has only some of its TLS files in ${dir}: ${code}.ca.pem, ${code}.cert.pem and ${code}.key.pem are needed together`);
  return files;
}

/** Lowercase hex SHA-256 of a certificate's DER bytes. */
export function certificateFingerprint(cert: Pick<PeerCertificate, 'raw'>): string {
  return createHash('sha256').update(cert.raw).digest('hex');
}

/**
 * A FetchFn over https with mutual TLS: the client certificate and key of `tls`, the peer verified against `tls.ca`
 * only and against the server name (tls.serverName, else the URL's host). The answer's `peer` is the SHA-256 fingerprint
 * of the peer certificate the exchange was made with.
 */
export function mtlsFetch(tls: AdapterTls): FetchFn {
  const ca = readFileSync(tls.ca);
  const cert = readFileSync(tls.cert);
  const key = readFileSync(tls.key);
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      if (u.protocol !== 'https:') {
        reject(new Error(`EBMR-INT-034 ${url}: an adapter with mutual TLS speaks https only`));
        return;
      }
      const name = tls.serverName ?? u.hostname.replace(/^\[(.*)\]$/, '$1');
      const req = request(
        {
          protocol: 'https:', hostname: u.hostname.replace(/^\[(.*)\]$/, '$1'), port: u.port === '' ? 443 : Number(u.port), path: `${u.pathname}${u.search}`,
          method: init.method ?? 'GET', headers: init.headers ?? {}, signal: init.signal,
          ca, cert, key, rejectUnauthorized: true, agent: false,
          ...(isIP(name) === 0 ? { servername: name } : {}),
          // The pinned name, whatever host the URL names (an address, a load balancer).
          checkServerIdentity: (_host: string, peer: PeerCertificate) => checkServerIdentity(name, peer),
        },
        (res) => {
          const cert = (res.socket as TLSSocket).getPeerCertificate();
          if (!(cert.raw instanceof Buffer)) {
            res.destroy();
            reject(new Error(`${url}: the peer presented no certificate`));
            return;
          }
          const peer = certificateFingerprint(cert);
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            resolve({ ok: status >= 200 && status < 300, status, peer, text: () => Promise.resolve(text) });
          });
        },
      );
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}
