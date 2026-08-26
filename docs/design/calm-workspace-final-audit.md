# Calm workspace — final production audit

Audit time: 2026-08-26 UTC. Source fingerprint: git HEAD
`6274a649693e4e0fb560338dffa98fc364c409d4` plus the visible uncommitted redesign
diff. Built assets at audit: `index-Cs12987Q.css` (87,324 bytes) and
`index-DEj-qEF2.js` (613,407 bytes). The build SHA remains the pinned HEAD SHA;
the filenames identify the exact visible-worktree bundle reviewed here.

## Shipped cascade and exceptions

`main.tsx` now imports five sheets in this order: `theme.css`, `motion.css`,
`app.css`, `redesign.css`, `layout-v4.css`. `dark-v3.css` and `onboarding.css`
are deleted, not disabled. The dead, unimported `TabIntro.tsx` is also deleted;
this is source cleanup and does not claim onboarding coverage.

`redesign.css` remains named for history, but contains only the Tailwind import,
inline theme bridge, reset/base sizing, form-font inheritance, tap-highlight,
focus and selection rules required by the current build pipeline. It owns no
component presentation. `app.css` retains structural/behavioral geometry;
`layout-v4.css` owns semantic component presentation; `theme.css` is the only
light/dark palette authority. The exhaustive scanner in
`tests/calm-workspace-final-contract.test.mjs` covers hex, RGB/HSL/HWB,
Lab/LCH/OKLab/OKLCH, `color()`, black/white names, and every gradient form in
all CSS/TS/TSX/MJS under `web/src`. Only theme tokens and the exact functional
contexts ledgered in `calm-workspace-theme-audit.md` remain.

## Production state and non-color cues

- Production-reachable: active/selected/unread contacts; pending introductions;
  ordinary human messages; room agent messages with author and role; labeled
  system notes; composer, reply, file/voice/image attachments; delivery/read/
  permanently-untracked receipts; connection/update/error banners; dialogs,
  settings, media, QR scanner fallback, Markdown/Mermaid and sandboxed HTML.
- Test-fixture-reachable: HTML/Markdown byte-missing and load-error branches.
  The unavailable file card does not normally expose a preview trigger, so the
  HTML missing preview is not claimed as an ordinary production navigation.
- Library/content-owned: Mermaid-generated SVG palette and user-authored
  Markdown/HTML content. App-owned surrounding chrome is semantic.
- Absent: the former onboarding and TabIntro flows. Prototype-only onboarding
  scenes are proposal history, not production coverage.

Pending introductions show queued text, a “pending approval” chip, a dashed
boundary and named Approve/Reject group. Selected rows have surface, border and
leading rule plus selection semantics. Delivery uses one tick, read two ticks,
and permanently untracked sends retain a one-tick “Sent” label; every receipt
has an aria label. Errors carry literal failure text and `role=alert`; warning
and connection states carry direct status language. Room agents show author +
role, while system events are labeled `role=note` cards. Grayscale therefore
retains text, count, border, alignment, icon/glyph and weight distinctions.

## Computed contrast from the built CSS

`tests/browser-calm-contrast.test.mjs` loads the built app in Chromium, reads
the computed semantic variables in each theme, resolves them through the
browser color engine and calculates WCAG contrast.

| Pair | Light | Dark | Result |
| --- | ---: | ---: | --- |
| Long-form / primary surface | 13.11 | 13.26 | AAA |
| Long-form / human surface | 11.79 | 11.87 | AAA |
| Long-form / agent surface | 12.83 | 12.52 | AAA |
| Long-form / system surface | 12.04 | 12.08 | AAA |
| Secondary/meta / surface | 4.87 | 7.10 | AA / AAA |
| Disabled / surface | 3.02 | 3.86 | >=3:1; disabled controls also use native semantics |
| Primary control label / action | 5.88 | 7.33 | AA / AAA |
| Focus / surface | 5.63 | 6.88 | UI AA |
| Focus / canvas | 5.21 | 7.65 | UI AA |
| Success indicator / status background | 4.10 | 6.53 | non-text UI AA |
| Warning text / background | 4.81 | 6.15 | AA |
| Error text / background | 4.53 | 6.05 | AA |
| Information text / background | 4.63 | 5.43 | AA |

Primary long-form text exceeds the practical AAA target in every provenance
surface. Forced-colors replaces surfaces/text/borders with system colors and
adds explicit selected borders/focus outlines; increased-contrast and reduced-
transparency policies are independently browser-tested.

## Evidence manifest

All current after-state frames below use the real built SPA, `/chats/DESIGN`,
the deterministic API fixture in `tests/capture-calm-workspace-slice.mjs`, and
were refreshed 2026-08-26 16:17–16:19 UTC. Desktop is 1440×960; mobile is
390×844 with touch/mobile context. Theme is set through the production storage
key before navigation.

| Frame | Conditions |
| --- | --- |
| `after-desktop-light.png` | desktop, light |
| `after-desktop-dark.png` | desktop, dark |
| `after-mobile-light.png` | mobile/touch, light |
| `after-mobile-dark.png` | mobile/touch, dark |
| `after-desktop-light-grayscale.png` | desktop light + full-page grayscale |
| `after-desktop-light-zoom200.png` | desktop light + root text at 200% |
| `after-slice2-after-invite-modal-{light,dark}.png` | Invite dialog, desktop |
| `after-slice2-after-media-mobile-{light,dark}.png` | Shared media, mobile |
| `after-slice2-after-qr-{light,dark}.png` | real encoder canvas, decoded exact invite |
| `after-slice2-after-scanner-mobile-dark.png` | no-camera scanner fallback |
| `after-slice3-after-chatlist-banner-{light,dark}.png` | pending list + connection banner |
| `after-slice3-after-settings-light.png` | desktop Settings |
| `after-slice3-after-settings-mobile-dark.png` | mobile Settings |
| `renderer-html-mobile-after.png` | hostile stored HTML, mobile sandbox |
| `renderer-mermaid-fullscreen-after.png` | valid Mermaid fullscreen after malformed sibling |

The six `before-*` frames are true pre-redesign production captures from
13:23 UTC. Slice-2 and slice-3 `before` frames are true slice-local captures.
There is no true renderer pre-change frame; none is fabricated or implied.
Renderer frames use their dedicated real-byte browser fixtures and the current
bundle, but retain their 16:07 UTC capture time because the final CSS cleanup
does not touch renderer output and their focused gates were rerun afterward.

## Performance and verification boundary

A clean `git archive HEAD` build with the pinned HEAD SHA measured CSS 142,620
bytes / 30,661 gzip and initial JS 613,667 / 194,009 gzip. The current final
bundle is CSS 87,324 bytes / approximately 20.35 kB gzip and initial JS 613,407
bytes / 193.74 kB gzip: CSS falls about 38.8% raw and 33.6% gzip; initial JS is
effectively flat. Mermaid core (623,188 bytes) and jsQR (130,719 bytes) remain
lazy chunks; no dependency became eager. Existing >500 kB warnings remain for
initial JS and lazy Mermaid/Cynefin chunks.

No merge, staging, publish, deployment, service restart, or live-daemon action
is part of this audit. WebKit remains the repository's CI-only gate when local
host dependencies are unavailable; Chromium mobile and all loopback work run
only through test harnesses.
