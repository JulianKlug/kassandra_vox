// Type shim for whisper.rn.
// The package's exports field only enumerates "./*" (deep paths) without a
// bare "." entry, so TypeScript's bundler resolution can't follow the bare
// import for type checking. Metro handles it fine at runtime.

declare module "whisper.rn" {
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

declare module "whisper.rn/realtime-transcription" {
  export {
    RealtimeTranscriber,
  } from "whisper.rn/lib/typescript/realtime-transcription/index";

  export type {
    RealtimeOptions,
    RealtimeTranscribeEvent,
    RealtimeTranscriberCallbacks,
    RealtimeTranscriberDependencies,
    RealtimeVadEvent,
    RealtimeStatsEvent,
    AudioStreamInterface,
    AudioStreamConfig,
    AudioStreamData,
    AudioSlice,
    AudioSliceNoData,
    MemoryUsage,
  } from "whisper.rn/lib/typescript/realtime-transcription/index";
}

declare module "whisper.rn/realtime-transcription/adapters" {
  export {
    AudioPcmStreamAdapter,
  } from "whisper.rn/lib/typescript/realtime-transcription/adapters/AudioPcmStreamAdapter";
}
