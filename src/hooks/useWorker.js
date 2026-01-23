import { useState } from "react";

// export interface MessageEventHandler {
//     (event: MessageEvent): void;
// }

export function useWorker(messageEventHandler) {
    // Create new worker once and never again
    const [worker] = useState(() => createWorker(messageEventHandler));
    return worker;
}

function createWorker(messageEventHandler){
    const worker = new Worker(new URL("../worker.js", import.meta.url), {
        type: "module",
    });
    // Listen for messages from the Web Worker
    worker.addEventListener("message", messageEventHandler);
    return worker;
}
