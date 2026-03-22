/* eslint-disable camelcase */
/* eslint-disable no-restricted-globals */
import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;

let transcriber = null;
let currentModel = null;

/**
 * Detect best available backend: WebGPU if supported, else WASM.
 */
async function detectDevice() {
    try {
        if (typeof navigator !== "undefined" && navigator.gpu) {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) return "webgpu";
        }
    } catch (e) {
        // WebGPU not available
    }
    return "wasm";
}

/**
 * Load or reuse the transcription pipeline.
 */
async function loadPipeline(model, progressCallback) {
    if (transcriber && currentModel === model) {
        return transcriber;
    }

    if (transcriber) {
        await transcriber.dispose();
        transcriber = null;
    }

    const device = await detectDevice();
    self.postMessage({ status: "device", device });

    const isWasm = device !== "webgpu";
    transcriber = await pipeline("automatic-speech-recognition", model, {
        dtype: {
            encoder_model: isWasm ? "q4" : "fp32",
            decoder_model_merged: isWasm ? "q4" : "fp32",
        },
        device,
        progress_callback: progressCallback,
    });
    currentModel = model;
    return transcriber;
}

self.addEventListener("message", async (event) => {
    const message = event.data;

    if (message.type === "load") {
        try {
            await loadPipeline(message.model, (data) => {
                self.postMessage(data);
            });
            self.postMessage({ status: "ready" });
        } catch (error) {
            self.postMessage({
                status: "error",
                data: { message: error.message || String(error) },
            });
        }
        return;
    }

    if (message.type === "transcribe_chunk") {
        try {
            const pipe = await loadPipeline(message.model, (data) => {
                self.postMessage(data);
            });

            const result = await pipe(message.audio, {
                language: message.language || "fr",
                task: message.task || "transcribe",
                return_timestamps: false,
            });

            const text = result.text || "";
            self.postMessage({
                status: "chunk_complete",
                chunkIndex: message.chunkIndex,
                text: text.trim(),
            });
        } catch (error) {
            self.postMessage({
                status: "error",
                data: { message: error.message || String(error) },
                chunkIndex: message.chunkIndex,
            });
        }
        return;
    }
});
