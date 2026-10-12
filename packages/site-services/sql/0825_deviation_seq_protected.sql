-- Phase 4 slice 2: site.deviation_seq (0820) orders deviation impact rows and sign-offs, which review coverage and
-- the release checks read; after a restore it must never hand out a value already used (INV-27).
select continuity.register_protected_sequence('site.deviation_seq', 'site.deviation_seq'::regclass,
  'OTHER', 'site-services', 'Order of deviation impact rows and impact sign-offs (site-services 0820)', 100000);
