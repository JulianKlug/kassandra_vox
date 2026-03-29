# Recording Guide

## What You Need
- 10 voice memos, 1-2 minutes each
- Recorded on your phone (Voice Memos on iPhone, Recorder on Android)
- Swiss French, natural dictation pace

## What to Record

Simulate real clinical notes. Don't read from a script if possible.

| # | Type | Example Content |
|---|------|-----------------|
| 1-3 | General practice | Routine checkup, common complaints, vitals |
| 4-5 | Specialty-focused | Endocrinology, cardiology, your doctors' specialties |
| 6-8 | Drug-heavy | Prescriptions with drug names, dosages, frequencies |
| 9-10 | Lab values | HbA1c, INR, mmHg, blood work results, abbreviations |

## How to Record

- **Natural pace.** The way a doctor actually dictates, not slow and careful.
- **Mix environments.** Some quiet, some with typical office background noise.
- **Use Swiss French.** Septante, nonante, local expressions if natural.
- **Include section markers.** Say "anamnese", "examen clinique", "prescription" as you would in practice.
- **Include edge cases.** Long drug names (amoxicilline, hydrochlorothiazide), compound numbers (138/82), decimal values (7.2%).

## Transfer

Copy files to `spike/data/audio/`. Any format works (M4A, MP3, WAV).

```bash
# AirDrop or cable transfer, then:
cp ~/Downloads/*.m4a spike/data/audio/
```

## If a Real Doctor Can Record

Even 3-4 memos from an actual doctor are worth more than 10 from you. Their speech patterns, pace, and vocabulary are what the model needs to handle. Fill the rest yourself.
