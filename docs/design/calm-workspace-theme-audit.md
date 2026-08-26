# Calm workspace theme: audit and annotated proposal

Status: phase-one proposal; no production CSS is changed. Reviewed scope with the assigned Critic on 2026-08-26.

## Artifact index and coverage

- This document inventories the current cascade, token sources, raw-color exceptions, interaction/status semantics, typography, materials, accessibility modes, responsive behavior, and regression fixtures.
- `web/prototypes/calm-workspace/index.html` is a framework-free, production-shaped comparison using the proposed semantic role names directly. It covers room list, selected/unread/pending rooms, human/agent/system messages, pending/delivered/read/error delivery, composer, reply, attachment, markdown/code, empty/loading/error states, modal/sheet, and a mobile mode.
- Serve from the repository root with `python3 -m http.server 4173`, then open `/web/prototypes/calm-workspace/`. The prototype uses static fixtures only: it does not model network timing, cryptographic verification, virtual-keyboard resizing, swipe physics, or screen-reader announcements from live updates. Those remain production verification gates.

## Current system audit

### Cascade and ownership

`web/src/main.tsx` loads, in order: `theme.css`, `motion.css`, `app.css`, `onboarding.css`, `redesign.css`, `dark-v3.css`, then `layout-v4.css`. Later files repeatedly redefine the same custom properties and selectors.

| Layer | Intended job | Observed conflict |
| --- | --- | --- |
| `theme.css` | v2 global primitives and generic controls | Owns two theme palettes, glow shadows, status aliases, and base focus; subsequently overwritten. |
| `motion.css` | opt-in motion | Pulses status rings via shadow; reduced motion is present. |
| `app.css` | feature layout/components | Contains raw amber, black, cyan and component gradients; several `!important` overrides. |
| `onboarding.css` | onboarding | Reuses accent glow and gradients; black/white raw colors and independent motion. |
| `redesign.css` | v2 Tailwind layer and restyle | Re-declares nearly every theme token in hex and restyles generic feature selectors. |
| `dark-v3.css` | dark-only visual replacement | Re-declares the dark palette again, adds extensive neon green, glows, gradients, blur, and high-specificity `.theme-dark …` rules. |
| `layout-v4.css` | Signal Deck experiment and a11y patches | Changes information architecture, adds more dark raw colors, and is the only broad home for reduced transparency, increased contrast, and forced colors. |

This is theme drift by construction: a token’s effective value depends on theme, import order, selector specificity, breakpoint, and `!important`. The audit found raw colors in CSS plus QR/camera/image TSX/TS, a data-URI select chevron, `web/index.html` theme-color, and the manifest background. The current browser chrome is permanently `#070a09`, including light mode.

Specificity debt includes `!important` in app notes, redesign metadata/mobile seed layout, layout mobile hit targets and accessibility fallbacks. These are symptoms of layer competition, not documented exceptions.

### Raw-color disposition

All visual feature colors should move to semantic roles. Allowed exceptions must be documented beside the value:

1. QR generation black/white modules: protocol/scan reliability exception; keep isolated in QR code, never theme UI.
2. Camera scan mask black alpha: optical masking exception; expose as `--scrim-camera` if styled by CSS.
3. Raster export white in `imageCompression.ts`: encoded-media behavior, not interface color.
4. Forced-colors system keywords (`Canvas`, `CanvasText`, `ButtonText`, `Highlight`): accessibility primitives, intentionally not palette tokens.
5. Transparent and `currentColor`: compositional values, not palette values.

Everything else—including gradients, shadows, SVG/data-URI stroke `#888`, status dots, preview cyan, inline scanner error red, manifest and theme-color—needs a semantic role or removal.

### Typography, reading, and authorship

- The system font is already the default, but mono is over-applied to navigation metadata, receipts, badges and identity labels. This contributes to the terminal personality. Restrict mono to code, fingerprints/IDs where exact character distinction matters, and tabular technical values.
- Body foundation is 16px/1.5, while message text varies around 0.90–0.92rem and 1.48–1.52 leading. Long-form proposal: 1rem, 1.6 leading, maximum 68ch. Metadata: at least 0.75rem with tested contrast and zoom resilience.
- Headings correctly tighten tracking in several places, but multiple files provide competing sizes. Define a single type scale in `rem`; use `font-optical-sizing: auto`; do not use fixed pixel typography except genuine pixel-bound media.
- Current human/agent authorship leans on bubble color and alignment. Proposed hierarchy uses author name + explicit role label + calm surface/border differences. System messages use a full-width ruled notice. Provenance never depends on avatar hue.

### Borders, shadows, and materials

The current dark layer uses many 14–120px green glows, multiple full-screen radial gradients, 16–30px blur, translucent nested regions and deep 100px shadows. This is expensive on mobile and communicates spectacle rather than predictability. The light layer is quieter but still uses accent halos and ornamental backgrounds.

Proposal: one hairline role, one strong border role, two sparse neutral shadows, and translucency only on actually floating headers/sheets. Never place translucent composer, header, and modal on top of one another. Budget: at most one backdrop-filtered layer per stacking context, blur <= 16px, no animated blur/filter, no ambient glow, and only transform/opacity for motion.

### Status and interaction gaps

| State | Required visual + non-color cue |
| --- | --- |
| Default | Stable label/icon and neutral border. |
| Hover | Tonal surface change; pointer-only enhancement. |
| Pressed | Immediate pointer-down inset/scale response; `aria-pressed` where persistent. |
| Focus-visible | 2px focus ring plus offset, >=3:1 against adjacent colors; never remove for composer. |
| Disabled | Lower prominence plus native/ARIA disabled semantics and unchanged readable label; opacity is not the sole cue. |
| Selected room | Raised surface, leading bar/check, `aria-current`; does not rely on green. |
| Unread | Bold title, count text, and dot; accessible count in name. |
| Pending contact/delivery | Clock icon + “Pending”; never reuse success. |
| Delivered | Double-check icon + “Delivered”. |
| Read | Double-check icon + “Read”, with optional timestamp. |
| Warning | Triangle icon + direct corrective text. |
| Failure/destructive | Error icon + message/retry; muted brick reserved for this meaning. |

Grayscale review must preserve border/weight/icon/text differences. Common color-vision simulation is a screenshot gate, not a substitute for semantic markup.

### Accessibility and responsive findings

Reduced motion exists in several layers and Framer Motion uses the user preference. Reduced transparency, increased contrast, and forced colors exist mainly in late `layout-v4.css`; they therefore patch earlier material decisions rather than being component contracts. `prefers-color-scheme` is not the authority—the application class is—and the static meta theme color disagrees with light mode.

Safe-area and `100dvh` handling exists at mobile breakpoints. Browser tests inspect mobile geometry and `visualViewport`, but production CSS still needs explicit composer behavior when the virtual keyboard changes the viewport. At 200% text zoom, horizontal command modes, fixed 40px controls, 0.55–0.68rem metadata, truncation and hidden action labels are highest risk. Preserve 44 CSS-pixel targets without freezing text containers.

Keyboard/SR contract: landmarks for navigation/main; room list as named list; each room a button/link with current and unread text; messages as a log/list with author/time/status in accessible names; composer has a persistent label; modal uses Radix dialog semantics; live status uses restrained `aria-live`; focus returns to the trigger.

## Proposed token architecture

Primitives are private palette values. Feature code consumes roles only.

```css
/* palette.css: primitives; never referenced by components */
:root {
  --mineral-linen: #F4F1EA; --mineral-paper: #FBFAF7; --mineral-white: #FFFFFF;
  --mineral-group: #EAE7DF; --mineral-line: #D5D4CC;
  --ink-primary: #24302C; --ink-secondary: #65716C; --ink-disabled: #8B938E;
  --eucalyptus-700: #2F6F62; --eucalyptus-800: #285F54; --dusty-blue-700: #496B8D;
}

/* semantic-theme.css: the only theme mapping */
:root {
  --color-canvas: var(--mineral-linen); --color-surface: var(--mineral-paper);
  --color-surface-elevated: var(--mineral-white); --color-surface-subtle: var(--mineral-group);
  --color-text-primary: var(--ink-primary); --color-text-secondary: var(--ink-secondary);
  --color-text-disabled: var(--ink-disabled); --color-border: var(--mineral-line);
  --color-action-primary: var(--eucalyptus-700); --color-action-primary-hover: var(--eucalyptus-800);
  --color-focus: var(--eucalyptus-700); --color-info: var(--dusty-blue-700);
  --color-success: #3F7D63; --color-success-background: #E5EEE9; --color-success-border: #9BB8A8;
  --color-warning: #8A5D18; --color-warning-background: #F4EAD8; --color-warning-border: #C7A776;
  --color-error: #A34F45; --color-error-background: #F4E4E1; --color-error-border: #CA9B95;
  --color-info-background: #E5EBF0; --color-info-border: #9FB1C2;
}
```

Required role families: canvas/surface/elevated/subtle; primary/secondary/disabled/inverse text; border/subtle/strong; action primary/hover/pressed/on-action; focus; selection background/border/indicator; provenance human/agent/system surfaces and borders; success/warning/error/info foreground/background/border; scrim; code surface/text/border; floating material/solid fallback; shadows; motion response/easing. Component-local aliases may reference roles but never primitives.

Dark mapping: canvas `#151A18`, surface `#1D2421`, elevated `#26302C`, subtle `#202824`, border `#36423D`, primary `#E8ECE8`, secondary `#A6B0AA`, disabled `#758079`, action `#79B7A4`, on-action `#10201B`, info `#91AAC5`. Dark status families are success `#86C8A7` / `#23372F` / `#4F7868`, warning `#D7AA62` / `#382F20` / `#806B45`, error `#E29A91` / `#3B2927` / `#80514C`, and info background/border `#28323D` / `#536B83`. Light semantic foregrounds tune dusty blue to `#496B8D`, warning to `#8A5D18`, and retain `#3F7D63` success and `#A34F45` error for AA. Order for each status triple is foreground/background/border.

## Contrast report (sRGB, WCAG 2.x formula)

| Use | Foreground / background | Ratio | Result |
| --- | --- | ---: | --- |
| Light long-form | `#24302C` / `#FBFAF7` | 13.11 | AAA |
| Light secondary | `#65716C` / `#FBFAF7` | 4.87 | AA normal |
| Light disabled | `#8B938E` / `#FBFAF7` | 3.02 | Exempt when truly disabled; not acceptable for active metadata |
| Light action label | `#FFFFFF` / `#2F6F62` | 5.88 | AA normal |
| Light focus / canvas | `#2F6F62` / `#F4F1EA` | 5.21 | >=3:1 non-text |
| Light info/success/warning/error | role / `#FBFAF7` | 5.34 / 4.65 / 5.50 / 5.35 | AA normal |
| Dark long-form | `#E8ECE8` / `#1D2421` | 13.26 | AAA |
| Dark secondary | `#A6B0AA` / `#1D2421` | 7.10 | AAA |
| Dark disabled | `#758079` / `#1D2421` | 3.86 | Exempt when truly disabled; not active metadata |
| Dark action label | `#10201B` / `#79B7A4` | 7.33 | AAA |
| Dark focus / canvas | `#79B7A4` / `#151A18` | 7.65 | >=3:1 non-text |
| Dark info/success/warning/error | role / `#1D2421` | 6.60 / 8.17 / 7.40 / 6.98 | AA/AAA |

Alpha surfaces must be tested after compositing in-browser. Borders, controls, icons, status chips and focus indicators require >=3:1 against adjacent colors. Disabled controls are contrast-exempt, but readable disabled labels remain a product goal and cannot carry operational status.

## Apple-design reasoning

- Safety/predictability: stable semantic meanings, explicit provenance and delivery words, symmetric modal/sheet paths, persistent focus and no decorative state color.
- Understanding: neutral hierarchy, 68ch reading measure, nearby metadata, direct labels, familiar room/conversation/composer topology.
- Achievement: instant press feedback, visible pending/completion/error, preserved operational density and no transition lockout.
- Joy: comes from quiet craft—comfortable type, precise spacing and responsive feedback—not glow, confetti or bounce.
- Restraint: one accent action, sparse shadows, no ambient gradients, mono only where character precision matters.
- Materials: translucency denotes only floating chrome; one layer maximum with a solid reduced-transparency fallback.
- Accessibility: independent motion/transparency/contrast policies, forced-color system roles, text zoom and non-color states.
- Motion: critically damped 0.3–0.4s for spatial UI; 100–160ms press feedback; no decorative bounce. Reduced motion swaps movement for short opacity/tonal feedback.

## Implementation and regression sequence

1. Capture existing desktop/mobile light/dark baselines for the real room-envelope, message lists, markdown, receipt, file, composer, modal, media, empty/loading/error and onboarding fixtures.
2. Add palette + semantic theme sheets and a browser-level token/contrast contract. Update browser theme-color dynamically.
3. Migrate one vertical slice (shell, room list, conversation, composer) and delete superseded selectors in the same change; do not add an eighth override sheet.
4. Migrate dialogs/onboarding/media/QR exceptions, then remove old palette/glow/raw colors.
5. Add Playwright screenshot matrix: 1440x1000 and 390x844; light/dark; contrast more; reduced transparency; reduced motion; forced colors (semantic assertions); 200% zoom; long content; all states. Run grayscale and common color-vision image review.
6. Real-context review: at least 60 minutes of dense message/code reading on desktop and a mobile keyboard/rotation pass. Record comprehension, fatigue, truncation, scroll stability and missed-status observations.

Existing relevant gates: `browser-accessibility-preferences`, `browser-accessibility-controls`, `browser-typography-foundation`, `browser-motion-material`, `browser-mobile-layout-webkit`, `browser-room-envelope-matrix`, `browser-message-markdown`, `browser-mermaid-theme`, `browser-receipt-render`, `browser-file-bubble-layout`, `browser-composer-focus`, `browser-pointer-touch`, and `browser-scroll-stability`. They are behavioral/assertion coverage, not a complete screenshot baseline inventory; no checked-in baseline image set was found.

## Phase-one exit checklist

- [x] Inventory and cascade documented.
- [x] Raw-color exception policy documented.
- [x] Semantic token roles and contrast pairs proposed.
- [x] Apple principles and accessibility preferences addressed.
- [x] Production-shaped interactive comparison provided.
- [x] Authenticated Owner authorization received for whole-application implementation after phase-one sign-off.
- [ ] Critic review and joint sign-off.
- [ ] Merge, publish, deploy, and live-service restart remain separately unauthorized.
# Functional raw-color exception ledger

- `web/src/ui/htmlPreviewCore.mjs`, `BASE_STYLE`: `html{background:#fff}` and the
  `body` declaration's `color:#0f172a` are the isolated hostile-document paper
  and ink defaults. Application CSS variables cannot cross the opaque sandbox
  boundary. The values are file/property/context-bound, provide enhanced text
  contrast, and are verified by `tests/html-preview.test.mjs`; they are not a
  general component-color allowlist.
- `web/src/ui/QRDisplay.tsx`, `QRCode.toCanvas(...).color`: `dark: '#000000'`
  and `light: '#ffffff'` are protocol pixels, not interface presentation. The
  exception is bound to the encoder call and its four-module quiet zone; the
  production capture gate decodes the rendered canvas back to the exact invite.
- `web/src/theme.css`, `--color-media-void: #000000`: optical media black is a
  primitive consumed only by `.qr-scanner-viewport`; scanner component source
  has no raw presentation value.
- `web/src/ui/imageCompression.ts`, `compressImageForSend`,
  `context.fillStyle = '#fff'`: this is the output-data matte applied before
  JPEG encoding because JPEG cannot preserve alpha. It is not a feature/UI
  allowlist. `tests/browser-image-compression.test.mjs` runs the production
  compressor and proves transparent input becomes white while opaque color is
  retained.
