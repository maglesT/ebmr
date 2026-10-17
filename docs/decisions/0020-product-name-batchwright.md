# Decision record 0020: the product is named Batchwright, by Medhanta, with the Medhanta logo

- **Date:** 17 October 2026
- **Decided by:** project owner (maglesT), in the Phase 6 session ("batchwright is good"; "medhanta logo should be
  used"), choosing from a list of names proposed for the product.
- **Company:** Medhanta Digipartner (www.medhantadigipartner.com), whose other products include Learnova.

## Decision

1. **Name.** The product is **Batchwright** ("a maker of batches", in the manner of shipwright). Its editions are
   **Batchwright Tablets** and **Batchwright Injectables**. In full: "Batchwright by Medhanta".
2. **Logo.** The Medhanta logo is used for the product's own identity:
   - the sign-in screen
   - the application header
   - the about page
   - the handbook cover and the PDF handbooks
   - documents and slides about the product

   It sits with the Batchwright name.
3. **GMP records keep the manufacturer's identity.** A batch record, true copy, label, report or certificate belongs
   to the manufacturer that runs the system. It shows the customer's own company name and site, as today, never the
   vendor's logo. A plain "Batchwright" version line may appear only where the system identifies itself (for
   example, the software version on a true copy's metadata). It is added with the golden outputs taken again, never
   silently. This keeps the records the manufacturer's, and the golden hashes stable until a deliberate change.
4. **Code names stay.** Packages, database schemas, repository names, environment variables and the `ebmr` prefix do
   not change; renaming them would touch every migration and test for no user benefit. Only text that users see
   changes.

## When

The branding goes into a later slice, after the Phase 6 exit (Phase 7 hardening):
- screen texts
- the logo asset
- the handbook cover
- the web app's title and icon

The owner supplied the logo on 17 October 2026: `docs/brand/medhanta-logo-278x148.png` (PNG, 278 x 148 px, with the
tagline "Where Expertise Meets Intelligence"). That size is enough for the header and the sign-in screen. The handbook
cover and printed product documents need a larger file: an SVG, or a PNG of 1000 px or more, still to come from the
owner. The logo is not taken from the website.

Colours sampled from that file, approximate until a brand guide gives the exact codes:
- red-orange about #D4553A
- amber about #EF9E45
- grey (wordmark) about #6C6C6C

## Before launch (owner)

- Search "Batchwright" in the trademark registers of India (IP India), the United States (USPTO) and the European
  Union (EUIPO), in classes 9 and 42.
- Check the domain names.
- If the name is taken, this record is amended; nothing in the code depends on it.

## Note

Learnova, Medhanta's learning platform, can be offered as the training system that the eBMR's learning-system
adapter (slice 6a) reads before a step signature. A dedicated Learnova adapter is a possible later item, once its
interface is known.
