/**
 * Desktop-side medical text correction using CamemBERT-bio.
 *
 * Runs on the desktop (Node.js or browser via onnxruntime-web).
 * Validates corrections from the phone's dictionary+phonetic pipeline
 * by comparing sentence perplexity before/after each correction.
 *
 * Architecture:
 *   Phone sends raw STT text → desktop receives it
 *   Desktop applies CamemBERT-bio scoring → validates corrections
 *   Only applies corrections that improve sentence perplexity
 *
 * Usage (Node.js):
 *   const { CamembertCorrector } = require('./correct.js');
 *   const corrector = new CamembertCorrector('models/camembert-bio-onnx');
 *   await corrector.load();
 *   const result = await corrector.correct('insuffisance hipatique');
 *   // result = 'insuffisance hépatique'
 */

// This module is designed for Node.js with onnxruntime-node.
// For browser use, swap onnxruntime-node with onnxruntime-web.

let ort;
try {
  ort = require('onnxruntime-node');
} catch {
  console.warn('[correct] onnxruntime-node not available. Desktop correction disabled.');
}

class CamembertCorrector {
  constructor(modelDir) {
    this.modelDir = modelDir;
    this.session = null;
    this.tokenizer = null;
  }

  async load() {
    if (!ort) throw new Error('onnxruntime-node not installed');

    const path = require('path');
    const fs = require('fs');

    // Load ONNX model
    const modelPath = path.join(this.modelDir, 'model.int8.onnx');
    this.session = await ort.InferenceSession.create(modelPath);

    // Load tokenizer (simplified - uses the tokenizer.json from HuggingFace)
    const tokenizerPath = path.join(this.modelDir, 'tokenizer.json');
    const tokenizerData = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'));
    this.vocab = {};
    this.reverseVocab = {};
    for (const [token, id] of Object.entries(tokenizerData.model.vocab)) {
      this.vocab[token] = id;
      this.reverseVocab[id] = token;
    }
    this.maskTokenId = this.vocab['<mask>'] || 32004;

    console.log(`[correct] CamemBERT-bio loaded (${Object.keys(this.vocab).length} tokens)`);
  }

  /**
   * Simple tokenizer using the vocab directly.
   * Not as good as sentencepiece but works for scoring.
   */
  tokenize(text) {
    // Use the tokenizer.json's pre-tokenized approach
    // For a proper implementation, use a sentencepiece binding
    // This is a simplified version that splits on spaces and looks up tokens
    const words = text.toLowerCase().split(/\s+/);
    const ids = [5]; // <s> = BOS token for CamemBERT

    for (const word of words) {
      // Try the full word with ▁ prefix (sentencepiece convention)
      const spWord = '▁' + word;
      if (this.vocab[spWord] !== undefined) {
        ids.push(this.vocab[spWord]);
      } else {
        // Fall back to character-level tokenization
        let remaining = spWord;
        while (remaining.length > 0) {
          let matched = false;
          for (let len = Math.min(remaining.length, 20); len > 0; len--) {
            const sub = remaining.substring(0, len);
            if (this.vocab[sub] !== undefined) {
              ids.push(this.vocab[sub]);
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

    ids.push(6); // </s> = EOS token
    return ids;
  }

  /**
   * Compute pseudo-log-likelihood score for a sentence.
   * Higher = more natural/likely.
   */
  async sentenceScore(text) {
    if (!this.session) throw new Error('Model not loaded');

    const tokenIds = this.tokenize(text);
    const n = tokenIds.length;
    let totalLogProb = 0;
    let count = 0;

    // Mask each token (except BOS/EOS) and compute log probability
    for (let i = 1; i < n - 1; i++) {
      const masked = [...tokenIds];
      const originalId = masked[i];
      masked[i] = this.maskTokenId;

      const inputIds = new ort.Tensor('int64', BigInt64Array.from(masked.map(BigInt)), [1, n]);
      const attentionMask = new ort.Tensor('int64', BigInt64Array.from(new Array(n).fill(1n)), [1, n]);

      const results = await this.session.run({
        input_ids: inputIds,
        attention_mask: attentionMask,
      });

      const logits = results.logits.data;
      const vocabSize = results.logits.dims[2];
      const offset = i * vocabSize;

      // Compute log softmax for the masked position
      let maxLogit = -Infinity;
      for (let j = 0; j < vocabSize; j++) {
        if (logits[offset + j] > maxLogit) maxLogit = logits[offset + j];
      }
      let sumExp = 0;
      for (let j = 0; j < vocabSize; j++) {
        sumExp += Math.exp(logits[offset + j] - maxLogit);
      }
      const logProb = logits[offset + originalId] - maxLogit - Math.log(sumExp);

      totalLogProb += logProb;
      count++;
    }

    return count > 0 ? totalLogProb / count : 0;
  }

  /**
   * Score a correction: is the corrected version more natural?
   * Returns { shouldCorrect, originalScore, correctedScore, delta }
   */
  async scoreCorrection(original, corrected) {
    const [origScore, corrScore] = await Promise.all([
      this.sentenceScore(original),
      this.sentenceScore(corrected),
    ]);

    return {
      shouldCorrect: corrScore > origScore,
      originalScore: origScore,
      correctedScore: corrScore,
      delta: corrScore - origScore,
    };
  }
}

module.exports = { CamembertCorrector };
