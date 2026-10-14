# Ollama Debug Logs

The backend writes one JSON Lines file per generation job here:

`ollama-<jobId>.jsonl`

Each Ollama call records its stage (`planner` or `script`), request metadata, HTTP status, duration, response body, and transport/SDK error details including nested causes. Request bodies and prompts are not written. Response bodies are capped at 100,000 characters per call.

Response bodies may contain generated code or other project data. Keep these files local and review them before sharing. JSONL files in this folder are ignored by Git.