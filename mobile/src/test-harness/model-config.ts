/**
 * Model configuration for the benchmark pipeline.
 *
 * Defines which models to test and how to load them.
 * Edit this file to swap in new models for evaluation.
 */

export interface ModelConfig {
  id: string;
  name: string;
  type: "streaming" | "offline";
  modelType: string; // sherpa-onnx model type: "transducer", "nemo_ctc", "whisper", etc.
  /** Path on device where model files live (no file:// prefix) */
  localPath: string;
  sizeMb: number;
}

/**
 * The offline model to benchmark. Change this to test a different model.
 *
 * To test a new model:
 * 1. Push it to the device: adb push /path/to/model /data/local/tmp/model-name
 * 2. Update localPath below
 * 3. Rebuild + run the test harness
 */
export const OFFLINE_MODEL: ModelConfig = {
  id: "nemo-ctc-fr-int8",
  name: "NeMo Fast Conformer CTC int8",
  type: "offline",
  modelType: "nemo_ctc",
  localPath: "/data/local/tmp/nemo-ctc-fr",
  sizeMb: 126,
};

/**
 * The streaming model to benchmark (if available on device).
 * Set to null to skip streaming benchmarks.
 */
export const STREAMING_MODEL: ModelConfig | null = null;
// Example: uncomment and push model to device to test streaming
// export const STREAMING_MODEL: ModelConfig = {
//   id: "zipformer-fr-2023-mobile",
//   name: "Zipformer FR 2023 Mobile",
//   type: "streaming",
//   modelType: "transducer",
//   localPath: "/data/local/tmp/zipformer-fr",
//   sizeMb: 351,
// };
