# Decision record 0018: Hindi only; no regional language

- **Date:** 15 October 2026
- **Decided by:** project owner (maglesT), in the Phase 6 session: "regional language isnt needed cancel it".
- **Changes:** outline section 11 Phase 6 ("Hindi + one regional language") and the Phase 6 plan's slice 6h default
  D-P6h-1 (Gujarati).

## Decision

1. Slice 6h builds **Hindi** only, besides English. No regional language (Gujarati or another) in v1.
2. Everything else in slice 6h stays: the UI message catalogue in Hindi, MBR translations approved with the version,
   the language shown recorded with each entry, free text on US and EU batches in English or with a verified
   translation, Devanagari rendering on screen and in the PDF/A-3 true copy (already embedded, D-P4-7).
3. The language mechanism stays generic (a catalogue per language), so a regional language can be added later as
   configuration and translation work, without code changes.
