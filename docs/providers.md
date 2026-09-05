# Provider Reference

Universal Game Asset Hub · verified 2026-09

How to read this document: every connector is built on **verified official
access mechanisms**. Where a site offers no public API — or automated access
would violate its terms or `robots.txt` — the connector is implemented as
**Manual / unsupported automation** (browser deep-links + `asset-hub import` /
the desktop Local Import wizard) instead of invented endpoints. We never fake
integrations.

`asset-hub sources` prints a live version of this table from the binary itself.

## Compatibility matrix

Provider | Search | Metadata | Download | API | License data | Automation status
---|---|---|---|---|---|---
Poly Haven | ✅ API | ✅ API | ✅ official CDN URLs | `api.polyhaven.com` (free, UA policy) | site-wide CC0, API-confirmed per asset | **Full** — official API
AmbientCG | ✅ API | ✅ `full_json` | ✅ official `get?file=` zips | `ambientcg.com/api/v2` (GET-only; robots allows) | site-wide CC0, per-asset API | **Full** — official API
Sketchfab | ✅ API (anonymous) | ✅ API | ✅ only `downloadable` models, user token | `api.sketchfab.com/v3` | **per asset** (`license` field: cc0, cc-by-4.0, cc-by-nc…, standard) | **Full** — downloads key-gated
Poly Pizza | ✅ API | ✅ API | ✅ official GLB URLs | `api.poly.pizza/v1.1` | per asset (CC0 / CC-BY) | **Full** — free API key required
BlenderKit | ✅ API (public) | ✅ API | ✅ API `downloadUrl`s | `www.blenderkit.com/api/v1` | per asset (cc0 / royalty-free) | **Full** — downloads key-gated
OpenGameArt | ❌ opens site search | ✅ single `/content/` page (robots-permitted, crawl-delay honored) | 🔶 browser download + `import` | Drupal site, no search API | per asset, parsed from page (CC0/CC-BY/GPL…) | **Hybrid** — robots-compliant single-page fetch
Kenney | ❌ browser | 🔶 manual | ❌ browser + `import` | none | site-wide CC0 (pre-filled at import) | **Manual / unsupported automation**
Quaternius | ❌ browser | 🔶 manual | ❌ browser + `import` | none | site-wide CC0 | **Manual / unsupported automation**
KayKit | ❌ browser | 🔶 manual | ❌ browser + `import` (itch.io hosted) | none | site-wide CC0 | **Manual / unsupported automation**
CGBookcase | ❌ browser | 🔶 manual | ❌ browser + `import` | none (robots: content-signals, no grant) | site-wide CC0 | **Manual / unsupported automation**
itch.io | ❌ browser | 🔶 manual | ❌ browser + `import` | only for a developer's own assets | per asset, user confirms at import | **Manual / unsupported automation**
CGTrader | ❌ browser | 🔶 manual | ❌ browser (many paid) | partner-only API | per asset (page terms) | **Manual / unsupported automation**
TurboSquid | ❌ browser | 🔶 manual | ❌ browser | partner-only API | per asset (RF licenses vary) | **Manual / unsupported automation**
Free3D | ❌ browser | 🔶 manual | ❌ browser (mixed free/paid) | none | per asset | **Manual / unsupported automation**
Mixamo | ❌ browser | 🔶 manual | ❌ browser (Adobe sign-in) | none; automation prohibited | Adobe/Mixamo terms | **Manual / unsupported automation**
Fab (Epic) | ❌ browser | 🔶 manual | ❌ browser (mixed free/paid) | none; ToS restricts automation | per asset | **Manual / unsupported automation**

✅ = automated through official endpoints · 🔶 = user-assisted · ❌ = not
automated (by design). "browser" = the tool opens the official page for you
and never scrapes it.

## License summary by source

| Source | Licenses observed | Attribution? | Commercial? |
|--------|-------------------|--------------|-------------|
| Poly Haven · AmbientCG · Kenney · Quaternius · KayKit · CGBookcase | CC0 | No | 🟢 Yes |
| Sketchfab (downloadable) | CC0 · CC-BY(-SA) 4.0 · CC-BY-NC(-SA) · Sketchfab Standard/Editor | 🔵 per asset | 🟢/🟡/🔴 per asset |
| Poly Pizza | CC0 · CC-BY | 🔵 CC-BY: yes | 🟢 Yes (with credit) |
| BlenderKit | cc0 · BlenderKit royalty-free | 🟡 RF: conditions | 🟡 RF: conditions |
| OpenGameArt | CC0 · CC-BY(-SA) · CC-BY-NC · GPL 2/3 · custom | Per asset | Per asset |
| itch.io · CGTrader · TurboSquid · Free3D · Mixamo · Fab | Per asset, confirmed at import | Per asset | Per asset |

Downloads are **blocked** whenever the per-asset license cannot be verified
(`LICENSE UNKNOWN`) — by the core download gate, not just the UI.

## Mirror classification

`asset-hub mirror report` classifies every provider from real capabilities:

- **FULL_MIRROR** — enumerable, downloadable, per-asset licenses permit
  redistribution: Poly Haven, ambientCG (CC0 throughout).
- **PARTIAL_MIRROR** — downloadable but licensed per asset; mirrored only when
  the individual asset's license permits redistribution: Sketchfab, Poly
  Pizza, BlenderKit, Khronos glTF Samples (GitHub; every model declares its
  own SPDX licenses — mixed NC/None components make the asset
  non-redistributable and the gate skips it).
- **MANUAL_ONLY** — no permitted automated enumeration/download; the catalogue
  records the official page: Kenney, OpenGameArt, Mixamo, CGBookcase.
- **UNSUPPORTED** — known but not integrated: Quaternius (direct download
  packs, no API), CGTrader/TurboSquid (marketplace terms).

## Additional sources researched (not integrated — and why)

We investigated further legitimate 3D-asset sources. None of the following
are integrated, because each fails at least one requirement (official public
API + permission for the access we need + stable documented endpoints). This
list exists so the decisions are auditable and so contributors don't re-litigate
them blindly — if one of these sites publishes an official public API, a
connector is welcome (see docs/development.md).

| Source | Status | Reasoning |
|--------|--------|-----------|
| **Smithsonian Open Access** (3d.si.edu / si.edu/openaccess) | Candidate | Free `api.si.edu` search API exists (key-gated) and metadata is CC0, but 3D download assets are served through the Edan/3D viewer, not a documented stable download endpoint. Integrating would require guessing endpoints — not done. |
| **Wikimedia Commons** | Candidate | Well-documented `action=query` API hosts STL/OBJ/PLY files with per-file license metadata. However `robots.txt` for the generic agent disallows crawling under `/w/`, and this tool treats itself bound by robots.txt; the API path falls under it. Not integrated to stay unambiguously compliant. |
| **NASA 3D Resources** (nasa3d.arc.nasa.gov) | Manual-only value | Content is public domain, but the site has no API and a bespoke page structure; same tier as Kenney (import with PD/CC0 license). Not added as a dedicated connector since it would only duplicate the generic manual-import workflow. |
| **Printables** | Not integrated | GraphQL API exists but requires individually approved API keys and is aimed at 3D-printing use cases; license/download terms for bulk tooling are not clearly granted. |
| **Thingiverse** | Not integrated | API requires OAuth and the ToS is restrictive about automated downloads; anti-bot protections present. Manual tier semantics; duplicate of generic import. |
| **ShareCG / 3DZIP / model-pack aggregator sites** | Rejected | No APIs, mixed/scraped licensing, frequent mislabeled rights. Not reliable for license accuracy. |

Adding any new provider follows the same rules: evidence first, matrix row
second, code third (see docs/development.md → "Adding a provider").

## Safeguards implemented per source

- **Robots compliance**: OpenGameArt single-page imports are checked against
  robots.txt (incl. `Crawl-delay: 10`) before any fetch; `/search/` is never
  requested. Manual-tier sites are never scraped.
- **Rate limits**: per-host token buckets (defaults ≤ 40 req/min; OpenGameArt
  ≥ 12 s between requests). 429/`Retry-After` → automatic cool-down, never
  circumvented.
- **Auth walls**: Sketchfab / BlenderKit / Poly Pizza downloads go only
  through official endpoints with your own key/token (`asset-hub config` /
  Settings → API keys; OS credential storage). No session replay, no cookie
  scraping, keys never logged.
- **Paid content**: never fetched from any source; the tool only opens the
  official page.
- **CAPTCHAs / anti-bot**: tasks fail with *"Automated access is unavailable
  for this source. Open the official asset page to obtain it manually."* —
  no solving, no retry loops, no bypass.
- **Unknown licenses**: `download` hard-refuses (core-level `LICENSE_UNKNOWN_BLOCK`).
