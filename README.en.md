# English Teaching Workbench

[简体中文](README.md) · [Contributing](CONTRIBUTING.en.md) · [License and attribution](NOTICE.md) · [Interface themes](docs/theme.md)

A local workspace for English teachers. The Classroom module turns authorized materials into interactive HTML and editable PowerPoint decks for K–12 English, TOEFL, and IELTS tracks. The Content module connects to a separately installed self-media-bot. Both share project navigation, result cards, and a saved light/dark preference. The interface is currently in Simplified Chinese.

## Run locally

Use Node.js 24 or newer, Python 3.11 or newer, and OpenSSL. On Windows, the OpenSSL bundled with Git for Windows is supported.

```sh
npm ci
python -m pip install -r requirements.txt
npm run build
npm run setup:local
npm start
```

Open `https://127.0.0.1:8443`. Setup creates a local HTTPS certificate under `.m0-data/`. The server writes an `accounts.json` file there on first run. Select Teacher (`教师`) and use the value of `teacher` as the local passphrase. Use your normal OS or browser procedure to trust the certificate for local development.

In Classroom (`课上`), select a track and upload the [original sample](examples/library-club.txt) to generate and preview a classroom package. Supported inputs include PDF, DOCX, PPTX, TXT, Markdown, PNG, JPEG, and WebP. PDF page ranges are optional and the default is up to the first three pages. The browser uses HTTPS APIs and SSE for task status and results.

## Optional content drafting

Follow the [self-media-bot setup](https://github.com/MkaliezZ/self-media-bot) to install and configure its DeepSeek and media workbench dependencies. Set `M0_BOT_ROOT` to the Bot source checkout before starting this application. See the [upstream baseline and notices](NOTICE.md). Drafting forwards the submitted brief to the configured provider. Classroom generation runs locally.

| Environment variable | Purpose |
|---|---|
| `M0_DATA` | Local data directory, defaults to `.m0-data/` |
| `M0_PORT` | Local HTTPS port, defaults to `8443` |
| `M0_PYTHON` | Python with the required packages, defaults to `python` |
| `M0_OPENSSL` | Override the OpenSSL executable |
| `M0_BOT_ROOT` | Optional self-media-bot source checkout |

## Verification and scope

Run `npm test` after installing dependencies and building the frontend. It uses temporary data to check sign-in, HTML/PPTX generation for all three tracks, and SSE snapshots. This is a loopback-only M0 development prototype. The public repository contains source and an original example. Institution materials, question banks, source-specific lesson examples, historical outputs, accounts, and local runtime data retain their own distribution terms. [Publication inventory](PUBLICATION.json)
