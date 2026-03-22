/**
 * AudioWorklet processor for real-time audio capture and chunking.
 * Runs on the audio thread — downsamples to 16kHz and posts
 * Float32Array chunks to the main thread at configurable intervals.
 */
class AudioChunkProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.chunkDurationS = 5;
        this.overlapS = 1;
        this.buffer = [];
        this.chunkIndex = 0;
        // Track resampling position across process() calls
        this.resampleRemainder = 0;

        this.port.onmessage = (event) => {
            if (event.data.type === "configure") {
                this.chunkDurationS = event.data.chunkDurationS ?? this.chunkDurationS;
                this.overlapS = event.data.overlapS ?? this.overlapS;
            }
        };
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;

        const channelData = input[0]; // mono
        if (!channelData || channelData.length === 0) return true;

        // Downsample from sampleRate to 16kHz using linear interpolation
        const ratio = sampleRate / 16000;
        let pos = this.resampleRemainder;

        while (pos < channelData.length) {
            const idx = Math.floor(pos);
            const frac = pos - idx;
            const a = channelData[idx];
            const b = idx + 1 < channelData.length ? channelData[idx + 1] : a;
            this.buffer.push(a + frac * (b - a));
            pos += ratio;
        }

        // Save remainder for next call to maintain continuity
        this.resampleRemainder = pos - channelData.length;

        // Check if we have enough samples for a chunk
        const samplesPerChunk = Math.floor(this.chunkDurationS * 16000);
        if (this.buffer.length >= samplesPerChunk) {
            const chunk = new Float32Array(this.buffer.slice(0, samplesPerChunk));
            const overlapSamples = Math.floor(this.overlapS * 16000);
            // Keep overlap samples for context continuity
            this.buffer = this.buffer.slice(samplesPerChunk - overlapSamples);

            this.port.postMessage({
                type: "chunk",
                audio: chunk,
                chunkIndex: this.chunkIndex++,
            });
        }

        return true;
    }
}

registerProcessor("audio-chunk-processor", AudioChunkProcessor);
