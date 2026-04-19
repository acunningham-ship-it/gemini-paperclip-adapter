# gemini-paperclip-adapter

> Paperclip adapter for Google Gemini's free LLM tier.

Paperclip adapter for Google Gemini API direct. Free tier with generous daily quota. No Hermes wrapper bugs.

## Status

🚧 **v0.0.1 — scaffold only.** Implementation in progress.

Part of the [Free LLM Adapter Pack](https://github.com/acunningham-ship-it) for Paperclip.

## Authentication

Set environment variable:

```bash
export GEMINI_API_KEY=your_key_here
```

## Installation (when v1 ships)

```bash
npm install -g gemini-paperclip-adapter
```

## Agent configuration

```json
{
  "adapterType": "gemini_local",
  "adapterConfig": {
    "model": "gemini-2.5-flash",
    "timeoutSec": 300
  }
}
```

## Available free models

See `FREE_MODELS` in `src/shared/constants.ts`.

## Roadmap

- v0.0.1 (now) — scaffold + README
- v0.5.0 — execute.ts MVP
- v1.0.0 — production-ready, launches with Free LLM Adapter Pack

## License

MIT — Armani Cunningham, 2026.
