import { useState, useRef, useCallback, useEffect } from "react";
import Constants from "../utils/Constants";

function getMimeType() {
    const types = [
        "audio/webm",
        "audio/mp4",
        "audio/ogg",
        "audio/wav",
        "audio/aac",
    ];
    for (let i = 0; i < types.length; i++) {
        if (MediaRecorder.isTypeSupported(types[i])) {
            return types[i];
        }
    }
    return undefined;
}

export function useStreamingRecorder({ onRecordingComplete }) {
    const [isRecording, setIsRecording] = useState(false);
    const [duration, setDuration] = useState(0);

    const streamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const chunksRef = useRef([]);
    const mimeTypeRef = useRef(null);

    const decodeAudio = useCallback(async (chunks, mimeType) => {
        if (chunks.length === 0) return null;

        try {
            const blob = new Blob(chunks, { type: mimeType });
            const arrayBuffer = await blob.arrayBuffer();

            const audioCTX = new AudioContext({
                sampleRate: Constants.SAMPLING_RATE,
            });

            const decoded = await audioCTX.decodeAudioData(arrayBuffer);
            await audioCTX.close();

            return decoded;
        } catch (error) {
            console.error("Error decoding audio:", error);
            return null;
        }
    }, []);

    const startRecording = useCallback(async () => {
        chunksRef.current = [];
        setDuration(0);

        try {
            if (!streamRef.current) {
                streamRef.current = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                });
            }

            const mimeType = getMimeType();
            mimeTypeRef.current = mimeType;

            const mediaRecorder = new MediaRecorder(streamRef.current, {
                mimeType,
            });
            mediaRecorderRef.current = mediaRecorder;

            mediaRecorder.addEventListener("dataavailable", (event) => {
                if (event.data.size > 0) {
                    chunksRef.current.push(event.data);
                }
            });

            mediaRecorder.addEventListener("stop", async () => {
                if (chunksRef.current.length > 0 && onRecordingComplete) {
                    const audioBuffer = await decodeAudio(
                        chunksRef.current,
                        mimeTypeRef.current
                    );

                    if (audioBuffer) {
                        onRecordingComplete(audioBuffer);
                    }
                }
            });

            mediaRecorder.start();
            setIsRecording(true);
        } catch (error) {
            console.error("Error accessing microphone:", error);
        }
    }, [decodeAudio, onRecordingComplete]);

    const stopRecording = useCallback(() => {
        if (
            mediaRecorderRef.current &&
            mediaRecorderRef.current.state === "recording"
        ) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            setDuration(0);
        }
    }, []);

    // Duration timer
    useEffect(() => {
        if (isRecording) {
            const timer = setInterval(() => {
                setDuration((prev) => prev + 1);
            }, 1000);

            return () => clearInterval(timer);
        }
    }, [isRecording]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((track) => track.stop());
            }
        };
    }, []);

    return {
        isRecording,
        duration,
        startRecording,
        stopRecording,
    };
}
