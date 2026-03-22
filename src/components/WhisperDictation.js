import { useEffect } from "react";
import { useWhisperStreaming } from "../hooks/useWhisperStreaming";
import Constants from "../utils/Constants";

export default function WhisperDictation() {
    const {
        isModelLoading,
        isModelReady,
        isListening,
        loadProgress,
        confirmedText,
        pendingText,
        error,
        loadModel,
        startListening,
        stopListening,
        clearTranscript,
        chunkDurationS,
        setChunkDurationS,
    } = useWhisperStreaming();

    // Load model on mount
    useEffect(() => {
        loadModel();
    }, [loadModel]);

    const handleToggle = () => {
        if (isListening) {
            stopListening();
        } else {
            clearTranscript();
            startListening();
        }
    };

    const fullTranscript = pendingText
        ? confirmedText
            ? confirmedText + " " + pendingText
            : pendingText
        : confirmedText;

    const handleCopy = async () => {
        if (fullTranscript) {
            try {
                await navigator.clipboard.writeText(fullTranscript.trim());
            } catch (err) {
                console.error("Failed to copy:", err);
            }
        }
    };

    const isDisabled = !isModelReady || isModelLoading;

    const getButtonText = () => {
        if (isModelLoading) return "Loading Model...";
        if (!isModelReady) return "Preparing...";
        if (isListening) return "Stop Dictation";
        return "Start Dictation";
    };

    const getButtonClass = () => {
        const baseClass =
            "m-4 px-8 py-4 rounded-full text-xl font-semibold transition-all duration-200 text-white shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";

        if (isDisabled) return `${baseClass} bg-gray-400 cursor-wait`;
        if (isListening) return `${baseClass} bg-red-500 hover:bg-red-600 focus-visible:ring-red-500 animate-pulse`;
        return `${baseClass} bg-green-500 hover:bg-green-600 focus-visible:ring-green-500`;
    };

    const getLatencyLabel = (value) => {
        if (value <= 3) return `~${value}s (fastest)`;
        if (value >= 8) return `~${value}s (most accurate)`;
        return `~${value}s (balanced)`;
    };

    return (
        <div className="flex flex-col items-center w-full">
            {/* Error display */}
            {error && (
                <div className="mb-4 p-4 bg-red-100 text-red-700 rounded-lg max-w-md">
                    {error}
                </div>
            )}

            {/* Chunk size slider */}
            {isModelReady && !isListening && (
                <div className="w-full max-w-md mb-2 px-4">
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                        Latency: {getLatencyLabel(chunkDurationS)}
                    </label>
                    <input
                        type="range"
                        min={Constants.CHUNK_MIN_S}
                        max={Constants.CHUNK_MAX_S}
                        step={1}
                        value={chunkDurationS}
                        onChange={(e) => setChunkDurationS(Number(e.target.value))}
                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                        <span>Faster</span>
                        <span>More accurate</span>
                    </div>
                </div>
            )}

            {/* Dictation button */}
            <button
                type="button"
                onClick={handleToggle}
                disabled={isDisabled}
                className={getButtonClass()}
            >
                <span className="flex items-center gap-2">
                    {isListening && (
                        <span className="w-3 h-3 bg-white rounded-full animate-pulse" />
                    )}
                    {getButtonText()}
                </span>
            </button>

            {isListening && (
                <p className="text-sm text-gray-500 mb-4">
                    Listening... Speak now
                </p>
            )}

            {/* Model loading progress */}
            {isModelLoading && (
                <div className="w-full max-w-md mt-4 p-4 bg-white rounded-lg shadow">
                    <p className="text-sm text-gray-600">
                        Downloading Whisper model ({loadProgress}%)...
                    </p>
                    <div className="mt-2 w-full bg-gray-200 rounded-full h-2">
                        <div
                            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                            style={{ width: `${loadProgress}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Transcript display */}
            {(confirmedText || pendingText) && (
                <div className="w-full max-w-2xl my-4 p-6 bg-white rounded-lg shadow-xl shadow-black/5 ring-1 ring-slate-700/10">
                    <p className="text-lg text-slate-800 leading-relaxed whitespace-pre-wrap">
                        {confirmedText}
                        {confirmedText && pendingText && " "}
                        {pendingText && (
                            <span className="text-slate-400 italic">{pendingText}</span>
                        )}
                        {isListening && (
                            <span className="inline-block w-2 h-5 ml-1 bg-slate-400 animate-pulse" />
                        )}
                    </p>

                    {!isListening && (confirmedText || pendingText) && (
                        <div className="mt-4 pt-4 border-t border-slate-200 text-right">
                            <button
                                onClick={handleCopy}
                                className="text-white bg-blue-500 hover:bg-blue-600 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-4 py-2"
                            >
                                Copy
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
