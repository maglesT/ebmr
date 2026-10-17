/**
 * Adapter transport: mutual TLS (Phase 7 slice 7-0 section 3; 6jc-R9; DI-13, DI-31).
 *
 * Every adapter's options gain an optional `tls`. On a GMP installation a base URL whose host is not loopback needs it,
 * or the server refuses to start that adapter (EBMR-INT-034, slice 7a). The server verifies the peer against the pinned
 * CA and name only (no system trust store). Configuration: EBMR_ADAPTER_TLS_DIR holding `<adapter code>.ca.pem`,
 * `<adapter code>.cert.pem` and `<adapter code>.key.pem`.
 */

/** PEM file paths of an adapter's mutual TLS; serverName defaults to the base URL's host. */
export interface AdapterTls {
  ca: string;
  cert: string;
  key: string;
  serverName?: string;
}

/** The transport options every adapter's options carry (additive; slice 7a wires them into the adapters). */
export interface AdapterTransportOptions {
  tls?: AdapterTls;
}

/** The loopback host names and addresses: `localhost`, 127.0.0.0/8, ::1 (an IPv6 address in brackets as in a URL). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * Why an adapter may not start on its transport (EBMR-INT-034), or null when it may (6jc-R9; D-P7-10):
 *   - with `tls`, the base URL is https (mutual TLS needs it);
 *   - without `tls`, a GMP installation takes only a loopback base URL; a sandbox takes any.
 */
export function adapterTransportProblem(baseUrl: string, tls: AdapterTls | undefined, installation: 'GMP' | 'SANDBOX'): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `EBMR-INT-034 the adapter base URL ${baseUrl} is not a URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `EBMR-INT-034 the adapter base URL ${baseUrl} is neither http nor https`;
  if (tls) return url.protocol === 'https:' ? null : `EBMR-INT-034 the adapter base URL ${baseUrl} has mutual TLS configured but is not https`;
  if (installation !== 'GMP' || isLoopbackHost(url.hostname)) return null;
  return `EBMR-INT-034 a GMP installation does not start an adapter whose base URL ${baseUrl} is off loopback without mutual TLS; give it <adapter code>.ca.pem, .cert.pem and .key.pem in EBMR_ADAPTER_TLS_DIR and an https base URL`;
}
