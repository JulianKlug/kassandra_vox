"""Shared configuration for the Vox accuracy spike."""

from pathlib import Path

SPIKE_DIR = Path(__file__).parent
DATA_DIR = SPIKE_DIR / "data"
AUDIO_DIR = DATA_DIR / "audio"
CONVERTED_DIR = DATA_DIR / "converted"
TRANSCRIPTIONS_DIR = DATA_DIR / "transcriptions"
GROUND_TRUTH_DIR = DATA_DIR / "ground_truth"
CORRECTED_DIR = DATA_DIR / "corrected"
REPORTS_DIR = DATA_DIR / "reports"

# Whisper configuration
WHISPER_CMD = "whisper-cli"  # Homebrew whisper-cpp installs as whisper-cli
WHISPER_MODEL = "large-v3"
WHISPER_LANGUAGE = "fr"
PROMPT_FILE = SPIKE_DIR / "prompt.txt"

# Correction and vocabulary files
CORRECTIONS_FILE = SPIKE_DIR / "corrections.json"
MEDICAL_TERMS_FILE = SPIKE_DIR / "medical_terms.json"

# Audio conversion
SAMPLE_RATE = 16000
CHANNELS = 1
