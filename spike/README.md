# Vox Accuracy Spike

Measure whisper-large-v3-french accuracy on Swiss French medical dictation.
Build a correction dictionary and measure improvement.

## Quick Start

```bash
# 1. Install dependencies
./setup.sh

# 2. Copy voice memos to data/audio/
cp ~/voice-memos/*.m4a data/audio/

# 3. Run the full pipeline
./run.sh
```

The pipeline will:
1. Convert audio to 16kHz mono WAV
2. Transcribe with whisper.cpp (using medical vocabulary prompt)
3. Ask you to verify/correct each transcription (ground truth annotation)
4. Apply the correction dictionary
5. Calculate WER (overall + medical-term-specific)
6. Generate a markdown report at `data/reports/latest.md`

## Individual Scripts

```bash
# Convert audio files
python3 audio.py data/audio/

# Transcribe (with medical prompt)
python3 transcribe.py --all --prompt

# Annotate ground truth interactively
python3 annotate.py --all

# Apply corrections
python3 correct.py --all

# Evaluate accuracy
python3 evaluate.py --both

# Generate report
python3 report.py

# Test medical term extraction
python3 extract_terms.py "Patient traite par metformine 500 mg"
```

## Building the Correction Dictionary

After the first evaluation, check `data/reports/latest.md` for common errors.
Add corrections to `corrections.json`:

```json
[
  {
    "pattern": "met formine",
    "correction": "metformine",
    "context": ["prescription", "diabete"],
    "edit_distance": 1
  }
]
```

Then re-run: `python3 correct.py --all && python3 evaluate.py --both && python3 report.py`

## Files

| File | Purpose |
|------|---------|
| `setup.sh` | Install whisper-cpp, ffmpeg, Python deps |
| `run.sh` | Full pipeline |
| `config.py` | Shared paths and settings |
| `audio.py` | Convert audio to 16kHz mono WAV |
| `transcribe.py` | Run whisper.cpp, save JSON |
| `annotate.py` | Interactive ground truth annotation |
| `extract_terms.py` | Tag medical terms in text |
| `evaluate.py` | WER calculation (overall + medical) |
| `correct.py` | Apply correction dictionary |
| `report.py` | Generate markdown report |
| `corrections.json` | Correction dictionary (you build this) |
| `medical_terms.json` | Known medical vocabulary |
| `prompt.txt` | Whisper decoder bias prompt |
