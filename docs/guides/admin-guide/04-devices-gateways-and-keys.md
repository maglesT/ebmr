# Devices, gateways and their keys

Every terminal, balance, printer and gateway that takes part in GMP work is registered. A terminal proves itself on
every request with its own key; an unregistered browser sees only "This browser is not an enrolled terminal".

## Terminals

A terminal has a class: an office PC, a shared shop-floor kiosk, or a kiosk in a Grade A/B area. The class decides how
people sign in (password, or badge and PIN), how each entry is attributed (a fresh badge tap on shared kiosks) and the
screen density. A terminal also has a room, which decides the work queue it shows.

| Task | Function | Right |
|---|---|---|
| Register a terminal with its key's fingerprint, class and room | `iam.register_device` | `IAM.DEVICE_MANAGE` |
| Move a terminal to another room | `iam.relocate_device` | `IAM.DEVICE_MANAGE` |
| Suspend or retire a terminal (its sessions end) | `iam.set_device_status` | `IAM.DEVICE_MANAGE` |
| Attest the hardening of a shared or Grade A/B kiosk | the continuity interface | `CONTINUITY.HARDENING_ATTEST` |
| Record the periodic test of a badge | `iam.record_badge_test` | `IAM.CREDENTIAL_ISSUE` |

## Balances, printers and equipment devices

| Task | Function | Right |
|---|---|---|
| Bind a balance (instrument) to its place | `tab.bind_instrument` | `IAM.DEVICE_MANAGE` |
| Bind a printer | `tab.bind_print_device` | `IAM.DEVICE_MANAGE` |
| Bind a process device (equipment) | `tab.bind_process_device` | `IAM.DEVICE_MANAGE` |

A balance reading is accepted only from a bound balance whose check is current; the reading keeps its raw text exactly
as the balance sent it.

## The site gateway and its signing key (7a)

The site gateway collects the OPC UA equipment feed and passes it to the server. It **signs** each envelope of the feed
(series chunks, alarms, equipment events, endpoint sessions) with its Ed25519 key, and keeps the signature with the
envelope in its journal, so a restart serves the same signed bytes. The **database** checks the signature against the
gateway's active key and that the gateway is the one bound to the adapter; an envelope that is unsigned, wrongly
signed, replayed or from another gateway is refused with an integration alarm and leaves nothing (DI-31, DI-20).

**Connect a gateway's feed.**

1. The gateway's key is its key file (at a site: from the KMS or HSM). Its key id is the lowercase hex SHA-256 of the
   public key's SPKI DER.
2. Register the gateway as a SERVER device whose fingerprint is that SHA-256, and enrol its public key:
   `tab.enrol_gateway_key` (gateway code, SPKI in base64, its INTEGRATION login).
3. Bind the OPC UA adapter to the gateway: `tab.bind_gateway_feed` (adapter code, gateway code, reason code and text;
   `IAM.DEVICE_MANAGE`). Binding to another gateway ends the live binding with that reason. A gateway's feed is bound
   to one adapter only (EBMR-DEV-179).
4. Start the gateway with a fresh journal directory: a journal written before 7a holds unsigned envelopes, which the
   server refuses (EBMR-INT-030).

**Rotate or revoke a key.** Revoke it (`tab.revoke_gateway_key`), enrol the new key under the same gateway code and
restart the gateway with the new key file. From the revocation on, an envelope signed with the old key is refused
(EBMR-INT-031) and alarmed on the integrations page. The binding names the gateway, not the key, so it stays.

**What a refusal means** (integration alarm WRONG_IDENTITY on the adapter):

| Code | Meaning | What to check |
|---|---|---|
| EBMR-INT-030 | the envelope is unsigned, or something called a receiving command directly | the gateway's version and journal |
| EBMR-INT-031 | no binding, or no active key with that id | the enrolment and the binding |
| EBMR-INT-032 | the signature or the payload does not match | treat it as tampering until shown otherwise |
| EBMR-INT-033 | the envelope names another gateway or another gateway's key | which gateway the adapter's base URL reaches |

A gateway on the server's own host (loopback) may run without TLS; anywhere else its channel uses mutual TLS like every
adapter ([Adapters](05-adapters-and-system-description.md)).

The developer's version of these steps is in the handbook's
[runbook](../../handbook/10-runbooks.md#gateway-feed-key-and-adapter-certificates-phase-7-slice-7a).
