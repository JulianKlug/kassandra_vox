// Type shim for whisper.rn.
// The package's exports field only enumerates "./*" (deep paths) without a
// bare "." entry, so TypeScript's bundler resolution can't follow the bare
// import for type checking. Metro handles it fine at runtime.
declare module "whisper.rn" {
  // Re-export values
  export {
    WhisperContext,
    initWhisper,
    releaseAllWhisper,
    libVersion,
    isUseCoreML,
    isCoreMLAllowFallback,
    AudioSessionIos,
    WhisperVadContext,
    initWhisperVad,
    releaseAllWhisperVad,
    toggleNativeLog,
    addNativeLogListener,
  } from "whisper.rn/lib/typescript/index";

  // Re-export types
  export type {
    TranscribeOptions,
    TranscribeResult,
    TranscribeFileOptions,
    TranscribeNewSegmentsResult,
    TranscribeRealtimeOptions,
    TranscribeRealtimeEvent,
    AudioSessionCategoryIos,
    AudioSessionCategoryOptionIos,
    AudioSessionModeIos,
    AudioSessionSettingIos,
    ContextOptions,
    VadOptions,
    VadSegment,
    VadContextOptions,
  } from "whisper.rn/lib/typescript/index";
}
