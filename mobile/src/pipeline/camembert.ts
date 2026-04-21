/**
 * CamemBERT-bio sentence scoring for correction validation.
 *
 * Uses ONNX Runtime to run the French biomedical BERT model on-device.
 * Validates corrections from the dictionary+phonetic pipeline by
 * comparing sentence perplexity before/after each correction.
 *
 * Only applies corrections that make the sentence more "natural"
 * according to CamemBERT-bio's language model. This prevents false
 * positives from the phonetic matcher.
 *
 * Pipeline position: runs AFTER dictionary+phonetic corrections,
 * validates each proposed correction before applying it.
 */

import * as FileSystem from "expo-file-system/legacy";

let session: any = null;
let tokenizer: Map<string, number> | null = null;
let maskTokenId = 32004;
let initPromise: Promise<void> | null = null;

const MODEL_URL = "https://huggingface.co/almanach/camembert-bio-base/resolve/main";
const MODEL_DIR = `${FileSystem.documentDirectory}camembert-bio`;

/**
 * Download and initialize the CamemBERT-bio ONNX model.
 */
export async function initCamembert(): Promise<void> {
  if (session) return;
  if (initPromise) return initPromise;

  initPromise = doInit();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

async function doInit(): Promise<void> {
  let InferenceSession: any;
  try {
    InferenceSession = require("onnxruntime-react-native").InferenceSession;
  } catch (e: any) {
    throw new Error(`onnxruntime-react-native not available: ${e?.message}`);
  }
  if (!InferenceSession) {
    throw new Error("onnxruntime-react-native native module not linked");
  }

  // Check for local model first (pushed via adb for dev)
  const localPath = "/data/local/tmp/camembert-bio";
  let modelPath: string;
  let tokenizerPath: string;

  try {
    const info = await FileSystem.getInfoAsync(`file://${localPath}/model.int8.onnx`);
    if (info.exists) {
      console.log("[vox] Using local CamemBERT-bio model");
      modelPath = `${localPath}/model.int8.onnx`;
      tokenizerPath = `file://${localPath}/tokenizer.json`;
    } else {
      throw new Error("not found");
    }
  } catch {
    // Download model
    console.log("[vox] Downloading CamemBERT-bio model...");
    await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true }).catch(() => {});

    const modelUri = `${MODEL_DIR}/model.int8.onnx`;
    const modelInfo = await FileSystem.getInfoAsync(modelUri);
    if (!modelInfo.exists) {
      // TODO: download from HuggingFace or bundled asset
      // For now, require adb push
      throw new Error("CamemBERT-bio model not found. Push to /data/local/tmp/camembert-bio/");
    }
    modelPath = modelUri.replace(/^file:\/\//, "");
    tokenizerPath = `${MODEL_DIR}/tokenizer.json`;
  }

  // Load tokenizer
  const tokenizerContent = await FileSystem.readAsStringAsync(tokenizerPath);
  const tokenizerData = JSON.parse(tokenizerContent);
  tokenizer = new Map();
  for (const [token, id] of Object.entries(tokenizerData.model.vocab)) {
    tokenizer.set(token, id as number);
  }
  maskTokenId = tokenizer.get("<mask>") ?? 32004;

  // Load ONNX model
  console.log(`[vox] Loading CamemBERT-bio from ${modelPath}`);
  session = await InferenceSession.create(modelPath, {
    executionProviders: ["nnapi", "cpu"],  // NNAPI for GPU/NPU, CPU fallback
  });
  console.log("[vox] CamemBERT-bio ready");
}

export function isCamembertReady(): boolean {
  return session !== null;
}

/**
 * Tokenize text using the CamemBERT vocabulary.
 * Simplified tokenizer (greedy longest-match).
 */
function tokenize(text: string): number[] {
  if (!tokenizer) return [];

  const words = text.toLowerCase().split(/\s+/);
  const ids: number[] = [5]; // <s> BOS

  for (const word of words) {
    const spWord = "\u2581" + word; // sentencepiece ▁ prefix
    const fullId = tokenizer.get(spWord);
    if (fullId !== undefined) {
      ids.push(fullId);
    } else {
      // Character-level fallback
      let remaining = spWord;
      while (remaining.length > 0) {
        let matched = false;
        for (let len = Math.min(remaining.length, 20); len > 0; len--) {
          const sub = remaining.substring(0, len);
          const subId = tokenizer.get(sub);
          if (subId !== undefined) {
            ids.push(subId);
            remaining = remaining.substring(len);
            matched = true;
            break;
          }
        }
        if (!matched) {
          ids.push(3); // <unk>
          remaining = remaining.substring(1);
        }
      }
    }
  }

  ids.push(6); // </s> EOS
  return ids;
}

/**
 * Compute pseudo-log-likelihood score for a sentence.
 * Higher score = more natural/likely according to CamemBERT-bio.
 *
 * Masks each token one by one, sums log probabilities.
 * This is the standard PLL metric from Salazar et al. (2020).
 */
export async function sentenceScore(text: string): Promise<number> {
  if (!session) throw new Error("CamemBERT not loaded");

  let Tensor: any;
  try {
    Tensor = require("onnxruntime-react-native").Tensor;
  } catch {
    throw new Error("onnxruntime not available");
  }
  const tokenIds = tokenize(text);
  const n = tokenIds.length;
  if (n <= 2) return 0; // just BOS/EOS

  let totalLogProb = 0;
  let count = 0;

  for (let i = 1; i < n - 1; i++) {
    const masked = [...tokenIds];
    const originalId = masked[i];
    masked[i] = maskTokenId;

    const inputIds = new Tensor("int64", BigInt64Array.from(masked.map(BigInt)), [1, n]);
    const attentionMask = new Tensor("int64", BigInt64Array.from(new Array(n).fill(1n)), [1, n]);

    const results = await session.run({
      input_ids: inputIds,
      attention_mask: attentionMask,
    });

    const logits = results.logits.data as Float32Array;
    const vocabSize = results.logits.dims[2];
    const offset = i * vocabSize;

    // Log softmax at the masked position
    let maxLogit = -Infinity;
    for (let j = 0; j < vocabSize; j++) {
      if (logits[offset + j] > maxLogit) maxLogit = logits[offset + j];
    }
    let sumExp = 0;
    for (let j = 0; j < vocabSize; j++) {
      sumExp += Math.exp(logits[offset + j] - maxLogit);
    }
    totalLogProb += logits[offset + originalId] - maxLogit - Math.log(sumExp);
    count++;
  }

  return count > 0 ? totalLogProb / count : 0;
}

/**
 * Validate a proposed correction using CamemBERT-bio.
 * Returns true if the corrected version scores higher (more natural).
 */
export async function validateCorrection(
  original: string,
  corrected: string
): Promise<boolean> {
  if (!session) return true; // if model not loaded, accept all corrections

  try {
    const [origScore, corrScore] = await Promise.all([
      sentenceScore(original),
      sentenceScore(corrected),
    ]);

    const delta = corrScore - origScore;
    console.log(`[vox-bert] "${original.slice(0, 40)}" → score: ${origScore.toFixed(2)} vs ${corrScore.toFixed(2)} (delta=${delta.toFixed(2)})`);

    return corrScore > origScore;
  } catch (e: any) {
    console.warn(`[vox-bert] Scoring failed: ${e?.message}`);
    return true; // on error, accept the correction
  }
}
