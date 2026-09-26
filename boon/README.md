# BOON

A chat app that talks to free, open-weights AI models through [OpenRouter](https://openrouter.ai).
It is a single static page (`index.html`) with no build step and no server.

## Run it

1. Get a free OpenRouter key at <https://openrouter.ai/keys> (no card needed).
2. Open `boon/index.html` in a browser, or host the folder anywhere static (GitHub Pages works).
3. Paste the key and your name into Settings. The key is kept in your browser's localStorage only.

## Models

The picker defaults to **GLM-5.2** (Z.ai, MIT-licensed open weights), the highest scorer among
OpenRouter's current free models on the Artificial Analysis Intelligence Index. Also listed:
Qwen 3.8, Nemotron 3 Ultra, Gemma 4 (reads images) and **Auto**, OpenRouter's router across all
free models. Any other free model OpenRouter offers shows up under "More free models", since the
list is fetched live on page load.

If the chosen model is rate-limited or retired, BOON retries once on Auto and says so under the reply.
Free models have per-minute and daily request caps; see
[OpenRouter's limits](https://openrouter.ai/docs/api-reference/limits) for the current numbers.

## Features

- Streaming replies with Markdown, code blocks and tables; a collapsible "Thinking" section for reasoning models
- Pause button stops a reply mid-stream
- `+` attaches images (sent to a vision model) or text/code files (inlined into the prompt)
- Chat history and search, saved in the browser
- Works on phones (sidebar becomes a drawer)
