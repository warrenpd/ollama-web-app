# Ollama Web App

A local web app for chatting with Mistral, MiMo or any other model through a locally running [Ollama](https://ollama.com), with per-chat memory and usage stats.

## Run

```bash
ollama pull mistral      # once
npm start                # or: node server.js
```

Open http://localhost:8787. No npm dependencies — needs Node 18+.

Environment variables: `PORT` (default `8787`), `OLLAMA_HOST` (default `http://127.0.0.1:11434`).

## Features

- Streaming responses, with a collapsible "Thinking" block for reasoning models, stop button, multiple chats (saved in browser localStorage), model picker.
- **Live system panel** (refreshes every 2 s): system RAM and CPU, Ollama process memory (RSS) and CPU, load average, loaded models with total / GPU memory and unload time.
- **Per-response stats**: prompt and completion tokens, generation and prompt speed (tok/s), time to first token, thinking time, time to answer, model load / prompt eval / generation / total time, model size in memory (incl. VRAM share), context window, Ollama RSS before and peak, Ollama peak CPU, system RAM change.
- **Per-chat totals**: token counts, average speed, total compute and load time, peak memory and CPU.

## How it works

`server.js` proxies `POST /api/chat` to Ollama's `/api/chat` as a stream. While the model generates, it samples Ollama's processes every 500 ms (`ps`) for peak memory/CPU, then attaches Ollama's timing counters plus `/api/ps` model memory to the final event. `GET /api/stats` returns a live snapshot, and `GET /api/models` lists installed models.

On Apple Silicon, model weights live in unified memory and show up under "GPU" in `/api/ps`. They may not be fully reflected in process RSS.
