export default {
    SAMPLING_RATE: 16000,
    DEFAULT_MODEL: "onnx-community/whisper-large-v3-turbo",
    DEFAULT_SUBTASK: "transcribe",
    DEFAULT_LANGUAGE: "fr",
    DEFAULT_QUANTIZED: true,
    DEFAULT_MULTILINGUAL: true,
    CHUNK_DURATION_S: 5,
    CHUNK_OVERLAP_S: 1,
    CHUNK_MIN_S: 2,
    CHUNK_MAX_S: 10,
};
