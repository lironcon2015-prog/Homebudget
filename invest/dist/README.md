# JuniorInvest — Offline Build

`JuniorInvest-Offline.html` is a single self-contained HTML file: open it directly in a browser (double-click) and the entire app runs from disk. No installation, no local server.

## Get the latest file

Always download from this raw URL — never edit the file in place:

```
https://raw.githubusercontent.com/lironcon2015-prog/Junior-Invest/main/dist/JuniorInvest-Offline.html
```

Right-click → "Save link as…" → save anywhere (Desktop is fine).

## What's bundled

- App JavaScript (minified, ~60 KB)
- Tailwind CSS pre-compiled for the classes used (~27 KB)
- Assistant + Hanken Grotesk fonts (Latin + Hebrew subsets, woff2 inlined)
- Material Symbols Outlined — subset of the 18 icons used in the UI
- Brand icon inlined as a data URL

Total: ~850 KB. No external CDN dependencies for layout, fonts, or icons.

## Online vs offline

The browser still needs internet for **refreshing share prices** (via the Cloudflare Worker, Yahoo Finance, Funder, Bizportal, or TASE). Everything else — editing transactions, viewing portfolios, exports — works fully offline.

## Updates

The file is rebuilt automatically by `.github/workflows/build-offline.yml` on every push to `main` that touches the source. Re-download whenever you want the latest version.

## Data sync between the hosted site and the offline file

`localStorage` is scoped per origin, so the data in `invest.lironcon.com` is **separate** from the data in your local `JuniorInvest-Offline.html`. Use the **Settings → גיבוי ושחזור → ייצוא JSON / ייבוא JSON** flow to copy a portfolio between the two.
