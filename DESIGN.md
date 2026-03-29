# Design System — Vox

## Product Context
- **What this is:** Privacy-preserving medical dictation tool. Doctor speaks into phone, text appears on desktop, nothing leaves the device.
- **Who it's for:** Swiss French-speaking doctors in private practices
- **Space/industry:** Medical dictation, competing with Dragon Medical, generic phone dictation
- **Project type:** Mobile app (Expo/React Native) + desktop web receiver (vanilla JS SPA)

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian
- **Decoration level:** Minimal — typography does all the work
- **Mood:** The calm confidence of a stethoscope. Professional, trustworthy, invisible. The doctor should forget they're using an app and just see their words appearing on screen. No decoration, no personality, no brand voice competing with the clinical text.
- **Design risks taken:**
  - Zero chrome: one button, no heavy nav bars. The transcript IS the interface.
  - No onboarding: download screen with privacy message, then dictation. Self-evident product.

## Typography
- **Display/Hero:** System font, 700 weight — San Francisco (iOS), Roboto (Android), system-ui (web)
- **Body:** System font, 400 weight, 16px/1.6 — optimized for reading French medical text
- **Section headings:** System font, 700 weight, 14px, uppercase, 0.5px letter-spacing, #636366
- **Desktop document body:** Charter or Georgia (serif) — better readability for long clinical text. Fall back to system serif.
- **UI/Labels:** System font, 400 weight, 12-13px
- **Data/Tables:** System font with font-variant-numeric: tabular-nums
- **Code:** Not applicable (no code in this product)
- **Loading:** No external fonts to load. Zero latency, zero layout shift.
- **Scale:**
  - xs: 11px (timestamps, badges)
  - sm: 12px (labels, connection status, specialty pill)
  - base: 13px (UI text, buttons)
  - md: 14px (section headings)
  - lg: 16px (body text, transcript)
  - xl: 20px (app title)

## Color
- **Approach:** Restrained — one accent + neutrals. Color is rare and meaningful.
- **Primary:** #0a7e8c (teal) — medical trust, calm, not corporate blue. Record button, active states, links, cursor.
- **Recording:** #ff3b30 (iOS system red) — unmistakable "I'm listening." Record button when active, pulse glow.
- **Success:** #34c759 (iOS system green) — connected, ready. Connection dot.
- **Warning/Correction:** #fff3cd (warm yellow background) — suggested corrections highlight. Non-alarming.
- **Error:** #ff3b30 (same red) — error messages, disconnected state.
- **Neutrals (warm grays):**
  - Background: #fafafa (phone), #ffffff (desktop, control surfaces)
  - Surface: #f2f2f7 (pills, badges, specialty selector background)
  - Border: #e5e5e5 (dividers, input borders)
  - Muted text: #8e8e93 (timestamps, labels, secondary info)
  - Secondary text: #636366 (section headings, less important body text)
  - Primary text: #1a1a1a (body text, transcript)
- **Dark mode:** Deferred. Not in MVP scope. Strategy when implemented: invert surfaces (#1c1c1e background, #ffffff text), reduce accent saturation 15%, keep recording red at full saturation.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable — not cramped, not wasteful. Medical text needs breathing room.
- **Scale:**
  - 2xs: 2px (micro-adjustments)
  - xs: 4px (tight gaps)
  - sm: 8px (between related elements)
  - md: 12px (standard gap)
  - base: 16px (section padding, paragraph spacing)
  - lg: 20px (page margins on phone)
  - xl: 24px (section separators)
  - 2xl: 32px (major sections)
  - 3xl: 40px (page margins on desktop)
  - 4xl: 48px (large vertical spacing)
  - 5xl: 64px (hero-level spacing)

## Layout
- **Approach:** Grid-disciplined — strict alignment, predictable structure
- **Phone:** Single column. Bottom-anchored controls (record button). Scrollable transcript above.
  - Content margins: 20px left/right
  - Record button: 72px circle, centered, 160px from bottom (includes safe area)
- **Desktop:** Centered document, max-width 720px, generous margins
  - Header: full-width, 40px horizontal padding
  - Document area: centered, 40px padding
- **Tablet:** Same as phone layout (doctors don't use tablets for dictation)
- **Border radius:**
  - sm: 3px (correction highlights, inline elements)
  - md: 6px (buttons, inputs, cards)
  - lg: 12px (pills, badges, specialty selector)
  - full: 9999px (record button, connection dot, circular elements)

## Motion
- **Approach:** Minimal-functional — only motion that aids comprehension or signals state
- **Easing:** ease (all transitions)
- **Duration:**
  - Micro: 100ms (hover states, active press)
  - Short: 200ms (state transitions, color changes)
  - Medium: 300ms (bottom sheet open/close, corrections panel)
- **Specific animations:**
  - Record button pulse: 2s infinite, box-shadow expanding from 0 to 12px, rgba(255,59,48,0.4) fading to transparent
  - Cursor blink: 1s infinite, opacity 0/1 step function at 50%
  - Text appearance: no animation. Text appears instantly. Doctors need to read it, not watch it fly in.
  - Reduced motion: respect prefers-reduced-motion. Disable pulse, keep cursor blink (functional).

## Accessibility
- **Touch targets:** 44px minimum on all interactive elements
- **Color contrast:** All text/background combinations exceed WCAG AA (4.5:1)
  - #1a1a1a on #fafafa = 15.4:1
  - #636366 on #fafafa = 5.7:1
  - #8e8e93 on #fafafa = 3.9:1 (decorative labels only, not actionable text)
- **Keyboard navigation:** Tab through all interactive elements. Enter to activate. Escape to dismiss sheets/popovers.
- **Screen readers:**
  - Record button: aria-label="Commencer la dictee" / "Arreter la dictee"
  - Connection status: aria-live="polite"
  - Transcript area: role="log" aria-live="polite"
  - Corrections: role="button" aria-label="Corriger: [word]"
- **ARIA landmarks:** header, main (transcript), complementary (controls), navigation (tab bar)

## Component Patterns
- **Record button:** 72px teal circle (stopped) / red circle with pulse (recording). Inner shape: square with 4px radius (stopped) / circle (recording). This visual change makes recording state unmistakable even in peripheral vision.
- **Connection indicator:** 8px dot (green=connected, gray=offline) + 11px label text
- **Specialty badge:** 12px text in #f2f2f7 pill with 12px border-radius
- **Section headings:** 14px uppercase, 0.5px letter-spacing, #636366. Used for voice command sections (ANAMNESE, EXAMEN CLINIQUE, PRESCRIPTION).
- **Correction highlight:** #fff3cd background, 3px border-radius. Tap/click to open correction bottom sheet (phone) or popover (desktop).
- **Bottom sheet (phone corrections):** Slides up 300ms. Contains: original word, correction input, "Ajouter au vocabulaire" checkbox, Confirmer/Annuler buttons.
- **Popover (desktop corrections):** Appears near the word. Same content as bottom sheet. 6px border-radius, 1px #e5e5e5 border, subtle shadow (0 2px 8px rgba(0,0,0,0.08)).
- **Empty states:** Centered icon (muted, 48px) + message in #636366 + primary action button. Example: session history empty = microphone icon + "Commencez votre premiere dictee" + teal "Dicter" button.
- **Error states:** #ff3b30 text + retry action. Never a full-screen error. Errors are inline, near the thing that failed.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-29 | Initial design system | Created by /design-consultation. Industrial/utilitarian aesthetic for medical professionals. System fonts, teal accent, minimal decoration. Informed by /office-hours, /plan-ceo-review, /plan-eng-review, and /plan-design-review sessions. |
| 2026-03-29 | Zero chrome risk | Deliberate departure from medical app category norms. One button, no heavy nav. The transcript is the interface. |
| 2026-03-29 | No onboarding risk | Trust-first download screen replaces tutorial carousel. Product should be self-evident. |
| 2026-03-29 | System fonts over custom | Zero load time, native feel on every platform. Doctors should forget they're using an app. Charter/Georgia serif for desktop document body only. |
