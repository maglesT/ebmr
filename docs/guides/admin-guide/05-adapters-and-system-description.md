# Adapters, mutual TLS and the system description

Batchwright talks to the site's other systems through adapters: the ERP/WMS, the QMS, the LIMS, the learning system
(LMS), the maintenance system (CMMS), the serialisation system (L3/L4), the environmental monitoring system (EMS) and
the OPC UA equipment feed through the site gateway. Each adapter is registered with a code; every message it brings in
is kept with its source times, checked for sequence gaps, order and identity, and refused with an alarm when it is
wrong. Nothing is lost silently.

## Mutual TLS for every adapter off loopback (7a)

1. For each adapter whose base URL is not loopback, put three PEM files in the directory named by
   `EBMR_ADAPTER_TLS_DIR`, named by the adapter's registered code:
   - `<code>.ca.pem`: the CA the other system's server certificate must chain to (the only CA trusted for it);
   - `<code>.cert.pem` and `<code>.key.pem`: the Batchwright server's client certificate and key, which the other
     system trusts.
   Give all three or none: an adapter with only some of them does not start.
2. The base URL must be `https://`, and the other system's certificate must name the base URL's host. The server never
   uses the operating system's trust store.
3. On a GMP installation an adapter off loopback without these files does not start (EBMR-INT-034). The integrations
   health page then shows its worker BLOCKED with the refusal as its last error. Loopback without TLS is allowed.
4. Each pulled message records the SHA-256 fingerprint of the other system's certificate. When that certificate is
   renewed, the fingerprint changes from the first page after the renewal. The fingerprint is advisory (the server's
   report), not evidence by itself.

## The approved system description (7-0; the interlock as planned, checked at 7f)

The approved system description lists the interfaces the installation is validated with: for each adapter, its source
system, endpoint host, transport (LOOPBACK or MTLS) and whether its feed is signed. It is configuration area
`SYSTEM_DESCRIPTION`, so each change is made under an approved configuration change record
([Configuration and change control](02-configuration-and-change-control.md)).

| Task | Function | Right |
|---|---|---|
| Record or withdraw an interface of the description | `platform.describe_interface` | `CONFIG.SYSTEM_DESCRIPTION` |
| Read the description in force | `platform.system_description` | none (a read) |

From slice 7c on (as planned; checked at 7f), an inbound message or an adapter start for an interface that is not in
the approved description raises the INTERFACE_DRIFT alarm and is refused (DI-06), and the IQ check compares the
adapters with the description.

## Reconciliation (as planned; checked at 7f)

Slice 7b-1 makes the adapter worker reconcile every closed period (hourly, after a grace of 10 minutes) for each adapter
with a reconciliation endpoint: the source's count and checksum against what Batchwright received. A mismatch raises
RECONCILIATION_MISMATCH, and the health page shows the last reconciled period.
