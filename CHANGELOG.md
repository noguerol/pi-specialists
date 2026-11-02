# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

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

[1.1.0]: https://github.com/noguerol/pi-specialists/releases/tag/v1.1.0
[1.0.1]: https://github.com/noguerol/pi-specialists/releases/tag/v1.0.1
[1.0.0]: https://github.com/noguerol/pi-specialists/releases/tag/v1.0.0
