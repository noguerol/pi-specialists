# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-11-02

### Added

- `comfyui` protocol: posts a ComfyUI workflow to `/prompt`, polls
  `/history/{prompt_id}` and downloads images from `/view`, with typed
  `{{prompt}}`, `{{negative_prompt}}`, `{{seed}}`, `{{width}}`, `{{height}}`,
  `{{steps}}`, `{{cfg}}` placeholders.
- `image_recreate` tool: captions a source image and regenerates it with a
  text-to-image specialist, preserving the source aspect ratio and output size,
  sanitising aspect-ratio/dimension contradictions, and saving a report.
- Single transformed inputs (one resized image, one PDF page, one text chunk)
  now return the clean model output instead of a batch header/section.
- Image-generation prompts are no longer truncated by the chat context budget.

### Fixed

- The configured image-generation specialist pointed at a dead port; the
  example config now uses the running ComfyUI workflow at 127.0.0.1:8188.

### Verified

- `IMG_8138.jpg` (4032x3024, 4:3) recreated at 1024x768 through Qwen3-VL and
  Qwen-Image/ComfyUI; caption/size/ratio report saved.

## [1.2.0] - 2026-11-02

### Added

- `video_analyze` accepts webpage/YouTube URLs when `yt-dlp` is available
  (`PI_SPECIALISTS_YTDLP`/`YT_DLP` override), downloads a 720p stream, and uses
  the yt-dlp title in the report.
- Long videos are sampled with fast per-frame seeks instead of decoding the
  entire timeline, keeping analysis time bounded.

### Verified

- Real 16:52 YouTube video (1280x720): 12 frames, 9 transcript chunks,
  English transcript, 32 s end-to-end including download.

## [1.1.0] - 2026-11-02

### Added

- `video_analyze` pipeline: probes the video, samples evenly spaced frames
  (1 fps up to 12, then 12 across longer videos), describes them with an
  image-to-text specialist, extracts audio and transcribes it with an ASR
  specialist, and writes a markdown report with a visual timeline and
  transcript.
- Background job integration, live footer progress (`frames`, `vision`,
  `audio`) and `specialist-result` delivery for video analysis.
- Frame/interval overrides, explicit specialist selection, partial results when
  only vision or only ASR is configured, and a saved full report.

## [1.0.1] - 2026-11-02

### Fixed

- The live running line is now part of the primary footer status and is drawn
  first, so it remains visible when the footer is narrow or already shows other
  status markers.
- Jobs shorter than 700 ms keep the frozen line on screen for the remainder of
  that window. Decision and STT specialists answering in 35–100 ms are now
  visible instead of flashing past the first repaint.

## [1.0.0] - 2026-11-02

First public release.

### Added

- Hugging Face task catalog with 35+ specialist types, families, aliases and
  per-type defaults.
- Nine wire protocols: OpenAI-compatible chat/images/speech/transcriptions/
  embeddings, Hugging Face Inference, Replicate, System-1 `decision` sidecars
  and templated custom JSON.
- Flexible authentication: bearer, custom header, query parameter, basic auth
  or none; secrets via literal, `env:VAR` or `file:/path`.
- Budget discovery from `/props`, `/v1/models` and local transformers
  `config.json`, with per-specialist overrides and a `/specialists probe`
  command.
- Input preprocessing: directory expansion, PDF page rasterisation, image
  resize/recompression, audio splitting and text chunking.
- Budget-aware batching with sequential/parallel execution, partial failure
  handling, aggregated result sections and a full-result markdown file.
- Non-blocking execution: inline grace period (`waitMs`), background jobs,
  next-turn `specialist-result` delivery and job collection actions.
- Live footer line with specialist, task summary and wallclock time.
- Interactive configuration menu with hierarchical Esc navigation and a
  step-back add wizard.
- Operational commands: `on`/`off`, `config`, `status`, `list`, `add`,
  `remove`, `enable`/`disable`, `test`, `probe`, `reload` and `doctor`.
- Scheme-less base URLs and loopback preference for local hostnames.
- Test suite covering logic, protocols, budgets, preprocessing, batching and
  menu navigation.

[1.3.0]: https://github.com/noguerol/pi-specialists/releases/tag/v1.3.0
[1.2.0]: https://github.com/noguerol/pi-specialists/releases/tag/v1.2.0
[1.1.0]: https://github.com/noguerol/pi-specialists/releases/tag/v1.1.0
[1.0.1]: https://github.com/noguerol/pi-specialists/releases/tag/v1.0.1
[1.0.0]: https://github.com/noguerol/pi-specialists/releases/tag/v1.0.0
