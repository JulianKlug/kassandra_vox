#!/usr/bin/env python3
"""
Convert a Whisper model to ONNX format for sherpa-onnx.

Usage:
  # Install deps first:
  pip install torch onnx onnxruntime openai-whisper

  # Convert bofenghuang French distilled model:
  python tools/convert-whisper-to-onnx.py \
    --checkpoint bofenghuang/whisper-large-v3-french-distil-dec2 \
    --output-dir models/bofenghuang-dec2-onnx

  # Convert from a local .pt file:
  python tools/convert-whisper-to-onnx.py \
    --checkpoint /path/to/original_model.pt \
    --output-dir models/my-model-onnx

The output directory will contain:
  - encoder.onnx          (graph only, weights in encoder.bin)
  - encoder.bin            (encoder weights)
  - encoder.int8.onnx      (quantized encoder, if quantization succeeds)
  - decoder.onnx           (full decoder with weights)
  - decoder.int8.onnx      (quantized decoder)
  - tokens.txt             (vocabulary for sherpa-onnx)

These files can be used with sherpa-onnx's createSTT({ modelType: "whisper" }).
"""

import argparse
import os
import sys
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="Convert Whisper to ONNX for sherpa-onnx")
    parser.add_argument("--checkpoint", required=True,
                        help="HuggingFace model ID or path to .pt checkpoint file")
    parser.add_argument("--output-dir", required=True,
                        help="Directory to save ONNX files")
    parser.add_argument("--opset", type=int, default=17,
                        help="ONNX opset version (default: 17)")
    parser.add_argument("--skip-quantize", action="store_true",
                        help="Skip int8 quantization")
    args = parser.parse_args()

    # Import deps
    try:
        import torch
        import onnx
        import whisper
        from onnx.external_data_helper import convert_model_to_external_data
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install: pip install torch onnx onnxruntime openai-whisper")
        sys.exit(1)

    # Load model
    checkpoint = args.checkpoint
    if os.path.isfile(checkpoint):
        print(f"Loading from local file: {checkpoint}")
        model = whisper.load_model(checkpoint)
    elif "/" in checkpoint:
        # HuggingFace model ID — download original_model.pt
        from huggingface_hub import hf_hub_download
        print(f"Downloading from HuggingFace: {checkpoint}")
        local_path = hf_hub_download(repo_id=checkpoint, filename="original_model.pt")
        model = whisper.load_model(local_path)
    else:
        # Standard whisper model name
        print(f"Loading standard whisper model: {checkpoint}")
        model = whisper.load_model(checkpoint)

    dims = model.dims
    print(f"Model loaded: {dims}")
    print(f"  Encoder: {dims.n_audio_layer} layers, {dims.n_audio_state}d, {dims.n_mels} mels")
    print(f"  Decoder: {dims.n_text_layer} layers, {dims.n_text_state}d")
    print(f"  Vocab: {dims.n_vocab}")
    print(f"  Multilingual: {model.is_multilingual}")

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # ── Export encoder ──────────────────────────────────

    print("\n=== Exporting encoder ===")

    from torch import nn, Tensor
    import torch.nn.functional as F
    from whisper.model import AudioEncoder, TextDecoder

    class EncoderWrapper(nn.Module):
        """Wraps the encoder + decoder cross-attention key/value projection."""
        def __init__(self, encoder: AudioEncoder, decoder: TextDecoder):
            super().__init__()
            self.encoder = encoder
            self.decoder = decoder

        def forward(self, mel: Tensor):
            audio_features = self.encoder(mel)
            cross_k = []
            cross_v = []
            for block in self.decoder.blocks:
                cross_k.append(block.cross_attn.key(audio_features))
                cross_v.append(block.cross_attn.value(audio_features))
            return torch.stack(cross_k), torch.stack(cross_v)

    encoder = EncoderWrapper(model.encoder, model.decoder)
    encoder.eval()

    x = torch.randn(1, dims.n_mels, 3000)  # 30 seconds
    encoder_path = str(out / "encoder.onnx")

    torch.onnx.export(
        encoder, x, encoder_path,
        opset_version=args.opset,
        input_names=["mel"],
        output_names=["n_layer_cross_k", "n_layer_cross_v"],
        dynamic_axes={
            "mel": {0: "batch_size", 2: "n_audio"},
            "n_layer_cross_k": {1: "batch_size"},
            "n_layer_cross_v": {1: "batch_size"},
        },
    )

    # Convert to external data format (encoder > 2GB protobuf limit)
    model_onnx = onnx.load(encoder_path, load_external_data=True)

    # Add sherpa-onnx metadata
    tokenizer = whisper.tokenizer.get_tokenizer(model.is_multilingual)
    sot_sequence = [dims.n_vocab - 1]  # sot
    if model.is_multilingual:
        sot_sequence.append(dims.n_vocab - 1 + 1)  # language token
    sot_sequence.append(dims.n_vocab - 1 + 1 + (1 if model.is_multilingual else 0) + 1)  # transcribe

    metadata = {
        "model_type": "whisper",
        "version": "1",
        "n_mels": dims.n_mels,
        "n_audio_ctx": dims.n_audio_ctx,
        "n_audio_state": dims.n_audio_state,
        "n_audio_head": dims.n_audio_head,
        "n_audio_layer": dims.n_audio_layer,
        "n_vocab": dims.n_vocab,
        "n_text_ctx": dims.n_text_ctx,
        "n_text_state": dims.n_text_state,
        "n_text_head": dims.n_text_head,
        "n_text_layer": dims.n_text_layer,
        "is_multilingual": int(model.is_multilingual),
        "sot": 50258,
        "eot": 50257,
        "blank_id": 220,
        "no_speech": 50363 if model.is_multilingual else 50362,
        "no_timestamps": 50364 if model.is_multilingual else 50363,
        "transcribe": 50360 if model.is_multilingual else 50359,
        "translate": 50359 if model.is_multilingual else 50358,
    }

    for key, val in metadata.items():
        meta = model_onnx.metadata_props.add()
        meta.key = str(key)
        meta.value = str(val)

    convert_model_to_external_data(model_onnx, all_tensors_to_one_file=True, location="encoder.bin")
    onnx.save(model_onnx, encoder_path)

    enc_graph_size = os.path.getsize(encoder_path)
    enc_bin_size = os.path.getsize(str(out / "encoder.bin"))
    print(f"  encoder.onnx: {enc_graph_size / 1024:.0f} KB (graph)")
    print(f"  encoder.bin: {enc_bin_size / 1024 / 1024:.0f} MB (weights)")

    # Quantize encoder
    if not args.skip_quantize:
        try:
            from onnxruntime.quantization import QuantType, quantize_dynamic
            # Load the small graph file, quantize with external data references
            enc_int8_path = str(out / "encoder.int8.onnx")
            # We need to reload without external data for quantization
            # This is tricky with large models. Try it:
            quantize_dynamic(
                model_input=encoder_path,
                model_output=enc_int8_path,
                op_types_to_quantize=["MatMul"],
                weight_type=QuantType.QInt8,
            )
            enc_int8_size = os.path.getsize(enc_int8_path)
            print(f"  encoder.int8.onnx: {enc_int8_size / 1024 / 1024:.0f} MB")
        except Exception as e:
            print(f"  Encoder quantization failed: {e}")
            print("  Using fp32 encoder (larger but functional)")

    # ── Export decoder ──────────────────────────────────

    print("\n=== Exporting decoder ===")

    class DecoderWrapper(nn.Module):
        """Wraps the decoder with KV-cache support."""
        def __init__(self, decoder: TextDecoder, n_ctx: int):
            super().__init__()
            self.decoder = decoder
            self.n_ctx = n_ctx
            self.blocks = decoder.blocks

        def forward(self, tokens, n_layer_self_k_cache, n_layer_self_v_cache,
                    n_layer_cross_k, n_layer_cross_v, offset):
            x = (
                self.decoder.token_embedding(tokens)
                + self.decoder.positional_embedding[offset : offset + tokens.shape[-1]]
            )
            x = x.to(n_layer_cross_k[0].dtype)

            new_k_list = []
            new_v_list = []
            for i, block in enumerate(self.blocks):
                # Self attention with cache
                sa = block.attn
                q = sa.query(block.attn_ln(x))
                k = sa.key(block.attn_ln(x))
                v = sa.value(block.attn_ln(x))

                # Update cache
                k_cache = n_layer_self_k_cache[i].clone()
                v_cache = n_layer_self_v_cache[i].clone()
                k_cache[:, offset : offset + tokens.shape[-1], :] = k
                v_cache[:, offset : offset + tokens.shape[-1], :] = v

                # Attention
                wv = F.scaled_dot_product_attention(
                    q, k_cache[:, : offset + tokens.shape[-1], :],
                    v_cache[:, : offset + tokens.shape[-1], :],
                )
                x = x + sa.out(wv)

                # Cross attention
                ca = block.cross_attn
                q_cross = ca.query(block.cross_attn_ln(x))
                k_cross = n_layer_cross_k[i]
                v_cross = n_layer_cross_v[i]
                wv_cross = F.scaled_dot_product_attention(q_cross, k_cross, v_cross)
                x = x + ca.out(wv_cross)

                # FFN
                x = x + block.mlp(block.mlp_ln(x))

                new_k_list.append(k_cache)
                new_v_list.append(v_cache)

            x = self.decoder.ln(x)
            logits = (x @ torch.transpose(self.decoder.token_embedding.weight, 0, 1)).float()

            return logits, torch.stack(new_k_list), torch.stack(new_v_list)

    decoder = DecoderWrapper(model.decoder, dims.n_text_ctx)
    decoder.eval()

    tokens = torch.randint(0, dims.n_vocab, (1, 3))
    n_layer_self_k = torch.randn(dims.n_text_layer, 1, dims.n_text_ctx, dims.n_text_state)
    n_layer_self_v = torch.randn(dims.n_text_layer, 1, dims.n_text_ctx, dims.n_text_state)
    n_layer_cross_k = torch.randn(dims.n_text_layer, 1, dims.n_audio_ctx, dims.n_text_state)
    n_layer_cross_v = torch.randn(dims.n_text_layer, 1, dims.n_audio_ctx, dims.n_text_state)
    offset = torch.tensor(0, dtype=torch.int64)

    decoder_path = str(out / "decoder.onnx")
    torch.onnx.export(
        decoder,
        (tokens, n_layer_self_k, n_layer_self_v, n_layer_cross_k, n_layer_cross_v, offset),
        decoder_path,
        opset_version=args.opset,
        input_names=["tokens", "n_layer_self_k_cache", "n_layer_self_v_cache",
                      "n_layer_cross_k", "n_layer_cross_v", "offset"],
        output_names=["logits", "out_n_layer_self_k_cache", "out_n_layer_self_v_cache"],
        dynamic_axes={
            "tokens": {0: "batch_size", 1: "n_tokens"},
            "n_layer_self_k_cache": {1: "batch_size"},
            "n_layer_self_v_cache": {1: "batch_size"},
            "n_layer_cross_k": {1: "batch_size"},
            "n_layer_cross_v": {1: "batch_size"},
            "logits": {0: "batch_size", 1: "n_tokens"},
            "out_n_layer_self_k_cache": {1: "batch_size"},
            "out_n_layer_self_v_cache": {1: "batch_size"},
        },
    )

    dec_size = os.path.getsize(decoder_path)
    print(f"  decoder.onnx: {dec_size / 1024 / 1024:.0f} MB")

    # Quantize decoder
    if not args.skip_quantize:
        try:
            from onnxruntime.quantization import QuantType, quantize_dynamic
            dec_int8_path = str(out / "decoder.int8.onnx")
            quantize_dynamic(
                model_input=decoder_path,
                model_output=dec_int8_path,
                op_types_to_quantize=["MatMul"],
                weight_type=QuantType.QInt8,
            )
            dec_int8_size = os.path.getsize(dec_int8_path)
            print(f"  decoder.int8.onnx: {dec_int8_size / 1024 / 1024:.0f} MB")
        except Exception as e:
            print(f"  Decoder quantization failed: {e}")

    # ── Generate tokens.txt ─────────────────────────────

    print("\n=== Generating tokens.txt ===")
    tokens_path = str(out / "tokens.txt")
    tokenizer = whisper.tokenizer.get_tokenizer(model.is_multilingual)

    with open(tokens_path, "w", encoding="utf-8") as f:
        for i in range(tokenizer.encoding.n_vocab):
            token = tokenizer.encoding.decode_single_token_bytes(i)
            token_str = token.decode("utf-8", errors="replace").replace(" ", "\u2581")
            f.write(f"{token_str} {i}\n")
        for i in range(tokenizer.encoding.n_vocab, dims.n_vocab):
            f.write(f"<special_{i}> {i}\n")

    print(f"  tokens.txt: {dims.n_vocab} tokens")

    # ── Summary ─────────────────────────────────────────

    print(f"\n=== DONE ===")
    print(f"Output: {out}/")
    for f in sorted(out.iterdir()):
        size = f.stat().st_size
        if size > 1024 * 1024:
            print(f"  {f.name}: {size / 1024 / 1024:.1f} MB")
        elif size > 1024:
            print(f"  {f.name}: {size / 1024:.0f} KB")
        else:
            print(f"  {f.name}: {size} bytes")

    print(f"\nTo use with sherpa-onnx, create a directory with:")
    print(f"  encoder.onnx (or encoder.int8.onnx)")
    print(f"  encoder.bin (weight data for the encoder)")
    print(f"  decoder.onnx (or decoder.int8.onnx)")
    print(f"  tokens.txt")

if __name__ == "__main__":
    main()
