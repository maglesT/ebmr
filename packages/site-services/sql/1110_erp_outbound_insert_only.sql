-- Site services: the ERP/WMS outbound queue is insert-only for every writer (Phase 7 slice 7b-1, review residual
-- 6jc-R5; DI-31).
--
-- Handbook: modules/site-services.md
--
-- site.erp_outbound_message (0912) is the queue of the facts sent to the ERP/WMS (stock blocks, lot status, goods issues,
-- yields). Its header called it insert-only, but only the grants held that: the application role cannot write it, the
-- owner's functions only insert into it (site.enqueue_erp_outbound), and nothing updates or deletes a message. A message
-- changed or removed after it was queued would send the ERP another fact than the eBMR recorded, or none. It gets the
-- platform's insert-only triggers (platform.make_insert_only, kernel 0500): an UPDATE, a DELETE or a TRUNCATE is refused
-- with EBMR-PLAT-002 for every writer, the owner and a superuser included. Delivery and attempts stay in their own
-- tables (erp_outbound_delivery is audited and insert-only already; erp_outbound_attempt is appended to only).
-- The queue stays operational (not audited row by row), as 0912 decided.

set local role ebmr_owner;

select platform.make_insert_only('site.erp_outbound_message');

reset role;
