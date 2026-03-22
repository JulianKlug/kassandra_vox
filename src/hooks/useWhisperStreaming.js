import { useState, useCallback, useRef } from "react";
import { useWorker } from "./useWorker";
import { useChunkedRecorder } from "./useChunkedRecorder";
import Constants from "../utils/Constants";

/**
 * Main orchestration hook for Whisper-based streaming dictation.
 * Coordinates the Web Worker (model loading + transcription) with
 * the chunked recorder (audio capture + delivery).
 */
export function useWhisperStreaming() {
    const [isModelLoading, setIsModelLoading] = useState(false);
    const [isModelReady, setIsModelReady] = useState(false);
    const [loadProgress, setLoadProgress] = useState(0);
    const [confirmedText, setConfirmedText] = useState("");
    const [pendingText, setPendingText] = useState("");
    const [error, setError] = useState(null);
    const [chunkDurationS, setChunkDurationS] = useState(Constants.CHUNK_DURATION_S);
    const [isListening, setIsListening] = useState(false);

    // Track whether we're currently listening to avoid stale closures
    const isListeningRef = useRef(false);
    const modelRef = useRef(Constants.DEFAULT_MODEL);

    // Worker message handler
    const handleWorkerMessage = useCallback((event) => {
        const data = event.data;

        switch (data.status) {
            case "progress":
                if (data.file && data.progress !== undefined) {
                    setLoadProgress(Math.round(data.progress));
                }
                break;

            case "initiate":
                setIsModelLoading(true);
                break;

            case "done":
                // Individual file download complete
                break;

            case "ready":
                setIsModelLoading(false);
                setIsModelReady(true);
                setLoadProgress(100);
                break;

            case "chunk_partial":
                if (isListeningRef.current) {
                    setPendingText(data.text || "");
                }
                break;

            case "chunk_complete":
                setConfirmedText((prev) => {
                    const newText = data.text || "";
                    if (!newText) return prev;
                    return prev ? prev + " " + newText : newText;
                });
                setPendingText("");
                break;

            case "error":
                setError(data.data?.message || "Transcription error");
                setIsModelLoading(false);
                break;

            case "device":
                console.log("Using device:", data.device);
                break;

            default:
                break;
        }
    }, []);

    const worker = useWorker(handleWorkerMessage);

    // Audio chunk handler — send to worker for transcription
    const handleAudioChunk = useCallback(
        (audio, chunkIndex) => {
            if (!worker || !isListeningRef.current) return;
            worker.postMessage({
                type: "transcribe_chunk",
                audio,
                chunkIndex,
                model: modelRef.current,
                language: Constants.DEFAULT_LANGUAGE,
                task: Constants.DEFAULT_SUBTASK,
            });
        },
        [worker],
    );

    const { isRecording, startRecording, stopRecording, error: recorderError } = useChunkedRecorder({
        onAudioChunk: handleAudioChunk,
        chunkDurationS,
        overlapS: Constants.CHUNK_OVERLAP_S,
    });

    const loadModel = useCallback(() => {
        if (!worker || isModelReady || isModelLoading) return;
        setIsModelLoading(true);
        setError(null);
        worker.postMessage({
            type: "load",
            model: modelRef.current,
        });
    }, [worker, isModelReady, isModelLoading]);

    const startListening = useCallback(() => {
        setError(null);
        isListeningRef.current = true;
        setIsListening(true);
        startRecording();
    }, [startRecording]);

    const stopListening = useCallback(() => {
        isListeningRef.current = false;
        setIsListening(false);
        stopRecording();
        setPendingText("");
    }, [stopRecording]);

    const clearTranscript = useCallback(() => {
        setConfirmedText("");
        setPendingText("");
    }, []);

    const fullTranscript = pendingText
        ? confirmedText
            ? confirmedText + " " + pendingText
            : pendingText
        : confirmedText;

    return {
        isModelLoading,
        isModelReady,
        isListening: isListening && isRecording,
        loadProgress,
        fullTranscript,
        confirmedText,
        pendingText,
        error: error || recorderError,
        loadModel,
        startListening,
        stopListening,
        clearTranscript,
        chunkDurationS,
        setChunkDurationS,
    };
}
