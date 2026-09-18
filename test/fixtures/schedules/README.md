# Municipal timetable regression fixtures

These are complete, unmodified municipality PDFs, gzip-compressed for storage. `sources.json` records each original URL, uncompressed byte count and SHA-256. They were captured on 18 September 2026. Tests decompress them and run real PDF.js extraction without network access.

| Fixture | What it covers |
| --- | --- |
| weekday-2026-08-27 | Original layout; 15 routes; Ç11Ç and separate Kalabaklı table |
| weekday-2026-09-17 | Reported replacement; hyphenated route labels; 16 routes; Ç10 changes departure-column order; shifted annotated cells |
| weekend-2026-09-12 | Older weekend layout; 10 routes; SSK annotations; ÇT1 end-of-service cells |
| weekday-2026-09-17-r18 | Later same-day publication; updated Ç2 directions and departures |
| weekend-2026-09-19 | Unfamiliar express heading; omitted departure marker recoverable from reciprocal arrival headings; index-only Ç2 |
| weekday-2026-09-21 | Future effective timetable; changed Ç10 departures and ÇT3 frequency |

## Independently checked expectations

Rendered source pages were inspected for the difficult layouts:

- 17-EYLUL-15, page 10: Ç10 has 23 departures from Nusrat and 19 from Ardes. The second section reverses its columns; arrival times in the first section must not become Ardes departures.
- Pages 13–14: Ç11K sections use different terminus labels; the express 07:50 departure has an iskele annotation.
- Page 16: Ç11Ç has six city and seven village departures, including 08:50-ESENLER. The separate Kalabaklı table must not be merged into it.
- 12-EYLUL-11, page 10: ÇT1 has four departures per direction; 09:45-bitiş and 18:10-bitiş are service-end times.
- 19-EYLUL-5, page 6: Ç8 express has 37 departures per direction. The first origin omits KALKIŞ but both endpoints have reciprocal VARIŞ labels.
- **19-EYLUL-5 lists Ç2 on its cover but has no Ç2 timetable in its 14 pages.** This fixture must pass with all 13 actual routes recognized and Ç2 recorded as an index-only diagnostic. No Ç2 departures should be invented.

Tests also repeat extraction results with reordered text, scaled geometry, alternate dash/clock typography and fragmented clock glyphs. They exercise missing pages/headings, invalid clocks and unknown tables.

For a new regression, download the exact failing PDF from the CI artifact, gzip its original bytes, append its provenance to `sources.json`, visually inspect the relevant pages, and add explicit expected counts/times or expected failures in `test/schedule-test.mjs`. Never fetch fixture URLs during tests: the municipality can replace a file at the same URL.
