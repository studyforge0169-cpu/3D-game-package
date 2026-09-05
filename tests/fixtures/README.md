# Test fixtures & provenance

These fixtures let the full test suite run **offline** (CI/sandbox) while
exercising the real provider code paths (parsing, license mapping, download
verification). None of them are presented to users as search results — they
are only test inputs.

| File | Provenance |
|---|---|
| `polyhaven_assets.json` | Entries copied verbatim from Poly Haven's **official API documentation** page (https://polyhaven.com/our-api — the example response), trimmed to 3 assets. Real API data published by the source. |
| `polyhaven_files.json` | Same official docs page — the documented `/files/{id}` response for `sunset_jhbcentral` (URLs/sizes/md5 exactly as documented). |
| `ambientcg_downloads_csv.txt` | Response published in ambientCG's **official API v2 docs** (docs.ambientcg.com — the documented `/downloads_csv` example for `DaySkyHDRI020A`). |
| `ambientcg_full_json.json` | Recorded-shape sample of `/full_json` following the documented schema (docs.ambientcg.com/api/v2/full_json). Parsing logic under test — see `tests/providers-fixtures.test.ts`. |
| `sketchfab_search.json` | Synthetic sample matching the **documented** Data API v3 search response schema (docs.sketchfab.com/data-api/v3) incl. license objects and downloadable flags. Parsing logic under test. |
| `polypizza_search.json` | Synthetic sample matching the documented poly.pizza v1.1 search schema (poly.pizza/api). |
| `blenderkit_search.json` | Shape from the public www.blenderkit.com/api/v1/search response (fields cross-checked with the public GitHub issue #1105 log output of BlenderKit's own client). |
| `oga_content.html` | Minimal page snippet with the same markup OpenGameArt serves for `/content/...` pages (og: meta tags + CC license links), for the robots-scoped import parser. |

Live API verification runs separately via `npm run test:live`
(`UGAH_LIVE_API_TESTS=1`), which is the source of truth for endpoint drift.
