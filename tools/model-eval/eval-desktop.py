#!/usr/bin/env python3
"""
Desktop model evaluation using sherpa-onnx Python bindings.

Tests a model against ground truth WAV files locally (no phone needed).
Catches compatibility issues fast, measures accuracy before device deploy.

Usage:
  # Install deps:
  pip install sherpa-onnx jiwer

  # Evaluate an offline (non-streaming) model:
  python tools/model-eval/eval-desktop.py \
    --model-dir /path/to/nemo-ctc-fr \
    --model-type nemo_ctc \
    --model-id nemo-ctc-fr-int8

  # Evaluate a streaming model:
  python tools/model-eval/eval-desktop.py \
    --model-dir /path/to/zipformer-fr \
    --model-type transducer \
    --streaming \
    --model-id zipformer-fr-2023-mobile

  # Download a sherpa-onnx model by ID first:
  python tools/model-eval/eval-desktop.py \
    --sherpa-id sherpa-onnx-nemo-fast-conformer-ctc-en-de-es-fr-14288-int8 \
    --model-type nemo_ctc \
    --model-id nemo-ctc-fr-int8
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
GROUND_TRUTH_DIR = REPO_ROOT / "spike" / "data" / "ground_truth"
AUDIO_DIR = REPO_ROOT / "spike" / "data" / "converted"
REGISTRY_PATH = SCRIPT_DIR / "registry.json"
RESULTS_DOC = REPO_ROOT / "docs" / "MODEL_EVAL_RESULTS.md"

# Prose recordings (for prose-only WER)
PROSE_IDS = {
    "Voice 260331_225712",
    "Voice 260331_225748",
    "Voice 260331_225822",
    "Voice 260331_230119",
    "Voice 260403_224258",
    "Voice 260403_224558",
}


def load_ground_truth():
    """Load all ground truth files."""
    pairs = []
    for gt_file in sorted(GROUND_TRUTH_DIR.glob("*.json")):
        with open(gt_file) as f:
            data = json.load(f)
        audio_path = AUDIO_DIR / f"{gt_file.stem}.wav"
        if not audio_path.exists():
            print(f"  SKIP {gt_file.stem}: audio file missing")
            continue
        pairs.append({
            "id": gt_file.stem,
            "type": "prose" if gt_file.stem in PROSE_IDS else "structured",
            "audio": str(audio_path),
            "reference": data["reference"],
        })
    return pairs


def create_offline_recognizer(model_dir, model_type, num_threads=4):
    """Create a sherpa-onnx offline recognizer."""
    import sherpa_onnx

    model_dir = Path(model_dir)

    if model_type == "nemo_ctc":
        # NeMo CTC model: model.int8.onnx + tokens.txt
        model_file = model_dir / "model.int8.onnx"
        if not model_file.exists():
            model_file = model_dir / "model.onnx"
        recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
            model=str(model_file),
            tokens=str(model_dir / "tokens.txt"),
            num_threads=num_threads,
        )
    elif model_type == "whisper":
        encoder = model_dir / "encoder.int8.onnx"
        if not encoder.exists():
            encoder = model_dir / "encoder.onnx"
        decoder = model_dir / "decoder.int8.onnx"
        if not decoder.exists():
            decoder = model_dir / "decoder.onnx"
        recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=str(encoder),
            decoder=str(decoder),
            tokens=str(model_dir / "tokens.txt"),
            num_threads=num_threads,
            language="fr",
            task="transcribe",
        )
    elif model_type == "transducer":
        recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(model_dir / "encoder.onnx"),
            decoder=str(model_dir / "decoder.onnx"),
            joiner=str(model_dir / "joiner.onnx"),
            tokens=str(model_dir / "tokens.txt"),
            num_threads=num_threads,
        )
    elif model_type == "nemo_transducer":
        recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_transducer(
            encoder=str(model_dir / "encoder.onnx"),
            decoder=str(model_dir / "decoder.onnx"),
            joiner=str(model_dir / "joiner.onnx"),
            tokens=str(model_dir / "tokens.txt"),
            num_threads=num_threads,
        )
    else:
        print(f"Unknown model type: {model_type}")
        sys.exit(1)

    return recognizer


def create_streaming_recognizer(model_dir, model_type, num_threads=4):
    """Create a sherpa-onnx online (streaming) recognizer."""
    import sherpa_onnx

    model_dir = Path(model_dir)

    if model_type == "transducer":
        recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            encoder=str(model_dir / "encoder.onnx"),
            decoder=str(model_dir / "decoder.onnx"),
            joiner=str(model_dir / "joiner.onnx"),
            tokens=str(model_dir / "tokens.txt"),
            num_threads=num_threads,
        )
    else:
        print(f"Streaming not supported for model type: {model_type}")
        sys.exit(1)

    return recognizer


def transcribe_offline(recognizer, audio_path):
    """Transcribe a WAV file with an offline recognizer."""
    import sherpa_onnx
    import wave

    with wave.open(audio_path, "rb") as wf:
        assert wf.getnchannels() == 1, f"Expected mono, got {wf.getnchannels()} channels"
        assert wf.getsampwidth() == 2, f"Expected 16-bit, got {wf.getsampwidth()*8}-bit"
        sample_rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())

    import struct
    samples = struct.unpack(f"<{len(frames)//2}h", frames)
    samples = [s / 32768.0 for s in samples]

    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)

    recognizer.decode_stream(stream)
    return stream.result.text


def transcribe_streaming(recognizer, audio_path, chunk_duration_s=0.5):
    """Transcribe a WAV file by feeding chunks to a streaming recognizer."""
    import wave
    import struct

    with wave.open(audio_path, "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        sample_rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())

    all_samples = struct.unpack(f"<{len(frames)//2}h", frames)
    all_samples = [s / 32768.0 for s in all_samples]

    chunk_size = int(sample_rate * chunk_duration_s)
    stream = recognizer.create_stream()

    for i in range(0, len(all_samples), chunk_size):
        chunk = all_samples[i:i + chunk_size]
        stream.accept_waveform(sample_rate, chunk)

        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)

    # Signal end of audio
    tail_paddings = [0.0] * int(sample_rate * 0.5)
    stream.accept_waveform(sample_rate, tail_paddings)

    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)

    return stream.result.text


def compute_wer(reference, hypothesis):
    """Compute WER using jiwer."""
    from jiwer import wer as jiwer_wer, process_words

    ref_clean = reference.lower().strip()
    hyp_clean = hypothesis.lower().strip()

    if not ref_clean:
        return {"wer": 0.0 if not hyp_clean else 1.0, "ref_words": 0}
    if not hyp_clean:
        return {"wer": 1.0, "ref_words": len(ref_clean.split())}

    w = jiwer_wer(ref_clean, hyp_clean)
    return {"wer": w, "ref_words": len(ref_clean.split())}


def run_evaluation(recognizer, pairs, is_streaming=False):
    """Run evaluation on all audio/ground truth pairs."""
    results = []

    for pair in pairs:
        file_id = pair["id"]
        print(f"  Processing: {file_id}...", end="", flush=True)

        try:
            start = time.time()
            if is_streaming:
                text = transcribe_streaming(recognizer, pair["audio"])
            else:
                text = transcribe_offline(recognizer, pair["audio"])
            inference_ms = int((time.time() - start) * 1000)

            wer_result = compute_wer(pair["reference"], text)

            result = {
                "id": file_id,
                "type": pair["type"],
                "inference_ms": inference_ms,
                "wer_raw": round(wer_result["wer"], 3),
                "text": text[:200],
            }
            results.append(result)
            print(f" {inference_ms}ms, WER={wer_result['wer']:.1%}, text=\"{text[:60]}\"")

        except Exception as e:
            print(f" ERROR: {e}")
            results.append({
                "id": file_id,
                "type": pair["type"],
                "error": str(e),
            })

    # Aggregate
    successful = [r for r in results if "error" not in r]
    prose_successful = [r for r in successful if r["type"] == "prose"]

    if not successful:
        return {"results": results, "aggregate": None}

    avg_inference = sum(r["inference_ms"] for r in successful) / len(successful)

    # Corpus-level WER (re-compute from raw text against references)
    total_wer_num = sum(r["wer_raw"] * len([p for p in pairs if p["id"] == r["id"]][0]["reference"].split()) for r in successful)
    total_ref_words = sum(len([p for p in pairs if p["id"] == r["id"]][0]["reference"].split()) for r in successful)
    overall_wer = total_wer_num / total_ref_words if total_ref_words > 0 else 0

    prose_wer_num = sum(r["wer_raw"] * len([p for p in pairs if p["id"] == r["id"]][0]["reference"].split()) for r in prose_successful)
    prose_ref_words = sum(len([p for p in pairs if p["id"] == r["id"]][0]["reference"].split()) for r in prose_successful)
    prose_wer = prose_wer_num / prose_ref_words if prose_ref_words > 0 else 0

    return {
        "results": results,
        "aggregate": {
            "files_total": len(pairs),
            "files_success": len(successful),
            "avg_inference_ms": int(avg_inference),
            "overall_wer_raw": round(overall_wer, 3),
            "prose_wer_raw": round(prose_wer, 3),
        }
    }


def update_registry(model_id, tier, device, eval_data):
    """Update the registry.json with new results."""
    with open(REGISTRY_PATH) as f:
        registry = json.load(f)

    if model_id not in registry["models"]:
        print(f"WARNING: {model_id} not in registry, adding stub entry")
        registry["models"][model_id] = {
            "name": model_id,
            "type": "unknown",
            "results": {},
        }

    from datetime import date
    today = date.today().isoformat()
    key = f"{tier}-{today}"

    result_entry = {
        "tier": tier,
        "date": today,
        "device": device,
        **eval_data["aggregate"],
        "per_file": [{k: v for k, v in r.items() if k != "text"} for r in eval_data["results"]],
    }

    registry["models"][model_id]["results"][key] = result_entry

    with open(REGISTRY_PATH, "w") as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)

    print(f"\nRegistry updated: {REGISTRY_PATH}")


def generate_results_doc():
    """Generate MODEL_EVAL_RESULTS.md from registry.json."""
    with open(REGISTRY_PATH) as f:
        registry = json.load(f)

    lines = [
        "# Model Evaluation Results",
        "",
        "> Auto-generated from `tools/model-eval/registry.json`.",
        "> Do not edit manually. Re-generate with `python tools/model-eval/eval-desktop.py --update-docs`.",
        "",
        "## Current Best",
        "",
        f"- **Streaming:** `{registry['current_best']['streaming']}`",
        f"- **Offline:** `{registry['current_best']['offline']}`",
        "",
        "## Baselines",
        "",
        "| Name | Device | Prose WER (raw) | Prose WER (corrected) |",
        "|------|--------|-----------------|----------------------|",
    ]

    for _, b in registry.get("baselines", {}).items():
        lines.append(
            f"| {b['name']} | {b['device']} | {b.get('prose_wer_raw', 'N/A'):.1%} | {b.get('prose_wer_corrected', 'N/A'):.1%} |"
            if isinstance(b.get('prose_wer_raw'), (int, float))
            else f"| {b['name']} | {b['device']} | N/A | N/A |"
        )

    lines.extend(["", "## Models", ""])

    for model_id, model in registry["models"].items():
        status = "BLOCKED" if any("CRASHED" in str(r.get("status", "")) or "CRASHED" in str(r.get("error", "")) for r in model.get("results", {}).values()) else "OK"
        lines.append(f"### {model['name']} (`{model_id}`)")
        lines.append("")
        lines.append(f"- **Type:** {model.get('type', '?')} | **Size:** {model.get('size_mb', '?')} MB | **Languages:** {', '.join(model.get('languages', ['?']))}")
        if model.get("notes"):
            lines.append(f"- **Notes:** {model['notes']}")
        lines.append("")

        results = model.get("results", {})
        if not results:
            lines.append("_No evaluation results yet._")
            lines.append("")
            continue

        lines.append("| Tier | Date | Device | Files | Avg Inference | Overall WER | Prose WER | Status |")
        lines.append("|------|------|--------|-------|---------------|-------------|-----------|--------|")

        for key, r in sorted(results.items()):
            tier = r.get("tier", "?")
            date = r.get("date", "?")
            device = r.get("device", "?")
            files = f"{r.get('files_success', '?')}/{r.get('files_total', '?')}"
            avg_inf = f"{r['avg_inference_ms']}ms" if "avg_inference_ms" in r else "—"
            overall = f"{r['overall_wer_raw']:.1%}" if "overall_wer_raw" in r else "—"
            prose = f"{r['prose_wer_raw']:.1%}" if "prose_wer_raw" in r else "—"
            corrected = f" ({r['prose_wer_corrected']:.1%} corrected)" if "prose_wer_corrected" in r else ""
            status = r.get("status", "PASS")
            if r.get("error"):
                status = "CRASHED"
                overall = "—"
                prose = "—"
                avg_inf = "—"
                files = "—"

            lines.append(f"| {tier} | {date} | {device} | {files} | {avg_inf} | {overall} | {prose}{corrected} | {status} |")

        lines.append("")

    lines.extend([
        "## Evaluation Pipeline",
        "",
        "```bash",
        "# 1. Desktop eval (fast, catches compatibility issues)",
        "python tools/model-eval/eval-desktop.py \\",
        "  --model-dir /path/to/model --model-type nemo_ctc --model-id my-model",
        "",
        "# 2. Push model + test data to emulator, run in-app benchmark",
        "adb push /path/to/model /data/local/tmp/model-name",
        "adb push spike/data/converted/ /data/local/tmp/vox-test/audio/",
        "adb push spike/data/ground_truth/ /data/local/tmp/vox-test/ground-truth/",
        "# Then launch app in test mode",
        "",
        "# 3. Push to real phone, same as emulator",
        "# Results logged via logcat, add to registry manually or via --update-registry",
        "",
        "# Re-generate this doc after adding results:",
        "python tools/model-eval/eval-desktop.py --update-docs",
        "```",
        "",
    ])

    RESULTS_DOC.parent.mkdir(parents=True, exist_ok=True)
    with open(RESULTS_DOC, "w") as f:
        f.write("\n".join(lines))

    print(f"Results doc updated: {RESULTS_DOC}")


def main():
    parser = argparse.ArgumentParser(description="Desktop model evaluation for Vox STT")
    parser.add_argument("--model-dir", help="Path to model directory")
    parser.add_argument("--model-type", choices=["nemo_ctc", "whisper", "transducer", "nemo_transducer"],
                        help="Model type for sherpa-onnx")
    parser.add_argument("--model-id", help="Model ID for registry (e.g., nemo-ctc-fr-int8)")
    parser.add_argument("--streaming", action="store_true", help="Evaluate as streaming model")
    parser.add_argument("--num-threads", type=int, default=4, help="Number of inference threads")
    parser.add_argument("--update-docs", action="store_true", help="Regenerate MODEL_EVAL_RESULTS.md from registry")
    parser.add_argument("--update-registry", action="store_true", default=True,
                        help="Save results to registry.json (default: true)")
    parser.add_argument("--no-update-registry", action="store_false", dest="update_registry")
    args = parser.parse_args()

    if args.update_docs:
        generate_results_doc()
        if not args.model_dir:
            return

    if not args.model_dir:
        parser.error("--model-dir is required (or use --update-docs alone)")

    if not args.model_type:
        parser.error("--model-type is required")

    model_dir = Path(args.model_dir)
    if not model_dir.exists():
        print(f"ERROR: Model directory not found: {model_dir}")
        sys.exit(1)

    # Verify test data exists
    if not GROUND_TRUTH_DIR.exists() or not AUDIO_DIR.exists():
        print(f"ERROR: Test data not found at {GROUND_TRUTH_DIR} and {AUDIO_DIR}")
        print("Make sure spike/data/converted/ and spike/data/ground_truth/ exist.")
        sys.exit(1)

    pairs = load_ground_truth()
    if not pairs:
        print("ERROR: No test pairs found")
        sys.exit(1)

    print(f"\n=== Desktop Evaluation: {args.model_id or model_dir.name} ===")
    print(f"Model: {model_dir}")
    print(f"Type: {args.model_type} ({'streaming' if args.streaming else 'offline'})")
    print(f"Test files: {len(pairs)}")
    print()

    # Load model
    print("Loading model...", end="", flush=True)
    load_start = time.time()
    try:
        if args.streaming:
            recognizer = create_streaming_recognizer(model_dir, args.model_type, args.num_threads)
        else:
            recognizer = create_offline_recognizer(model_dir, args.model_type, args.num_threads)
    except Exception as e:
        print(f"\nERROR loading model: {e}")
        print("This model is incompatible with the installed sherpa-onnx version.")
        if args.model_id and args.update_registry:
            # Record the failure
            from datetime import date
            today = date.today().isoformat()
            with open(REGISTRY_PATH) as f:
                registry = json.load(f)
            if args.model_id in registry["models"]:
                registry["models"][args.model_id]["results"][f"desktop-{today}"] = {
                    "tier": "desktop",
                    "date": today,
                    "device": f"Mac (Python sherpa-onnx)",
                    "status": "CRASHED",
                    "error": str(e)[:200],
                }
                with open(REGISTRY_PATH, "w") as f:
                    json.dump(registry, f, indent=2, ensure_ascii=False)
                print(f"Failure recorded in registry.")
        sys.exit(1)

    load_ms = int((time.time() - load_start) * 1000)
    print(f" done ({load_ms}ms)")

    # Run evaluation
    eval_data = run_evaluation(recognizer, pairs, is_streaming=args.streaming)

    if eval_data["aggregate"]:
        agg = eval_data["aggregate"]
        print(f"\n=== RESULTS ===")
        print(f"Files: {agg['files_success']}/{agg['files_total']}")
        print(f"Avg inference: {agg['avg_inference_ms']}ms")
        print(f"Overall WER (raw): {agg['overall_wer_raw']:.1%}")
        print(f"Prose WER (raw): {agg['prose_wer_raw']:.1%}")
        print(f"Model load time: {load_ms}ms")
    else:
        print("\nNo successful transcriptions.")

    # Update registry
    if args.model_id and args.update_registry and eval_data["aggregate"]:
        import platform
        device = f"Mac {platform.machine()} (Python sherpa-onnx)"
        update_registry(args.model_id, "desktop", device, eval_data)

    # Always regenerate docs
    generate_results_doc()


if __name__ == "__main__":
    main()
