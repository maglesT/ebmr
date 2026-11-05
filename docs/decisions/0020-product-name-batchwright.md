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

## The Batchwright logo (owner, 17 October 2026: concept A)

Batchwright has its own logo in the style of Medhanta's other products (Learnova, eAACS, Remindora, DocuIQ, Momentum):
- **Icon:** a batch-record clipboard and a capsule, in the Medhanta orange-to-red gradient, with the trail of dots the
  family shares.
- **Wordmark:** "Batch" in grey and "wright" in the gradient, set in Poppins Bold (SIL Open Font Licence).
- **Edition badge:** TABLETS or INJECTABLES under the wordmark. The badge is the only part that changes between
  editions.
- **Tagline:** "Every batch, proven".

The files are in `docs/brand/`:

| File | What |
|---|---|
| `batchwright-logo.svg` | full logo, with the tagline |
| `batchwright-tablets.svg` | the Tablets edition lockup |
| `batchwright-injectables.svg` | the Injectables edition lockup |
| `batchwright-icon.svg` | the icon alone: app icon, browser-tab icon |

Each SVG has a PNG export beside it at 2x (the icon at 4x).

The application shows Batchwright (with its edition) as the product and the Medhanta logo as the maker. Before
print or launch:
- A designer converts the wordmark text to outlines and polishes the shapes.
- The logo goes into the trademark search with the name.

## Amendment, 4 November 2026: Batchwright Capsules (owner, through the lead)

Hard capsules and soft gels are library data inside the Tablets build (`docs/build-plan/capsules/plan.md`), not an
edition of their own. The header reads "Batchwright Capsules" while a master or batch with a capsule dosage form is on
screen, and "Batchwright Tablets" otherwise. A dosage form is a capsule form only when it contains "capsule" (any case);
no dosage form means a tablet; a bare soft-gel name ("Softgel") is refused with the hint to name it as a capsule form
(`flow.readDosageForm` in recipe-core). On the platform build the dosage form is core's (report.product_v1
`dosage_form`). `CAPSULES` is a display value of ui-kit's `brand.Edition` only: it has no lockup (the sign-in page and
the about page keep the Tablets lockup), no database, no edition value and no app. As before, the name never goes on a
GMP record.

## Before launch (owner)

- Search "Batchwright" in the trademark registers of India (IP India), the United States (USPTO) and the European
  Union (EUIPO), in classes 9 and 42.
- Check the domain names.
- If the name is taken, this record is amended; nothing in the code depends on it.

## Note

Learnova, Medhanta's learning platform, can be offered as the training system that the eBMR's learning-system
adapter (slice 6a) reads before a step signature. A dedicated Learnova adapter is a possible later item, once its
interface is known.

## Amendment, 5 November 2026 (owner, through the lead; declutter slice D3)

The sign-in page, the browser title, the product list and the manifest's name say just "Batchwright". The screen header
names the edition of the record on screen: "Batchwright Tablets" in the Tablets web app (and Capsules, Injectables or API
in theirs, by the edition mechanism of the capsules slice C2 once it is shared). The edition lockups stay available in the
kit. Point 3 is unchanged: GMP records, true copies, labels, reports and certificates never carry the vendor's name.
