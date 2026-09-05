# Source Compatibility Matrix

Universal Game Asset Hub · verified 2026-09

Every connector in UGAH is built on **verified** official access mechanisms.
Where no official API exists, or automation would violate the site's terms or
`robots.txt`, the connector is implemented as **Manual / unsupported automation**
(browser deep-links + local import) rather than inventing endpoints.

Legend — **Search**: in-app search via official API · **Download**: automated
download of permitted assets · **License**: how per-asset license is determined ·
**Key**: API key required from the user (entered in Settings, stored in OS secure
storage).

| # | Source | Official API | Search | Download | License (per asset) | Key | Tier |
|---|--------|--------------|--------|----------|--------------------|-----|------|
| 1 | **Poly Haven** | ✅ `api.polyhaven.com` — free for everyone incl. commercial use; requests a descriptive `User-Agent` | ✅ `GET /assets?type=` | ✅ `GET /files/{id}` returns official `dl.polyhaven.org` URLs + sizes + **md5** | Site-wide **CC0**; API confirms per asset | No | **Full** |
| 2 | **AmbientCG** | ✅ `ambientcg.com/api/v2` (`full_json`, `downloads_csv`, `categories_json`, `releases_rss`; GET-only). `robots.txt` allows crawling | ✅ `full_json?q=&type=` | ✅ official `ambientCG.com/get?file=…` links returned by API (1K→8K zips) | Site-wide **CC0**; API per asset | No | **Full** |
| 3 | **Sketchfab** | ✅ Data API v3 `api.sketchfab.com/v3` | ✅ `GET /v3/search?type=models&q=&downloadable=` (public, no key) | ✅ **only models flagged downloadable**, via official `GET /v3/models/{uid}/download` with the user's API token (Account → Settings → API) | **Per asset** from API (`license` field: `cc0`, `cc-by-4.0`, `cc-by-nc-…`, `sketchfab-royaltyfree`, …) | Search: no · Download: **yes** | **Full** (token-gated download) |
| 4 | **Poly Pizza** | ✅ `api.poly.pizza/v1.1` (official docs at poly.pizza/api) | ✅ `GET /search?q=` | ✅ official per-model `Download` GLB URL returned by API | **Per asset**: CC0 or CC-BY (+ creator attribution) | **Yes** (free) | **Full** (key-gated) |
| 5 | **BlenderKit** | ✅ `www.blenderkit.com/api/v1` (documented; powers the official add-on) | ✅ `GET /api/v1/search/?query=&asset_type=` (public) | ✅ file `downloadUrl`s come from the API; requests require the user's BlenderKit API key (free account) | **Per asset**: `cc0` or BlenderKit royalty-free (conditions) | Search: no · Download: **yes** | **Full** (key-gated download) |
| 6 | **OpenGameArt** | ❌ No public search API. `robots.txt`: `Crawl-delay: 10`, `Disallow: /search/` → **search pages must not be crawled** | ❌ opens site search in browser | 🔶 **User-initiated single import**: paste an asset's `/content/…` URL; UGAH fetches that one robots-permitted page (respecting crawl-delay) and extracts license/metadata; file downloaded by the user in their browser | **Per asset** parsed from the content page (CC0/CC-BY/GPL/CC-BY-SA…); unknown → blocked | No | **Hybrid** |
| 7 | **Kenney** | ❌ No API (no robots.txt published) | ❌ opens kenney.nl/assets in browser | ❌ Manual — Local Import wizard; Kenney publishes everything **CC0** | Site-wide **CC0** (pre-filled in import wizard, editable) | No | **Manual** |
| 8 | **Quaternius** | ❌ No API (no robots.txt) | ❌ opens quaternius.com in browser | ❌ Manual — Local Import; all packs **CC0** (also discoverable via Poly Pizza API) | Site-wide **CC0** | No | **Manual** |
| 9 | **KayKit** | ❌ No API (distributed via itch.io) | ❌ opens kaylousberg.itch.io in browser | ❌ Manual — Local Import; **CC0** | Site-wide **CC0** | No | **Manual** |
| 10 | **CGBookcase** | ❌ No API; `robots.txt` is a Content-Signals file granting no explicit collection permission | ❌ opens site in browser | ❌ Manual — Local Import; textures **CC0** | Site-wide **CC0** | No | **Manual** |
| 11 | **itch.io** | ❌ Public API only covers a developer's **own** assets; no public search API; anti-bot protections | ❌ deep-link search URL in browser | ❌ Manual — Local Import (license chosen per asset; varies wildly) | **Per asset** — user selects from registry during import | No | **Manual** |
| 12 | **CGTrader** | ❌ API only for approved partners (api.cgtrader.com) | ❌ | ❌ Manual — many assets are **paid**; never auto-download | Per asset (page states license/rights) | No | **Manual** |
| 13 | **TurboSquid** | ❌ Partner API (api.turbosquid.com) requires approved partnership | ❌ | ❌ Manual — Royalty-Free licenses vary per asset | Per asset | No | **Manual** |
| 14 | **Free3D** | ❌ No API | ❌ | ❌ Manual — mixed free/paid, per-asset licenses | Per asset | No | **Manual** |
| 15 | **Mixamo** | ❌ No API; requires Adobe sign-in; automation prohibited | ❌ | ❌ Manual — users download via their Adobe account in browser; Local Import | Adobe ToS; per-asset usage per Mixamo terms | No | **Manual** |
| 16 | **Fab (Epic)** | ❌ No public API; ToS restrict automated access | ❌ | ❌ Manual — mixed free/paid; licenses per asset | Per asset | No | **Manual** |

## Automatic license summary by source

| Source | Licenses observed | Attribution needed? | Commercial OK? |
|--------|-------------------|--------------------|----------------|
| Poly Haven | CC0 | No (courtesy credit optional) | 🟢 Yes |
| AmbientCG | CC0 | No | 🟢 Yes |
| Sketchfab (downloadable) | CC0 · CC-BY 4.0 · CC-BY-SA · CC-BY-NC(-SA) · Sketchfab Standard/Editor | 🔵 Depends | 🟢/🟡/🔴 depends — per-asset badge |
| Poly Pizza | CC0 · CC-BY | 🔵 CC-BY: yes | 🟢 Yes (CC-BY with credit) |
| BlenderKit | cc0 · royalty-free (BlenderKit license) | 🟡 RF: conditions (no resale, no redistribution of source) | 🟡 RF: conditions · CC0: yes |
| OpenGameArt | CC0 · CC-BY(-SA) · CC-BY-NC · GPL 2/3 · custom | Per asset | Per asset |
| Kenney / Quaternius / KayKit / CGBookcase | CC0 | No | 🟢 Yes |
| itch.io · CGTrader · TurboSquid · Free3D · Mixamo · Fab | Per-asset (user confirms at import) | Per asset | Per asset |

## Safeguards implemented per source

- **Robots compliance**: OpenGameArt content-page imports are checked against
  robots.txt (incl. `Crawl-delay: 10`) before any fetch; `/search/` is never
  requested by UGAH. Manual-tier sites are never scraped.
- **Rate limits**: per-host token buckets (defaults ≤ 40 req/min; OGA ≥ 12 s
  between requests). 429/`Retry-After` → automatic cool-down, never circumvented.
- **Auth walls**: Sketchfab/BlenderKit/Poly Pizza downloads only through official
  endpoints with the user's own key/token; no session replay, no cookie scraping.
- **Paid content**: CGTrader/TurboSquid/Free3D/Fab/itch paid assets are never
  fetched; the connector only opens official pages.
- **CAPTCHAs/anti-bot**: if a provider returns a CAPTCHA or auth challenge, the
  task fails with the standard "Automated access is unavailable…" message and an
  *Open official page* button. No solving, no retry loops.
- **Unknown licenses**: `download()` hard-refuses (UI blocks the button) until a
  license is established from the provider or manually confirmed during Local
  Import.
