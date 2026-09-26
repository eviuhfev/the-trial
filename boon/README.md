# BOON

A chat app for open-source AI models. It runs them either on your own computer with
[Ollama](https://github.com/ollama/ollama) (no key, nothing leaves your machine) or free in the cloud
through [OpenRouter](https://openrouter.ai). It is a single static page (`index.html`) with no build step.

## Run a model on your computer (no key)

1. Install Ollama from <https://ollama.com/download>.
2. Pull an open-source model, e.g. `ollama pull gemma3` (Google's open Gemma 3; pick a size your GPU fits,
   such as `gemma3:4b`, `gemma3:12b` or `gemma3:27b`).
3. Serve BOON (below) and open it. Every model Ollama has installed appears under "On this computer"
   in the model picker and is picked by default.

## Run it

1. For cloud models, get a free OpenRouter key at <https://openrouter.ai/keys> (no card needed).
2. Serve it locally on port 6999 from the repo root, then open <http://localhost:6999>:
   ```sh
   python -m http.server 6999 --bind 127.0.0.1 --directory boon
   # or: npx serve -l 6999 boon
   ```
   Opening `boon/index.html` directly or hosting the folder anywhere static (GitHub Pages) also works.
3. Paste the key (if using cloud models) and your name into Settings. The key is kept in your browser's localStorage only.

## Cloud models

Without a local model, the picker defaults to **GLM-5.2** (Z.ai, MIT-licensed open weights), one of the strongest
open-weights models on OpenRouter's free list (it scores 34 on the Artificial Analysis Intelligence
Index, against 23 for Nemotron 3 Ultra). Also listed:
Qwen 3.8, Nemotron 3 Ultra, Gemma 4 (reads images) and **Auto**, OpenRouter's router across all
free models. Any other free model OpenRouter offers shows up under "More free models", since the
list is fetched live on page load.

If the chosen model is rate-limited or retired, BOON retries once on Auto and says so under the reply.
Free models have per-minute and daily request caps; see
[OpenRouter's limits](https://openrouter.ai/docs/api-reference/limits) for the current numbers.

## Create: image to 3D

Tap the cube button next to `+` to switch the composer into Create mode.

1. Describe something and BOON generates an image with [Pollinations](https://github.com/pollinations/pollinations)
   (open source, free, no key). Or attach your own image instead.
2. Tap **Make 3D model** and BOON sends the image to an open-weights image-to-3D model on a free Hugging Face
   Space: [Stable Fast 3D](https://github.com/Stability-AI/stable-fast-3d) first, then
   [Hunyuan3D-2](https://github.com/Tencent/Hunyuan3D-2) if that one is busy or down.
3. The result shows in a 3D viewer you can drag to spin. **Download .glb** saves it for Blender, games or 3D printing.

The free Spaces share GPU time, so they have a daily limit. Adding a free Hugging Face token in Settings raises it.

## Features

- Streaming replies with Markdown, code blocks and tables; a collapsible "Thinking" section for reasoning models
- Pause button stops a reply mid-stream
- `+` attaches images (sent to a vision model) or text/code files (inlined into the prompt)
- Chat history and search, saved in the browser
- Works on phones (sidebar becomes a drawer)
