import { useState, useRef, useCallback, useEffect } from "react";

/**
 * Hook that manages AudioContext + AudioWorklet lifecycle for chunked recording.
 * Captures microphone audio, downsamples to 16kHz via AudioWorklet,
 * and delivers chunks via onAudioChunk callback.
 */
export function useChunkedRecorder({ onAudioChunk, chunkDurationS = 5, overlapS = 1 }) {
    const [isRecording, setIsRecording] = useState(false);
    const [error, setError] = useState(null);

    const audioContextRef = useRef(null);
    const workletNodeRef = useRef(null);
    const streamRef = useRef(null);

    // Keep callback ref fresh without re-creating startRecording
    const onAudioChunkRef = useRef(onAudioChunk);
    useEffect(() => {
        onAudioChunkRef.current = onAudioChunk;
    }, [onAudioChunk]);

    const startRecording = useCallback(async () => {
        try {
            setError(null);

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: { ideal: 16000 },
                    echoCancellation: true,
                    noiseSuppression: true,
                },
            });
            streamRef.current = stream;

            const audioContext = new AudioContext({ sampleRate: undefined }); // use native rate
            audioContextRef.current = audioContext;

            await audioContext.audioWorklet.addModule("/audio-processor.worklet.js");

            const workletNode = new AudioWorkletNode(audioContext, "audio-chunk-processor");
            workletNodeRef.current = workletNode;

            // Configure chunk parameters
            workletNode.port.postMessage({
                type: "configure",
                chunkDurationS,
                overlapS,
            });

            // Handle audio chunks from worklet
            workletNode.port.onmessage = (event) => {
                if (event.data.type === "chunk") {
                    onAudioChunkRef.current?.(event.data.audio, event.data.chunkIndex);
                }
            };

            const source = audioContext.createMediaStreamSource(stream);
            source.connect(workletNode);
            // Don't connect to destination — we don't want to play back

            setIsRecording(true);
        } catch (err) {
            setError(err.message || "Failed to start recording");
            console.error("Recording error:", err);
        }
    }, [chunkDurationS, overlapS]);

    const stopRecording = useCallback(() => {
        // Stop all tracks
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        }

        // Disconnect and close worklet
        if (workletNodeRef.current) {
            workletNodeRef.current.disconnect();
            workletNodeRef.current = null;
        }

        // Close audio context
        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }

        setIsRecording(false);
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((track) => track.stop());
            }
            if (audioContextRef.current) {
                audioContextRef.current.close();
            }
        };
    }, []);

    return { isRecording, startRecording, stopRecording, error };
}
