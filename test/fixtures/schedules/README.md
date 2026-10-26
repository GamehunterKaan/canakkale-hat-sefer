# Municipal timetable regression fixtures

These are complete, unmodified municipality PDFs, gzip-compressed for storage. `sources.json` records each original URL, uncompressed byte count and SHA-256. The first six were captured on 18 September 2026; October fixtures were captured on 7 October 2026. Tests decompress them and run real PDF.js extraction without network access.

| Fixture | What it covers |
| --- | --- |
| weekday-2026-08-27 | Original layout; 15 routes; Ç11Ç and separate Kalabaklı table |
| weekday-2026-09-17 | Reported replacement; hyphenated route labels; 16 routes; Ç10 changes departure-column order; shifted annotated cells |
| weekend-2026-09-12 | Older weekend layout; 10 routes; SSK annotations; ÇT1 end-of-service cells |
| weekday-2026-09-17-r18 | Later same-day publication; updated Ç2 directions and departures |
| weekend-2026-09-19 | Unfamiliar express heading; omitted departure marker recoverable from reciprocal arrival headings; index-only Ç2 |
| weekday-2026-09-21 | Future effective timetable; changed Ç10 departures and ÇT3 frequency |
| weekday-2026-10-07 | Repeated wide Ç4 terminal header; evening section changes return terminus |
| weekday-2026-10-08 | Future effective timetable; 17 routes; latest Ç4 and Kepez express changes |
| friday-c4-2026-10-07 | Single-route Friday override; Ç4 departures include 14:37 |
| friday-kepez-2026-10-07 | Three-route Friday override; omitted Dardanos departure marker; small route caption above the column headers |
| weekday-2026-10-20 | 18 routes; Ç11K express evening header without KALKIŞ/VARIŞ at its mirrored Kepez 144 TOKİ endpoints; KALKIŞ on the middle line of a wrapped header |
| weekday-2026-10-22 | Same Ç11K express evening section with its header on one line: a single wide KEPEZ TOKİ caption reaching past the table edge, and no VARIŞ in the row |
| weekday-2026-10-26 | Ç11K express day header prints KALKIŞ over the closing Dardanos arrival too (three KALKIŞ columns); evening headers fully labelled, with a KEPEZ TOKİ caption wider than its KALKIŞ; evening section continues on page 17 |
| special-2026-10-28 | 28 October timetable; same Ç11K express pages as weekday-2026-10-26; different ÇT1 and ÇT2; ÇT2 trip ending "14:00 BİTİŞ" with BİTİŞ past the column edge |
| weekend-2026-10-31 | October weekend layout; heading words beside the route code (Ç-960 TOKİ, Ç-11K ESENLER); Çınarlı-marked Kepez TOKİ departures; cover lists Ç4 EKSPRES for a table headed Ç-4 ESENLER |
| friday-kepez-2026-10-26 | Three-page Friday Kepez edition; express table on page 1; white 06:50/07:50/08:30 and 07:20 cells; Çınarlı trips in the Dardanos columns under the page legend |

## Independently checked expectations

Rendered source pages were inspected for the difficult layouts:

- 17-EYLUL-15, page 10: Ç10 has 23 departures from Nusrat and 19 from Ardes. The second section reverses its columns; arrival times in the first section must not become Ardes departures.
- Pages 13–14: Ç11K sections use different terminus labels; the express 07:50 departure has an iskele annotation.
- Page 16: Ç11Ç has six city and seven village departures, including 08:50-ESENLER. The separate Kalabaklı table must not be merged into it.
- 12-EYLUL-11, page 10: ÇT1 has four departures per direction; 09:45-bitiş and 18:10-bitiş are service-end times.
- 19-EYLUL-5, page 6: Ç8 express has 37 departures per direction. The first origin omits KALKIŞ but both endpoints have reciprocal VARIŞ labels.
- **19-EYLUL-5 lists Ç2 on its cover but has no Ç2 timetable in its 14 pages.** This fixture must pass with all 13 actual routes recognized and Ç2 recorded as an index-only diagnostic. No Ç2 departures should be invented.
- The Friday Ç4 PDF has 62 origin and 65 return departures. Its 14:37 departure is absent from the regular weekday timetable. Five rows above the table ("07:35 - çataltepelilerden çt-3", "07:00 Kepez meydandan 11-K Esenler", ...) describe other routes' trips and are not Ç4 departures.
- The Friday Kepez PDF has Ç11K express, Ç11K, and Ç11Ç tables. Express arrivals explicitly identify both origins even though Dardanos omits KALKIŞ. The small route description above the headers must not become another terminal column or silently suppress Dardanos departures. The corrected October fixture expectations include both express directions.

Tests also repeat extraction results with reordered text, scaled geometry, alternate dash/clock typography and fragmented clock glyphs. They exercise missing pages/headings, invalid clocks and unknown tables, and a set of layout edits (KALKIŞ over the closing arrival, an origin without KALKIŞ, a lost or shifted EKSPRES subtitle, a reworded shuttle title, a renamed captioned origin, re-wrapped notes, margin labels, vehicle duty labels). Each edit must leave the routes unchanged or fail the PDF; a silent change is a bug.

## What the parser reads

- **Only visible text.** `extractPdf` renders every page and marks text whose glyph box shows no ink. The October editions leave white digits in empty cells: Ç3 18:20 from 20-EKIM-11, Ç11K Dardanos 06:50/07:50/08:30 and a 07:20 on the express page. These are listed in `diagnostics.ignored`, never published. White route headings on coloured bands are visible and still read.
- **Notes are not departures.** A time whose own cell names another route ("07:30 - JANDARMA IŞIKLARINDAN- Ç960", "22:05 (Ç3) SSK-HÜSEYİN ELBİ YURDU", "16:55 ESKİ HASTANE-GÜZELYALI (Ç11G)"), ends service or continues as another route ("14:00 BİTİŞ", "… OLARAK DEVAM EDECEKTİR"), or is a row-wide banner without stop times beside it ("7:30 SSK'dan ÇINARLI") is skipped and listed in `diagnostics.ignored`. A cell's words include those that continue it past the column edge and its wrapped lines.
- **Trips keep their real origin and end.** Each direction publishes `times` (departures from its `label`) and, when needed, `trips`:
  - `{ time, from, stops }`: the trip starts elsewhere, either a later section's KALKIŞ (Ç11K express evenings from Kepez TOKİ, Ç4 evenings from Eski Hastane) or a village the page legend says skips the terminal ("ÇINARLI / KALABAKLI SEFERLERİNİ GERÇEKLEŞTİREN ARAÇLAR YERLEŞKEYE UĞRAMAMAKTADIR"). `stops` lists the trip's later timed stops.
  - `to`: when a direction's sections end at different stops, every trip names its own end.
  - `note`: the cell's own annotation, such as "kalabaklı" or "SSK".

  A direction's departures are its `times` plus its `trips` that have `from`.

The 7 October fixture was captured from the failing 7 October 2026 Actions run's `timetable-diagnostics` artifact. Page 6 was visually checked: the repeated Hüseyin Elbi header belongs to Ç4, with 12 evening departures from 18:20 through 22:00 and 11 return departures from 19:00 through 22:20. The return terminus changes from Bahriye Üçok Caddesi to Eski Hastane in the evening section.

The 22 October fixture (20-EKIM-11) was captured from the failing 22 October 2026 Actions run's `timetable-diagnostics` artifact. Page 16 was checked cell by cell against its extracted text layer, not a render. From 18:20, Ç11K express buses start at Kepez TOKİ instead of Dardanos. There are 22 departures from Kepez TOKİ (18:20 through 00:00) and 21 return departures from Gazi Okulu (19:05 through 23:55). Earlier in the day there are 55 Dardanos and 60 Gazi Okulu departure cells. The centred banner "7:30 SSK'dan ÇINARLI" (bus 7 repositions from SSK) is not one of them, although its time falls in the Gazi Okulu column. Every other route parses exactly as it did before this fix.

The 26 and 28 October fixtures (26-EKIM, 28-EKIM-9) were captured from the failing 26 October 2026 run's artifact. Pages 16 and 17 were counted column by column from the text layer.
- **Day section:** 52 plain Dardanos cells plus 3 çınarlı/kalabaklı trips give 55 departures. 59 Gazi Okulu cells plus 16:20 kalabaklı give 60.
- **Far DARDANOS "KALKIŞ" column:** its 60 times each fall about 5 minutes after the Kepez TOKİ column in the same row, so they are trip ends.
- **Evening:** 9 and 9 departures on page 16, then 14 Kepez TOKİ and 12 Gazi Okulu on page 17.

Every other route parses exactly as it did before this fix.

The 20 October fixture (20-EKIM-6) was captured from the failing 20 October 2026 hourly refresh, which rejected it with `Page 16: unknown unnumbered table: KEPEZ`. Page 16 was visually checked: the Ç11K express evening header is a shortened row reading only "KEPEZ / 144 TOKİ" at both outer columns, without the KALKIŞ/VARIŞ line earlier editions had. The left column has 19 departures from 18:25 through 23:45, and Gazi Okulu has 18 departures from 19:10 through 23:50. The morning section's last row (18:05 Dardanos, 18:50 Gazi Okulu) lies directly above that header and belongs to the morning section.

The 31 October weekend (31-EKIM-10) and the Friday Kepez edition (KEPEZ-HATTI-CUMA-GUNU-SEFERLERI) were captured from the live municipality page on 26 October 2026. Every page of both, and every page of the 26 October weekday, was audited against renders at 3x. The audit found the hidden cells and note rows listed above, the ÇT2 "14:00 BİTİŞ" end of service on 28 October, and the evening sections published under the wrong terminal. The weekend's Ç11K and Ç11K EKSPRES "çınarlı" marks stay notes on Kepez TOKİ departures. The legend only says those trips skip the campus, which the weekend table does not serve.

`municipality-2026-10-07.html.gz` is the original [timetable-page HTML](https://ulasim.canakkale.bel.tr/rehber/hatlar-otobus-saatleri/) captured on 7 October after the two Friday PDFs were added, gzip-compressed without modifying its contents. Discovery tests use this snapshot; refresh/selection/renderer tests combine it with the real future weekday and Friday PDFs and controlled regular-source responses. They check Thursday, Friday, a later Friday, weekend and holiday behavior, publication-date filenames, and independent updates when a supplemental source fails.

For a new regression, download the exact failing PDF from the CI artifact, gzip its original bytes, append its provenance to `sources.json`, visually inspect the relevant pages, and add explicit expected counts/times or expected failures in `test/schedule-test.mjs`. Never fetch fixture URLs during tests: the municipality can replace a file at the same URL.
