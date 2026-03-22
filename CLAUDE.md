Goal: build a voice dictation tool, that works fulls through edge computing (in browser), no data should be sent to the backend

Primary target language: french (medical domain)

Use:
- single button start / stops listening
- audio should be streamed to the speech to text model
- transription should be as fast and as accurate as possible without freezing main thread

Webpage examples: 
- https://huggingface.co/spaces/mistralai/Voxtral-Mini-Realtime

Model examples:
- https://huggingface.co/bofenghuang
- https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602

Onnx conversion:
- https://huggingface.co/docs/transformers/en/serialization
