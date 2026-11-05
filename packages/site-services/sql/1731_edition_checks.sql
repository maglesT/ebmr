-- API edition plan A0 (lead decision of 5 November 2026): the site registers' edition checks name the one list,
-- kernel.edition_codes() (kernel 1403), instead of their own literals. Nothing is narrowed; PostgreSQL validates every
-- existing row when each constraint is added.
--
-- Handbook: modules/site-services.md

set local role ebmr_owner;

alter table site.batch_number_allocation   drop constraint batch_number_allocation_edition_check,
  add constraint batch_number_allocation_edition_check check (edition = any (kernel.edition_codes()));
alter table site.lot_reservation           drop constraint lot_reservation_edition_check,
  add constraint lot_reservation_edition_check check (edition = any (kernel.edition_codes()));
alter table site.finished_lot              drop constraint finished_lot_edition_check,
  add constraint finished_lot_edition_check check (edition = any (kernel.edition_codes()));
alter table site.deviation_link            drop constraint deviation_link_edition_check,
  add constraint deviation_link_edition_check check (edition = any (kernel.edition_codes()));
alter table site.qc_extra_testing_decision drop constraint qc_extra_testing_decision_edition_check,
  add constraint qc_extra_testing_decision_edition_check check (edition = any (kernel.edition_codes()));

reset role;
