# Kassandra Vox

Goal: build a voice dictation tool, that works fulls through edge computing (in browser), no data should be sent to the backend

Primary target language: french (medical domain)

Use: 
- single button start / stops listening 
- audio should be streamed to the speech to text model
- transription should be as fast and as accurate as possible without freezing main thread 

Model options:
- https://huggingface.co/bofenghuang

Onnx conversion:
- https://huggingface.co/docs/transformers/en/serialization

Future ideas: 
- p2p connections 
- speech to text model streams to llm for language enhancement