# JuniorInvest — Project Instructions for Claude Code

## Token discipline (MANDATORY — every session, without being asked)

Invoke the `token-efficient-workflow` skill (`.claude/skills/token-efficient-workflow.md`)
at the start of every session in this repository and follow it for the whole
session. Do not wait to be told, and do not skip it on tasks that look small.

In short: scoped `grep`/`ls` before reading, `view_range` instead of whole
files, never re-read a file already in context, `str_replace` over rewrites,
no filler or "I have updated…" narration.

Two carve-outs specific to this repo, because they are correctness
requirements rather than chatter:

- **State a verification's outcome.** Tests, renders and screenshots must be
  reported honestly, including failures and anything left unverified. Silence
  after an edit is fine; silence about a failed check is not.
- **Keep code comments that explain non-obvious *why*.** Brevity applies to
  chat output, not to the codebase.

## One design language, everywhere (MANDATORY)

Consistency outranks local cleverness. Every screen must read as the same app:
a new or edited screen adopts the existing patterns rather than inventing its
own, even when something bespoke would look better in isolation.

Before adding or changing a screen, look at the screens that already exist and
reuse:

- **Page frame** — the same header (title + subtitle), the same section
  headings, the same page padding and card spacing.
- **Card grammar** — identity on the start side, numbers on the end side.
  Lists of records are collapsed cards that expand into a detail accordion;
  they do not render fully expanded, and they do not become tables.
- **Shared components** — the glass card surface, the glowing pills, the
  tinted icon bubbles, the detail row. Extend the shared helper instead of
  writing a near-copy; two near-identical helpers will drift.
- **Semantics** — gains emerald, losses red, income the only coloured amount
  in the ledger, `<bdi dir="ltr">` around every Latin or numeric run.

If a screen genuinely needs a new pattern, apply it across the other screens
in the same change so the app stays uniform — never leave one screen speaking
a different dialect.

## Mockups: ship a live HTML page, into the chat

When a task calls for a mockup or design preview:

1. **Build it as a working HTML page, not a screenshot.** The user reviews it
   by tapping, expanding and scrolling it — a static image can't show whether
   an accordion feels right or a tap target is reachable.
2. **Deliver it into the chat, not only to the repo.** Publish it as an
   Artifact and give the user the link in the reply. Merging the file to `main`
   is not delivery on its own; the user should not have to go find it.
3. Committing the source as well is fine, but the chat link is the deliverable.

An Artifact is served under a strict CSP that blocks every external host, so
inline the CSS and embed assets as data URIs — a page relying on the Tailwind
CDN or Google Fonts renders unstyled. Build the Tailwind CSS locally
(`npx tailwindcss`) and inline it.

Screenshots are a supplement, never the substitute: attach them only when the
user is away from a browser or to point at one specific detail.

## Auto-merge policy (MANDATORY — follow without being asked)

After creating any pull request in this repository:
1. Immediately merge it to `main` using `mcp__github__merge_pull_request` (squash method).
2. Sync the local repo: `git fetch origin main && git pull origin main` on the feature branch is fine; reset local `main` to `origin/main` if needed.
3. Do **not** wait for the user to request the merge — do it automatically every time.

## Development branch

All new work goes on `claude/juniorinvest-architecture-plan-2uPS2` (or a new branch if that one is already merged).  Never push directly to `main` — always PR → auto-merge.

## Repository purpose

**JuniorInvest** — Vanilla JS SPA, Hebrew RTL, dark Tailwind theme.  
A multi-kid stock portfolio tracker: parent buys shares in one brokerage account; the app splits ownership across N kids by configurable % allocation.  Parent ghost shares are tracked internally for dividend math only and **must never appear in any UI output**.

## Key constraints

- Engine layer (`src/ledger`, `src/math`, `src/util`) is pure JS — zero DOM access.
- Ledger is append-only; all state is derived by `LedgerEngine.deriveState`.
- `proratePreservingTotal` (largest-remainder) is used everywhere money/shares are split across kids to avoid rounding leakage.
- SELL is kids-only (parent shares are never sold via this app).
- No WITHDRAW in v1.
- Quote source: manual `quotes` map; optional API refresh later.
- Persistence: `LocalStoragePersistence`, key `juniorinvest:v1`.
- `index.html` lives at repo root so GitHub Pages serves the app at the custom subdomain `https://invest.lironcon.com` (configured via the `CNAME` file at repo root). The apex `lironcon.com` is reserved for other sites on other subdomains.
