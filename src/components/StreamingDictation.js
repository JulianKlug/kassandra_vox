import { useCallback } from "react";
import { useStreamingRecorder } from "../hooks/useStreamingRecorder";
import DictationButton from "./DictationButton";
import Progress from "./basicComponents/Progress";

export default function StreamingDictation({ transcriber }) {
    const handleRecordingComplete = useCallback(
        (audioBuffer) => {
            transcriber.start(audioBuffer);
        },
        [transcriber]
    );

    const { isRecording, duration, startRecording, stopRecording } =
        useStreamingRecorder({
            onRecordingComplete: handleRecordingComplete,
        });

    const handleToggle = useCallback(() => {
        if (isRecording) {
            stopRecording();
        } else {
            transcriber.onInputChange();
            startRecording();
        }
    }, [isRecording, startRecording, stopRecording, transcriber]);

    return (
        <div className="flex flex-col items-center w-full">
            <DictationButton
                isRecording={isRecording}
                isModelLoading={transcriber.isModelLoading}
                isModelReady={transcriber.isModelReady}
                isTranscribing={transcriber.isBusy}
                duration={duration}
                onToggle={handleToggle}
            />

            {transcriber.progressItems.length > 0 && (
                <div className="w-full max-w-md mt-4 p-4 bg-white rounded-lg shadow">
                    <label className="text-sm text-gray-600">
                        Loading model files... (first time only)
                    </label>
                    {transcriber.progressItems.map((data) => (
                        <div key={data.file} className="mt-2">
                            <Progress
                                text={data.file}
                                percentage={data.progress}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
