# pi-specialists

**A budget-aware specialist router for [pi](https://pi.dev).**  
Route OCR, vision, image/audio/video generation, speech-to-text, text-to-speech,
embeddings and System-1 decisions to the right local or remote model — with
automatic context discovery, media preprocessing, batching and non-blocking
execution.

[![CI](https://github.com/noguerol/pi-specialists/actions/workflows/ci.yml/badge.svg)](https://github.com/noguerol/pi-specialists/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![pi](https://img.shields.io/badge/pi-%3E%3D1.4-blueviolet)

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Specialist types](#specialist-types)
- [Protocols](#protocols)
- [Authentication](#authentication)
- [Budgets and batching](#budgets-and-batching)
- [Video analysis](#video-analysis)
- [Execution model](#execution-model)
- [Commands](#commands)
- [Tool API](#tool-api)
- [Observability](#observability)
- [Security](#security)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Versioning](#versioning)
- [License](#license)

## Why

A coding agent is good at reasoning but often the wrong tool for a focused
task: reading a scanned invoice, describing a screenshot, transcribing a voice
memo, generating an illustration or classifying a request in milliseconds.
Loading a large multimodal model for every small task is slow and expensive.

`pi-specialists` lets one agent session use any number of **specialists** —
small, dedicated models exposed over HTTP — without leaving the conversation:

- the agent sees the available capabilities in its system prompt;
- a single `specialist` tool routes work by name or task type;
- each specialist declares its own URL, protocol and authentication;
- the router discovers the server budget and fits the payload;
- slow work becomes a background job instead of blocking the agent.

## Features

- **Hugging Face task typology** with 35+ types (OCR, VQA, image-to-text,
  text-to-image, ASR, TTS, video, embeddings, reranking, System-1 decisions…).
- **Nine wire protocols**: OpenAI-compatible chat/images/speech/transcriptions/
  embeddings, Hugging Face Inference, Replicate, decision sidecars and custom
  JSON templates.
- **Flexible authentication**: bearer, custom header, query parameter, basic
  auth or none; secrets can be literals, `env:VAR` or `file:/path`.
- **Budget discovery**: reads `n_ctx`/modalities from llama.cpp and
  OpenAI-compatible servers, and the local `config.json` of transformers
  sidecars. Per-specialist overrides are always available.
- **Media preprocessing**: PDF → pages, oversized images resized/recompressed,
  long audio split, text chunked, directories expanded.
- **Batching**: sequential or parallel work items, aggregated results and a
  full-result markdown file.
- **Non-blocking execution**: a configurable inline grace period (`waitMs`),
  background jobs and next-turn `specialist-result` delivery.
- **Live footer line**: which specialist is running, a task summary and wallclock
  time, aggregated for concurrent work.
- **Video analysis pipeline**: `video_analyze` samples frames for an
  image-to-text specialist and transcribes the audio with an ASR specialist,
  returning a visual timeline and a transcript.
- **Operational tooling**: `/specialists doctor`, `/specialists probe`, job
  listing, validation of saved configuration.
- **No telemetry, no external calls** other than the specialist endpoints you
  configure.

## Architecture

```text
┌──────────────┐
│  pi session  │
│  (agent)     │
└──────┬───────┘
       │  specialist({ specialist, prompt, input, options })
       ▼
┌──────────────────────────────────────────────────────────────┐
│                        pi-specialists                        │
│                                                              │
│  1. resolve specialist (name / alias / type)                 │
│  2. discover budget (/props, /v1/models, /info + config)     │
│  3. preprocess inputs (dirs, PDF pages, resize, split audio) │
│  4. build request (protocol adapter + auth + budget)         │
│  5. execute inline or as a background job                    │
│  6. aggregate results, persist media, deliver messages       │
└──────┬───────────────────────────────────────────────────────┘
       │ HTTP
       ▼
┌──────────────────────────────────────────────────────────────┐
│  local runtimes, hosted APIs or sidecars                     │
│  llama.cpp · vLLM · LM Studio · OpenAI · HF · Replicate · … │
└──────────────────────────────────────────────────────────────┘
```

The extension lives in `src/index.ts`; the rest of `src/` is deliberately
independent from pi so it can be tested with plain Node:

| Module | Responsibility |
|---|---|
| `catalog.ts` | Hugging Face task catalog, families, emoji, aliases |
| `config.ts` | schema, validation, 0600 persistence, secret references |
| `protocols.ts` | request builders and response parsers |
| `execute.ts` | single-request executor and batch-aware entry point |
| `preprocess.ts` | directories, PDF, image/audio/text preparation |
| `budget.ts` / `budget-types.ts` | context discovery and fitting |
| `local.ts` | local-host detection and loopback preference |
| `status.ts` | footer line formatting |
| `ui.ts` | interactive CRUD menu |
| `index.ts` | tool, prompt section, footer, commands |

## Requirements

- **pi** 1.4 or newer.
- **Node.js** 22 or newer (the tests use the built-in TypeScript stripping).
- A specialist endpoint. Local llama.cpp, vLLM, LM Studio, Ollama’s
  OpenAI-compatible endpoint, OpenAI, Hugging Face and Replicate are all valid.
- Optional, for batching and video:
  - `ffmpeg` and `ffprobe` — image resize, audio split, video frames/audio;
  - `yt-dlp` — optional, for webpage/YouTube URLs in `video_analyze`;
  - `poppler-utils` (`pdftoppm`, `pdfinfo`) — PDF pages;
  - ImageMagick `identify` — fast image dimensions.

Missing optional tools degrade gracefully: unsupported preprocessing is
reported as a warning and the original file is used where possible.

## Installation

### From git (recommended)

```bash
pi install git:github.com/noguerol/pi-specialists
```

### From a local checkout

```bash
git clone https://github.com/noguerol/pi-specialists.git
cd pi-specialists
pi install .
```

### Manual (settings.json)

Add the package path to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/path/to/pi-specialists"]
}
```

After installing, run `/reload` (or restart pi). Confirm the extension is
loaded with:

```
/specialists status
```

## Quick start

1. Open the configuration menu:

   ```
   /specialists config
   ```

2. Add a specialist. For a local OpenAI-compatible vision server:

   ```
   /specialists add image-to-text "Local vision" http://localhost my-vision-model --port=8080 --key=env:VISION_API_KEY
   ```

3. Use it from the agent:

   ```
   specialist({
     specialist: "Local vision",
     prompt: "Describe this screenshot in detail.",
     input: ["/data/screenshots/app.png"]
   })
   ```

4. Batch a directory or a multipage PDF:

   ```
   specialist({ specialist: "Local vision", prompt: "Extract all text", input: ["/data/invoices"] })
   specialist({ specialist: "Local vision", prompt: "Extract all text", input: ["/data/contract.pdf"] })
   ```

## Configuration

Configuration lives outside the session in:

```
${PI_CODING_AGENT_DIR:-~/.pi/agent}/specialists.json
```

The file is written with mode `0600` (and the directory is created `0700`).
A complete example:

```json
{
  "version": 1,
  "enabled": true,
  "outputDir": "/tmp/pi-specialists",
  "specialists": [
    {
      "name": "Local vision",
      "aliases": ["vision-local"],
      "type": "image-to-text",
      "protocol": "openai-chat",
      "enabled": true,
      "baseUrl": "http://localhost/v1",
      "port": 8080,
      "model": "my-vision-model",
      "apiKey": "env:VISION_API_KEY",
      "auth": { "type": "bearer" },
      "headers": {},
      "query": {},
      "body": { "temperature": 0 },
      "timeoutMs": 120000,
      "waitMs": 250,
      "budget": { "contextTokens": 8192, "maxOutputTokens": 2048 },
      "notes": "Local OpenAI-compatible server"
    }
  ]
}
```

### Specialist fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique name and the reference used by the tool, commands and menu. |
| `aliases` | no | Extra references (case-insensitive; slugs work too). Legacy `id` values are migrated here. |
| `type` | yes | Hugging Face task type or alias (see `src/catalog.ts`). |
| `protocol` | yes | Wire protocol (see [Protocols](#protocols)). |
| `enabled` | yes | Whether the specialist is available. |
| `baseUrl` | yes | Endpoint base. Schemes are optional: `localhost`, `my-host:8080/v1`. |
| `port` | no | Applied on top of `baseUrl`; useful when the host is shared. |
| `path` | no | Overrides the protocol endpoint path. |
| `model` | no | Model id sent to the server (required by `hf-inference` and `replicate`). |
| `apiKey` | no | Literal key, `env:VAR` or `file:/path`. |
| `auth` | no | `bearer`, `header`, `query`, `basic` or `none`. |
| `headers`, `query` | no | Extra HTTP maps merged into every request. |
| `body` | no | Extra JSON merged into the protocol payload. |
| `timeoutMs` | no | Hard HTTP timeout, 1 s – 30 min (default 120 s). |
| `waitMs` | no | Inline grace before returning a background job (default 250 ms; `0` = never block). |
| `budget` | no | Overrides for context/media/batch limits (see [Budgets](#budgets-and-batching)). |
| `notes` | no | Free-form note. |

### Names, aliases and migration

`name` is the identifier. References are matched case-insensitively, by name,
by slug (`"Local vision"` → `local-vision`) and by alias. Renaming a specialist
in the menu keeps the previous name as an alias, so existing prompts and scripts
keep working.

Files from older versions that still contain a separate `id` are migrated on
load: `name` wins, the old id becomes an alias, and the next save omits `id`.

### Base URLs and local hosts

`baseUrl` accepts a bare host or `host:port`; HTTP is inferred:

```text
my-host           → http://my-host
my-host:8080      → http://my-host:8080
my-host:8080/v1   → http://my-host:8080/v1
127.0.0.1:8080    → http://127.0.0.1:8080
[::1]:8080        → http://[::1]:8080
```

A machine’s own Tailscale/MagicDNS name resolves to the tailnet address, while
local runtimes often bind only `127.0.0.1`. For local HTTP hosts the router
detects this and prefers loopback, so the hostname is as fast as `localhost`.
If loopback is refused (the service is bound to the tailnet interface), the
configured host is tried instead. Details include `fallback: "loopback"` and
`configuredUrl`.

This preference only helps **on the same machine**. To reach a service from
another device, bind it to `0.0.0.0` or the tailnet address.

## Specialist types

The type is a Hugging Face pipeline tag (or a practical alias). Families and
representative types:

| Family | Examples |
|---|---|
| Vision | `image-to-text`, `ocr`, `visual-question-answering`, `document-question-answering`, `image-classification`, `object-detection`, `image-segmentation`, `depth-estimation`, `keypoint-detection`, `mask-generation`, `image-feature-extraction` |
| Image | `text-to-image`, `image-to-image`, `unconditional-image-generation` |
| Video | `text-to-video`, `image-to-video`, `video-to-video`, `video-classification` |
| Audio | `automatic-speech-recognition` (`asr`/`stt`), `text-to-speech` (`tts`), `text-to-audio`, `audio-classification`, `audio-to-audio`, `voice-activity-detection` |
| Text | `text-generation`, `summarization`, `translation`, `question-answering`, `text-classification`, `zero-shot-classification`, `token-classification` (`ner`), `feature-extraction` (`embeddings`), `sentence-similarity`, `reranking` |
| Decision models | `system-1` (fast yes/no, choice, score, route) |

Common aliases (`ocr`, `captioning`, `vqa`, `docqa`, `txt2img`, `img2img`,
`tts`, `asr`, `stt`, `ner`, `embeddings`, `rerank`, `system1`, `decision`…)
resolve to the canonical type. The full catalog, including families, emoji and
default protocols, is in [`src/catalog.ts`](src/catalog.ts). The configuration
menu lists every type with its family.

## Protocols

| Protocol | Typical use | Endpoint |
|---|---|---|
| `openai-chat` | vision, OCR, VQA, text generation | `POST /chat/completions` |
| `openai-images` | text-to-image, image editing | `/images/generations`, multipart `/images/edits` |
| `openai-speech` | TTS | `POST /audio/speech` |
| `openai-transcriptions` | STT | multipart `/audio/transcriptions` |
| `openai-embeddings` | embeddings | `POST /embeddings` |
| `hf-inference` | classification, detection, ASR, embeddings | `POST /models/{model}` |
| `replicate` | video, music, audio | `/predictions` with polling |
| `decision` | System-1 transformers sidecars | `POST /decide` with `state` + `questions` + optional `media` |
| `custom-json` | any other JSON API | templated JSON body |

`path` overrides the endpoint (for example when the base URL has no `/v1`).

## Authentication

`auth.type` selects how the key is sent:

| Type | Behaviour |
|---|---|
| `bearer` | `Authorization: Bearer <key>` |
| `header` | `<headerName>: <prefix><key>` (default `X-API-Key`) |
| `query` | `?<queryName>=<key>` (default `api_key`) |
| `basic` | `Authorization: Basic base64(username:key)` |
| `none` | no authentication |

`apiKey` is a reference, not necessarily the secret:

```json
"apiKey": "env:VISION_API_KEY"
"apiKey": "file:/run/secrets/vision"
"apiKey": "literal-key"
```

Prefer `env:` or `file:` so keys never live in the configuration file.

## Budgets and batching

Before expanding a batch, the router asks the server for its limits:

- `GET /props` — llama.cpp `n_ctx` and `modalities`;
- `GET /v1/models` — `meta.n_ctx` or `context_window`;
- for local transformers sidecars, `GET /info` + the model’s `config.json`
  (`text_config.max_position_embeddings`).

The probe is cached for 5 minutes. Failures are not cached, so a starting
server is retried on the next call. Inspect the result with:

```
/specialists probe "Local vision"
```

```
ctx=8192 · out=2048 · img=1600px/2.0MP · audio=30s · items=200 · parallel=1 · mods=vision · source=probe
```

Override any value per specialist:

```json
"budget": {
  "contextTokens": 8192,
  "maxOutputTokens": 2048,
  "maxImageSide": 1600,
  "maxImagePixels": 2000000,
  "maxAudioSeconds": 30,
  "maxItems": 200,
  "maxParallel": 1,
  "pdfDpi": 150
}
```

### Input expansion

| Input | Processing |
|---|---|
| Directory | Recursively expanded (depth 2, hidden files skipped), filtered by the type’s accepted media. |
| PDF | Rasterised page by page with `pdftoppm` at `pdfDpi`; one work item per page. |
| Large image | Resized/recompressed with `ffmpeg` to `maxImageSide` / `maxImagePixels`. |
| Long audio | Normalised to 16 kHz mono and split into `maxAudioSeconds` chunks. |
| Text file | Split at paragraph/sentence boundaries to fit the context minus output reserve. |
| URL / data URI | Materialised to a temporary file first. |

### Batching

- Up to `maxItems` work items, sequential by default (`maxParallel: 1`, best for
  single-slot llama.cpp) or in parallel.
- Each item gets its own request; one failure does not discard the others.
- Results are aggregated under headings such as `## invoice.pdf p.3` or
  `## memo.wav [0:00–0:30]`.
- The complete result is also written to
  `<outputDir>/<timestamp>-<name>-batch.md`; the path is included in the tool
  result.
- The footer line reports progress (`3/20 · invoice.pdf p.3`).
- Up to 4 generated images are attached to the tool result; every output path is
  listed in the details.

### Examples

```ts
// Multipage OCR — one request per page
specialist({ specialist: "OCR", prompt: "Extract all text", input: ["/data/contract.pdf"] })

// A directory of images
specialist({ specialist: "Local vision", prompt: "Describe each image", input: ["/data/photos"] })

// A directory of audio (long files are split)
specialist({ specialist: "ASR", input: ["/data/recordings"] })

// A long text file (chunked to the context)
specialist({ specialist: "Summarizer", prompt: "Summarize", input: ["/data/book.txt"] })
```

### System-1 decision sidecars

The `decision` protocol targets sidecars that run a transformers model with
`system_one` and answer typed questions in a single pass. Send `state` and named
`questions` directly, or through `options`:

```ts
specialist({
  specialist: "Decider",
  state: "I want to cancel my subscription",
  questions: {
    intent: {
      type: "choice",
      instructions: "What does the user want to do?",
      criteria: { cancel: "cancel the subscription", other: "something else" }
    }
  }
})
```

Question types depend on the model (`noul`, `choice`, `score`, `text`, `number`,
`date`, `box`, `boxes`). Images can be passed with `input`; they are sent as
local paths (no base64 round trip) where possible.

## Video analysis

The `video_analyze` tool provides a fast, end-to-end interpretation path for
any video. It accepts a local file, a direct media URL, or a webpage/YouTube URL
(downloaded with `yt-dlp` when available).

1. **Probe** duration, resolution and audio with `ffprobe`.
2. **Sample frames** — by default one frame per second up to 12 frames, then 12
   evenly spaced frames for longer videos. Override with `frames` (1–24) or
   `interval` (seconds). Long videos are sampled with fast per-frame seeks
   instead of decoding the complete timeline.
3. **Describe frames** with the first enabled `image-to-text` specialist (or
   the specialist named in `vision`). Frames are sent through the normal
   budget-aware batch pipeline, so oversized frames are resized.
4. **Transcribe audio** with the first enabled `automatic-speech-recognition`
   specialist (or `stt`). Audio is converted to 16 kHz mono; long audio is
   split according to the ASR budget.
5. **Write a report** with a visual timeline (frame timestamps and
   descriptions) and the transcript. The full markdown report is saved to
   `<outputDir>/<timestamp>-<name>-video.md`.

```ts
video_analyze({
  video: "/data/product-demo.mp4",
  wait: true
})

video_analyze({
  video: "/data/interview.mp4",
  frames: 8,
  vision: "Local vision",
  stt: "Whisper",
  wait: false               // background job; report arrives next turn
})
```

| Parameter | Description |
|---|---|
| `video` | Absolute local path, direct media URL, or webpage/YouTube URL. |
| `prompt` | Optional instruction for the frame/vision specialist. |
| `frames` | Number of frames (1–24). |
| `interval` | Seconds between frames; overrides `frames`. |
| `vision` | Image-to-text specialist name/type. Default: first enabled `image-to-text`. |
| `stt` | ASR specialist name/type. Default: first enabled `automatic-speech-recognition`. |
| `output` | Report path. Default: `outputDir` with a timestamped name. |
| `waitMs` | Inline grace before returning a job (default 500 ms). |
| `wait` | `true` for the complete report inline; `false` for an immediate job. |

If only one of the two specialists is configured, the pipeline still returns
the half it can produce (frames/timeline or transcript) and records a warning.
If neither is configured, it fails with a configuration hint.

For webpage/YouTube URLs the tool uses `yt-dlp`, preferring a 720p video+audio
stream, and reads the title from yt-dlp metadata for the report. Set
`PI_SPECIALISTS_YTDLP` or `YT_DLP` when the binary is not on `PATH`. Without
yt-dlp the tool returns a clear error; direct media URLs and local files still
work. `yt-dlp` may warn that no JavaScript runtime (deno) is installed; most
formats still download, but installing deno enables the full format set.

Video processing requires `ffmpeg`/`ffprobe` (and optionally `yt-dlp` for
webpage URLs); the rest of the extension does not.

The report is designed for the calling agent: it can use the transcript for
spoken content and the timeline for visual context, then write the final
user-facing interpretation. Long reports are truncated in the tool result but
the complete file path is always included.

## Execution model

A tool call waits at most `waitMs` (default **250 ms**):

1. **Fast specialist** — the result is returned inline; details include
   `elapsedMs` and `mode: "inline"`.
2. **Slow specialist** — the call returns a `jobId` in milliseconds with
   `mode: "background"`. The request keeps running; when it finishes, the result
   is delivered as a `specialist-result` message with `deliverAs: "nextTurn"`.
   This does not start or steer a run.
3. `wait: true` blocks until completion (bounded by `timeoutMs`).
4. `wait: false` always returns a job immediately.
5. `action: "result"` collects a job; `action: "jobs"` lists running/recent jobs.

Tool calls use `executionMode: "parallel"`, so independent specialists can run
concurrently. The footer shows one line per running set:

```text
⏳ 👁️ vision-model: Describe the image · sample.jpg 1.4s
⏳ 👁️ vision-model: Describe the image 2.0s · ⚡ Decider: classify the prompt 0.6s
```

The line disappears when the last job finishes; the capability markers
(`👁️● 👂●`) remain in the footer. The running text is drawn first so it is not
truncated behind the markers, and jobs shorter than 700 ms keep the line on
screen for that window so a 35 ms decision is still visible.

## Commands

| Command | Description |
|---|---|
| `/specialists config` | Interactive CRUD menu (add, edit, enable/disable, test, delete, diagnostics). |
| `/specialists on\|off` | Enable/disable the whole extension. |
| `/specialists status` | Configuration summary, path and warnings. |
| `/specialists list` | Configured specialists, types, endpoints, keys (masked). |
| `/specialists add <type> "<name>" <url> [model]` | Add from the CLI. Options: `--port`, `--key`, `--protocol`, `--waitms`, `--notes`. |
| `/specialists remove "<name>"` | Delete a specialist. |
| `/specialists enable\|disable "<name>"` | Toggle a specialist. |
| `/specialists test "<name>" [prompt]` | Run it once through the job registry (shows the live line). Options: `--input`, `--state`, `--questions`. |
| `/specialists probe "<name>"` | Discover and print the server budget. |
| `/specialists reload` | Re-read the configuration file. |
| `/specialists doctor` | Path, mode, writability, disk vs memory, validation, running jobs. |

The interactive menu supports one-level-up navigation: Esc in the type list
returns to the family list; Esc in the edit fields returns to the specialist
list, then to the main menu. The add wizard keeps values when walking back.

## Tool API

```ts
specialist({
  action: "list" | "run" | "result" | "jobs",
  specialist: "<name or type>",
  prompt: "...",
  input: ["/path", "/directory", "/document.pdf"],
  output: "/tmp/result.png",
  state: "...",                       // decision models
  questions: { q: { type: "noul", instructions: "..." } },
  options: { size: "1024x1024" },
  waitMs: 250,
  wait: true,
  jobId: "job-12"
})
```

| Parameter | Description |
|---|---|
| `action` | `list` (default without a specialist), `run`, `result`, `jobs`. |
| `specialist` | Name, alias or type. Ambiguous types require a name. |
| `prompt` | Instruction for the specialist. |
| `input` | Files, directories, PDFs, URLs or data URIs. Accepted media depends on the type. |
| `output` | Output path for the first generated media file. |
| `state` | Context/state for System-1 decision models. |
| `questions` | Named questions for System-1 decision models. |
| `options` | Extra protocol parameters (`size`, `voice`, `language`, `max_tokens`, …). |
| `waitMs` | Inline grace; `0` returns a job immediately. |
| `wait` | `true` block, `false` always background. |
| `jobId` | With `action: "result"`. |

`action: "list"` and `action: "jobs"` return immediately. `action: "result"`
returns a completed job or reports that it is still running.

### Video analysis tool

`video_analyze` is a separate tool registered by the extension. It accepts the
parameters in [Video analysis](#video-analysis) and returns the markdown report
inline (`wait: true`) or a job id that is delivered as a `specialist-result`
message and can be collected with
`specialist({ action: "result", jobId })`. It runs in the same job registry and
live footer line as specialist calls.

## Observability

- **Footer**: capability markers, plus the live running line described above.
- **Tool details**: specialist, type, protocol, model, endpoint, HTTP status,
  elapsed time, budget, fallback, outputs, batch items and warnings.
- **`/specialists list`**: masked keys and effective URLs.
- **`/specialists probe`**: discovered context/media/batch limits.
- **`video_analyze` reports**: timeline + transcript plus the saved report path.
- **`/specialists doctor`**: configuration path, mode, writability, memory vs
  disk, validation and running-job count.
- **Batch result file**: full text at `<outputDir>/…-batch.md`.

## Security

- Configuration is written `0600`; the directory is created `0700`.
- API keys are masked in the menu, status output and tool details.
- Prefer `env:` or `file:` references over inline keys.
- The router sends the contents of input files to the configured endpoint.
  Local endpoints keep files local; remote endpoints do not. Review your
  endpoints and their data policies.
- Loopback preference applies only to `http` and only when the host is the
  current machine; remote hosts are never rewritten. HTTPS is never downgraded.
- No telemetry is collected. The extension makes no requests except to the
  specialist endpoints you configure (budget probes included).
- Treat specialist sidecars as untrusted code: they run with the permissions of
  their server.

## Performance

- The router adds ~1 ms of dispatch overhead; model inference dominates.
- Budget probes are cached for 5 minutes and run only when preprocessing or a
  long prompt needs them.
- Large media is resized/split once, then reused across the batch.
- Sequential execution is the default for single-slot servers; set
  `budget.maxParallel` for servers with multiple slots.
- Background jobs keep the agent responsive; collect only when needed.

## Troubleshooting

**A hostname works with `127.0.0.1` but not with the machine name.**  
The name resolves to a network interface where the service is not listening.
The router detects local HTTP hosts and prefers loopback; if the service is
bound only to a non-loopback interface, bind it to `0.0.0.0` (or the specific
interface) for access from other devices.

**HTTP 401/403.**  
Check `apiKey`, `auth.type`, `headerName`/`queryName`, and whether the key is
available in the process environment (`env:`) or file (`file:`).

**`hf-inference` or `replicate` complains about a missing model.**  
Both protocols require `model`. Set it in the menu or with `--port`/model
arguments.

**PDF processing does nothing.**  
Install `poppler-utils` (`pdftoppm`, `pdfinfo`). The warning includes the
underlying command error.

**Audio is not split.**  
Check `ffmpeg`/`ffprobe` availability and `budget.maxAudioSeconds`; short audio
is sent whole.

**Video analysis fails immediately.**  
Check `ffmpeg`/`ffprobe` availability and that at least one `image-to-text` or
`automatic-speech-recognition` specialist is enabled. The error/warning names
the missing half of the pipeline.

**A YouTube/webpage URL fails.**  
Install `yt-dlp` (or set `PI_SPECIALISTS_YTDLP` / `YT_DLP`), or download the
media and pass the local file. If yt-dlp warns about a missing JavaScript
runtime, install deno for the complete format set; the default 720p selection
usually works without it.

**A batch is truncated.**  
`budget.maxItems` (default 200) caps the number of work items. Raise it or
split the input.

**The result is delivered later than expected.**  
The specialist took longer than `waitMs`; this is the non-blocking path. Use
`wait: true`, raise `waitMs`, or collect with `action: "result"`.

**Configuration changes do not appear.**  
Run `/specialists reload`; `/specialists doctor` shows the effective path and
whether the file is writable.

## Development

The tests use the Node.js test runner and built-in TypeScript stripping; no
build step or runtime dependencies are required.

```bash
npm install
npm test
npm run typecheck
```

`npm test` runs the Node test suite; `npm run typecheck` uses the local
TypeScript compiler. The video tests use ffmpeg to generate a tiny clip. Some tests exercise preprocessing and are skipped automatically when
`ffmpeg`, ImageMagick `convert` or `pdftoppm` are not installed. The suite covers:

- catalog and alias resolution;
- configuration validation, migration and secret references;
- protocol request builders/parsers;
- budget discovery (including local hostname → loopback);
- preprocessing: directories, image resize, audio split, PDF pages, text chunks;
- single and batched execution, aggregation, progress and failures;
- footer formatting and menu navigation.

Repository layout:

```text
src/            extension and pure logic
test/           Node test suite
.github/        CI workflow
```

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report
security issues as described in [SECURITY.md](SECURITY.md).

## Versioning

This project follows [Semantic Versioning](https://semver.org/). See
[CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## License

MIT — see [LICENSE](LICENSE).

---

`pi-specialists` is an independent community extension. Model names and
trademarks belong to their respective owners.
