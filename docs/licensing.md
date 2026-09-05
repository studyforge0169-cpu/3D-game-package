# Legal & Licensing — Universal Game Asset Hub

This document explains exactly what the application does with third-party
content, what it refuses to do, and what obligations remain with you, the
user. It is not legal advice.

## Application code

Universal Game Asset Hub itself is licensed under the Apache License 2.0
(see `LICENSE`). It ships no third-party 3D assets.

## Core principles (enforced in code)

1. **Per-asset licensing.** The app never assumes a site is "all free".
   Each asset's license is fetched from the source's official API/metadata.
   License state is stored with a check date and surfaced everywhere (search
   results, detail view, exports, attributions).
2. **Unknown license ⇒ no download.** If license data cannot be verified, the
   download service blocks the task with `LICENSE_UNKNOWN_BLOCK`. This cannot
   be bypassed from the UI.
3. **No paywall / DRM / authentication circumvention.** The app uses official
   endpoints with the user's own credentials where offered (Sketchfab token,
   Poly Pizza key, BlenderKit key). It never unlocks paid content, strips
   watermarks, or shares accounts. Downloads requiring purchase are simply not
   offered.
4. **No scraping of sites that don't permit it.** Sources without public APIs
   are "Manual workflow": the app opens the official page in your browser and
   supports a compliant import (you confirm the license). It does not crawl,
   search-scrape, or simulate results for those sources — and it will tell you
   so rather than pretend.
5. **robots.txt and rate limits are honored.** The shared HTTP client caches
   and obeys robots.txt, enforces per-host pacing, and respects documented
   rate limits (e.g. OpenGameArt's 10-second crawl-delay on its
   robots-permitted content pages).
6. **Originals are immutable.** Downloaded files are hashed and never
   modified. Conversion outputs live in separate `Processed`/`GameReady`
   areas. Project exports never overwrite existing files without explicit
   confirmation.
7. **Privacy.** No telemetry, no account system, no upload of user data.
   API keys live in the OS credential vault (Windows Credential Manager via
   DPAPI; Keychain on macOS; libsecret where available), are excluded from
   logs by the scrubbing logger, and are never transmitted to anyone but the
   source they belong to.

## What the license badges mean

| Badge | Meaning | Download policy |
|---|---|---|
| 🟢 commercial-safe | CC0/public domain or an explicit commercial-use grant | Allowed |
| 🟡 conditional | Allowed under conditions (e.g. share-alike, non-endorsement) | Allowed; conditions listed on the license screen |
| 🔵 attribution-required | CC-BY and similar | Allowed; asset is auto-added to ATTRIBUTIONS output |
| 🔴 non-commercial | CC-BY-NC etc. | Allowed to download; clearly marked — do not ship commercially |
| ⚫ unknown | License could not be verified from official data | **Blocked** |

The badge is a summary. The license-details screen shows the license name,
SPDX id, full text/URL, source of truth and verification date — check it
before shipping anything.

## Your obligations as a user

- **Read the license of every asset you ship.** UGAH surfaces official license
  data, but the license is between you and the author. In particular:
  - CC-BY requires attribution (name, license link) — use the built-in
    ATTRIBUTIONS generator and keep the files with your game.
  - Share-alike (CC-BY-SA / GPL assets) can impose obligations on how you
    distribute derived works.
  - "Non-commercial" means what it says; commercial games must avoid these.
  - Some sources have extra terms (e.g. Sketchfab's license options per
    upload, itch.io seller terms, Fab EULA). The license screen links them.
- **Don't redistribute raw asset packs** unless their license permits it
  (many "free download" sites forbid re-hosting).
- **Manual imports are your attestation.** When you import a file and pick its
  license, UGAH records your choice. Pick truthfully; the UI refuses imports
  with no license at all.

## Source-specific notes

Details, evidence and tier decisions per source live in
`docs/providers.md` (verified against each site's API docs /
robots.txt at development time). Summary of stance:

- **Public APIs used:** Poly Haven, AmbientCG, Sketchfab (search anonymous;
  downloads need your token), Poly Pizza, BlenderKit (key-gated downloads),
  OpenGameArt (robots-compliant data API; site search is manual by design).
- **Manual/browser workflow:** Kenney, Quaternius, KayKit, CGBookcase,
  itch.io, CGTrader, TurboSquid, Free3D, Mixamo, Fab — no public download API
  or automation not clearly permitted; the app intentionally does not fake it.

## Takedown / corrections

If you represent a source and believe this tool's integration oversteps your
terms, open an issue and it will be addressed promptly — connector tiers are
designed to be downgraded to Manual without touching anything else.
