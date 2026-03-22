import { formatAudioTimestamp } from "../utils/AudioUtils";

export default function DictationButton({
    isRecording,
    isModelLoading,
    isModelReady,
    isTranscribing,
    duration,
    onToggle,
}) {
    const isDisabled = !isModelReady || isModelLoading;

    const getButtonText = () => {
        if (isModelLoading) {
            return "Loading Model...";
        }
        if (!isModelReady) {
            return "Preparing...";
        }
        if (isRecording) {
            return `Stop (${formatAudioTimestamp(duration)})`;
        }
        return "Start Dictation";
    };

    const getButtonClass = () => {
        const baseClass =
            "m-4 px-8 py-4 rounded-full text-xl font-semibold transition-all duration-200 text-white shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";

        if (isDisabled) {
            return `${baseClass} bg-gray-400 cursor-wait`;
        }
        if (isRecording) {
            return `${baseClass} bg-red-500 hover:bg-red-600 focus-visible:ring-red-500 animate-pulse`;
        }
        return `${baseClass} bg-green-500 hover:bg-green-600 focus-visible:ring-green-500`;
    };

    return (
        <div className="flex flex-col items-center">
            <button
                type="button"
                onClick={onToggle}
                disabled={isDisabled}
                className={getButtonClass()}
            >
                <span className="flex items-center gap-2">
                    {isRecording && (
                        <span className="w-3 h-3 bg-white rounded-full" />
                    )}
                    {getButtonText()}
                    {isTranscribing && !isRecording && (
                        <span className="ml-2 animate-spin">...</span>
                    )}
                </span>
            </button>

            {isRecording && (
                <p className="text-sm text-gray-500">
                    Recording... Speak now
                </p>
            )}
        </div>
    );
}
