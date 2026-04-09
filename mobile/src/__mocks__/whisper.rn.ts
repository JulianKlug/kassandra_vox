// Mock for whisper.rn native module (can't run in Node/Jest)
export class WhisperContext {
  ptr = 0;
  id = 0;
  gpu = false;
  reasonNoGPU = "mock";
  transcribe = jest.fn();
  transcribeRealtime = jest.fn();
  bench = jest.fn();
  release = jest.fn();
}

export const initWhisper = jest.fn().mockResolvedValue(new WhisperContext());
export const releaseAllWhisper = jest.fn();
export const libVersion = "mock";

// RealtimeTranscriber mock
export class RealtimeTranscriber {
  start = jest.fn().mockResolvedValue(undefined);
  stop = jest.fn().mockResolvedValue(undefined);
}

// AudioPcmStreamAdapter mock
export class AudioPcmStreamAdapter {
  initialize = jest.fn();
  start = jest.fn();
  stop = jest.fn();
  isRecording = jest.fn().mockReturnValue(false);
  onData = jest.fn();
  onError = jest.fn();
  onStatusChange = jest.fn();
  release = jest.fn();
}
