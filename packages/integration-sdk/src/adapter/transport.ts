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
