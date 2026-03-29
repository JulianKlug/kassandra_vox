# TODOS

## P2 - Export formats (Markdown + PDF)
- **What:** Add export to Markdown (with voice command section headings) and PDF (formatted clinical note) from the desktop receiver
- **Why:** Doctors need to paste dictations into EMR systems or share with colleagues
- **Effort:** S (human: ~2 days / CC: ~30 min)
- **Depends on:** Voice commands working (section headings come from voice commands)
- **Context:** Deferred from CEO review 2026-03-29. Doctors currently copy-paste from desktop receiver. This adds structured export with formatting preserved.

## P2 - Multi-language model switching (FR/DE/IT)
- **What:** Language selector in app. Each mode loads appropriate Whisper model variant and medical vocabulary pack.
- **Why:** Switzerland has 4 official languages. Doctors near the language border switch between FR/DE.
- **Effort:** M (human: ~1 week / CC: ~1-2 hours)
- **Depends on:** French MVP proven with real doctors
- **Context:** Architecture already supports modular models and vocabulary packs. Main work is curating German/Italian medical vocabulary. Deferred from CEO review 2026-03-29.

## P3 - SQLCipher encryption for local session history
- **What:** Encrypt SQLite database with SQLCipher, locked to device biometrics
- **Why:** Defense in depth if phone is stolen and lock screen bypassed
- **Effort:** S (human: ~2 days / CC: ~30 min)
- **Depends on:** Session history working
- **Context:** Security gap flagged in CEO review Section 3. Phone lock screen is the primary defense for MVP. Deferred from CEO review 2026-03-29.
