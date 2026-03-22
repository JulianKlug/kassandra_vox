import { useRef, useEffect, useState } from "react";

export default function Transcript({ transcribedData }) {
    const divRef = useRef(null);
    const [copied, setCopied] = useState(false);

    const copyToClipboard = async () => {
        const text = transcribedData?.text?.trim() ?? "";
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    };

    // Scroll to the bottom when the component updates
    useEffect(() => {
        if (divRef.current) {
            const diff = Math.abs(
                divRef.current.offsetHeight +
                    divRef.current.scrollTop -
                    divRef.current.scrollHeight,
            );

            if (diff <= 64) {
                divRef.current.scrollTop = divRef.current.scrollHeight;
            }
        }
    });

    const text = transcribedData?.text?.trim();

    if (!text) {
        return null;
    }

    return (
        <div
            ref={divRef}
            className="w-full max-w-2xl my-4 p-6 bg-white rounded-lg shadow-xl shadow-black/5 ring-1 ring-slate-700/10 max-h-[20rem] overflow-y-auto"
        >
            <p className="text-lg text-slate-800 leading-relaxed whitespace-pre-wrap">
                {text}
                {transcribedData?.isBusy && (
                    <span className="inline-block w-2 h-5 ml-1 bg-slate-400 animate-pulse" />
                )}
            </p>

            {!transcribedData.isBusy && (
                <div className="mt-4 pt-4 border-t border-slate-200 text-right">
                    <button
                        onClick={copyToClipboard}
                        className="text-white bg-blue-500 hover:bg-blue-600 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-4 py-2"
                    >
                        {copied ? "Copied!" : "Copy"}
                    </button>
                </div>
            )}
        </div>
    );
}
