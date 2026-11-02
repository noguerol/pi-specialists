# Contributing

Thanks for taking the time to improve `pi-specialists`.

## Development setup

Requirements: Node.js 22 or newer.

```bash
git clone https://github.com/noguerol/pi-specialists.git
cd pi-specialists
npm install
npm test
npm run typecheck
```

No runtime dependencies are needed for the test suite. Some preprocessing tests
are skipped automatically when `ffmpeg`, ImageMagick `convert` or `pdftoppm`
are not installed.

## Pull requests

- Keep changes focused; one behaviour per pull request.
- Add or update tests for logic changes.
- Update `README.md` and `CHANGELOG.md` for user-visible changes.
- Keep user-facing strings and documentation in English.
- Do not commit secrets, machine-specific paths, hostnames, local model names or
  generated configuration files.
- Run `npm test` before submitting.

## Code style

- TypeScript, ES modules, two-space indentation, tabs as in the existing files.
- Pure logic belongs in `src/` modules that do not import pi, so it remains
  testable with plain Node.
- Errors should be actionable and must never include secrets.
- Prefer small, composable functions over new dependencies.

## Reporting bugs

Open a GitHub issue with:

- version;
- protocol and specialist type;
- the command or tool call;
- the error message with secrets redacted.

Security issues follow [SECURITY.md](SECURITY.md).
