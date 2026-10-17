-- Phase 7 slice 7a (6jc-R9 review round 1; controls DI-31, DI-20): what platform.inbound_message.transport_peer is
-- worth (kernel 1305).
--
-- Handbook: modules/integrations.md
--
-- platform.accept_inbound_detail reads the transaction setting ebmr.transport_peer, which any session of the application
-- role can set. The value is the server's adapter worker's report of the TLS peer it pulled the page from: advisory,
-- never evidence by itself. The column keeps only a SHA-256 fingerprint (64 lowercase hex digits, the check constraint
-- of 1305: any other value refuses the message, nothing is stored). The evidence of the source is the gateway's
-- signature verified in the database (source_verification) and, for the transport, the pinned CA and name the server
-- checks; this comment says so where the column is read.

set local role ebmr_owner;

comment on column platform.inbound_message.transport_peer is
  'Advisory: the SHA-256 fingerprint (64 lowercase hex digits, check constraint) of the TLS peer certificate of the page this message was pulled in, as the server''s adapter worker reports it in the transaction setting ebmr.transport_peer (slice 7a). Any application-role session can set that setting, so the value is not evidence by itself; the source''s evidence is source_verification. Null over loopback without TLS.';

reset role;
