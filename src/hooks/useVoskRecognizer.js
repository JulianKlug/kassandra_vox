import { useState, useRef, useCallback, useEffect } from "react";
import { createModel } from "vosk-browser";

// French model URL - small model for browser use
const FRENCH_MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip";

export function useVoskRecognizer() {
    const [isModelLoading, setIsModelLoading] = useState(true);
    const [isModelReady, setIsModelReady] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState("");
    const [partialTranscript, setPartialTranscript] = useState("");
    const [error, setError] = useState(null);

    const modelRef = useRef(null);
    const recognizerRef = useRef(null);
    const audioContextRef = useRef(null);
    const mediaStreamRef = useRef(null);
    const processorRef = useRef(null);
    const sourceRef = useRef(null);

    // Load model on mount
    const loadModel = useCallback(async () => {
        if (modelRef.current) return;

        setIsModelLoading(true);
        setError(null);

        try {
            console.log("Loading Vosk French model...");
            const model = await createModel(FRENCH_MODEL_URL);
            modelRef.current = model;
            setIsModelReady(true);
            console.log("Vosk model loaded successfully");
        } catch (err) {
            console.error("Failed to load Vosk model:", err);
            setError("Failed to load speech recognition model");
        } finally {
            setIsModelLoading(false);
        }
    }, []);

    // Start listening
    const startListening = useCallback(async () => {
        if (!modelRef.current || isListening) return;

        setError(null);
        setTranscript("");
        setPartialTranscript("");

        try {
            // Create recognizer
            const recognizer = new modelRef.current.KaldiRecognizer(16000);
            recognizerRef.current = recognizer;

            // Set up event handlers
            recognizer.on("result", (message) => {
                const text = message.result?.text;
                if (text) {
                    setTranscript((prev) => prev + (prev ? " " : "") + text);
                    setPartialTranscript("");
                }
            });

            recognizer.on("partialresult", (message) => {
                const partial = message.result?.partial;
                if (partial) {
                    setPartialTranscript(partial);
                }
            });

            // Get microphone stream
            const mediaStream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    channelCount: 1,
                    sampleRate: 16000,
                },
            });
            mediaStreamRef.current = mediaStream;

            // Create audio context
            const audioContext = new AudioContext({ sampleRate: 16000 });
            audioContextRef.current = audioContext;

            // Handle sample rate mismatch (browsers often ignore sampleRate request)
            const actualSampleRate = audioContext.sampleRate;

            // Create processor node
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (event) => {
                if (recognizerRef.current) {
                    try {
                        // If sample rate doesn't match, we need to resample
                        const inputBuffer = event.inputBuffer;
                        if (actualSampleRate !== 16000) {
                            // Simple downsampling for common case (48000 -> 16000)
                            const inputData = inputBuffer.getChannelData(0);
                            const ratio = actualSampleRate / 16000;
                            const outputLength = Math.floor(inputData.length / ratio);
                            const outputData = new Float32Array(outputLength);

                            for (let i = 0; i < outputLength; i++) {
                                outputData[i] = inputData[Math.floor(i * ratio)];
                            }

                            // Create a new buffer with resampled data
                            const resampledBuffer = audioContext.createBuffer(1, outputLength, 16000);
                            resampledBuffer.copyToChannel(outputData, 0);
                            recognizerRef.current.acceptWaveform(resampledBuffer);
                        } else {
                            recognizerRef.current.acceptWaveform(inputBuffer);
                        }
                    } catch (err) {
                        console.error("Error processing audio:", err);
                    }
                }
            };

            // Connect audio graph
            const source = audioContext.createMediaStreamSource(mediaStream);
            sourceRef.current = source;
            source.connect(processor);
            processor.connect(audioContext.destination);

            setIsListening(true);
        } catch (err) {
            console.error("Failed to start listening:", err);
            setError("Failed to access microphone");
        }
    }, [isListening]);

    // Stop listening
    const stopListening = useCallback(() => {
        if (!isListening) return;

        // Disconnect audio nodes
        if (sourceRef.current) {
            sourceRef.current.disconnect();
            sourceRef.current = null;
        }
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }

        // Stop media stream
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((track) => track.stop());
            mediaStreamRef.current = null;
        }

        // Close audio context
        if (audioContextRef.current && audioContextRef.current.state !== "closed") {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }

        // Clean up recognizer
        if (recognizerRef.current) {
            recognizerRef.current.remove();
            recognizerRef.current = null;
        }

        // Add any remaining partial transcript to final
        setTranscript((prev) => {
            const partial = partialTranscript;
            if (partial) {
                return prev + (prev ? " " : "") + partial;
            }
            return prev;
        });
        setPartialTranscript("");
        setIsListening(false);
    }, [isListening, partialTranscript]);

    // Clear transcript
    const clearTranscript = useCallback(() => {
        setTranscript("");
        setPartialTranscript("");
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (mediaStreamRef.current) {
                mediaStreamRef.current.getTracks().forEach((track) => track.stop());
            }
            if (audioContextRef.current && audioContextRef.current.state !== "closed") {
                audioContextRef.current.close();
            }
            if (recognizerRef.current) {
                recognizerRef.current.remove();
            }
            if (modelRef.current) {
                modelRef.current.terminate();
            }
        };
    }, []);

    return {
        isModelLoading,
        isModelReady,
        isListening,
        transcript,
        partialTranscript,
        fullTranscript: transcript + (partialTranscript ? " " + partialTranscript : ""),
        error,
        loadModel,
        startListening,
        stopListening,
        clearTranscript,
    };
}
