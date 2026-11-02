# Security policy

## Supported versions

Security fixes are applied to the latest 1.x release.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting:

1. Open the repository's **Security** tab.
2. Select **Advisories** → **Report a vulnerability**.

Include:

- a description of the issue and its impact;
- the affected version and configuration;
- reproduction steps or a proof of concept;
- any suggested mitigation.

You will receive an acknowledgement and a remediation plan. Please allow a
reasonable disclosure window before publishing details.

## Scope

The extension sends prompts and input files to the specialist endpoints you
configure. It does not collect telemetry. Security-relevant areas include:

- secret handling (`apiKey`, `env:` and `file:` references);
- request construction and authentication;
- path handling for directories, PDFs, images and audio;
- loopback detection and URL normalisation;
- parsing untrusted server responses.

Never include real API keys or private data in bug reports, screenshots or
reproduction repositories.
