# Vox — Privacy-Preserving Medical Dictation

## What This Is
Mobile app (Expo + React Native) for Swiss French-speaking doctors to dictate clinical notes. Speech-to-text runs entirely on-device via whisper.rn. Transcribed text streams to a desktop web receiver via E2E encrypted WebSocket relay. No audio or text ever leaves the doctor's control.

## Stack
- **Phone:** Expo + whisper.rn + expo-sqlite + tweetnacl-js
- **Relay:** Node.js + ws on Fly.io (stateless, in-memory rooms, rate limited)
- **Desktop:** Vanilla JS SPA, no build step, no framework

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Key Architecture Decisions
- Post-processor pipeline order: medical correct -> overlap dedup -> punctuate -> voice commands
- 5-second audio chunks with 1.5s overlap
- RAM-based model selection at startup (not OOM catch): <3GB = whisper-medium-french
- HTTP long-polling fallback for corporate proxies
- Bidirectional corrections with last-write-wins timestamps
- SQLite session history on phone (100 sessions, ON DELETE CASCADE)

## Testing
- Jest for unit tests, RNTL for components, Maestro for mobile E2E
- Vitest for relay server, Playwright for desktop
- 42 planned test paths across all systems
