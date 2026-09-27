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

Tap the cube button next to `+` to switch the composer into Create mode. Both steps run open-weights
models on free Hugging Face Spaces, so no key is needed.

1. Describe something and BOON makes an image with [FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell)
   (Apache-2.0). Or attach your own image instead. A [Pollinations](https://enter.pollinations.ai) key in Settings
   adds a backup image source.
2. Tap **Make 3D model** and BOON turns the image into a mesh with [Hunyuan3D-2](https://github.com/Tencent/Hunyuan3D-2)
   (Hunyuan3D-2.1 as backup). It removes the background itself; an object on a plain background works best.
3. The result shows in a 3D viewer you can drag to spin. **Download .stl (3D print)** saves a slicer-ready STL, stood
   upright with its longest side scaled to 100 mm (resize it in your slicer). **Download .glb** saves the original for Blender or games.
   The mesh is untextured (white).

The free Spaces share GPU time, so they have a daily limit. Adding a free Hugging Face token in Settings raises it.

## Agent mode (tools)

Tap the robot button next to the cube to switch the composer into Agent mode. Give BOON a task and it works
through it with tools, showing every step as a timeline: what it thought, which tool it used, what came back,
then the answer. Today's tools are a calculator, a bill splitter (tip, tax, people), the date and time, counting days
between dates, adding days to a date, and reminders; more come later.

**Reminders.** "Remind me at 8:52 am to study" or "remind me in 10 minutes to stretch" sets a reminder that rings at that
exact minute: a chime, a pop-up with Snooze and Done, and a system notification if you allow them. The Reminders button
in the sidebar lists and cancels them. They are saved in the browser and ring while BOON is open in a tab (it can be in
the background); one that came due while BOON was closed rings the next time you open it. The alarm keeps beeping
until you press Snooze or Done.

**School or Hagwon focus.** When a reminder is school work or marked important, its pop-up asks where you are:

- **School** opens your math class in Google Classroom (paste its link in Settings) and starts a focus timer for the
  reminder's length (at least 10 minutes). Only that class, pages you open from it (Docs, Drive, attachments, and
  links from the class, which then stay on their own site), email (Gmail, Outlook), calculators (Desmos,
  calculator.net) and BOON are allowed.
- **Hagwon** opens a YouTube mix (change it in Settings) for 25 minutes. YouTube stays on that mix: no Shorts, no
  other videos, no home page. A calculator and BOON are also allowed.

Anything else sends you back, and `chrome://` pages (like the extensions page) are blocked during focus. Other
windows showing a locked site are minimized and tabs playing sound are muted until focus ends.

**The island.** A small floating pill at the top of every page shows the time left, and you can drag it anywhere.
Its **Turn off** button (or Turn off in BOON's focus bar) ends focus early, but only after you solve a hard
Algebra 1-2 question: 5 minutes, 3 tries, and every other tab (BOON included) is locked while it's open. Solve it
and focus is off; miss it and focus keeps going, and you can try again later for a new question. The questions are
made by code from their answers (quadratics, systems, exponents, logs, radicals, absolute value, vertex form,
sequences, the remainder theorem, complex numbers), so the answer is always exact and no AI is involved.

The locking and the island need the **BOON Focus** Chrome add-on in `boon/extension` (one-time setup):

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `boon/extension` folder.
4. Reload BOON.

After pulling a new version of BOON, click the reload arrow on the BOON Focus card in `chrome://extensions`.
To lock Incognito windows too, click **Details** on the card and turn on **Allow in Incognito**.
Without the add-on, School and Hagwon still open the link and run the timer, and BOON asks you to go back if you
return early, but it can't stop you switching tabs. The add-on only acts during a focus session. It works inside
Chrome only: other Mac apps (like Calculator) are never blocked.

**Safety stop.** The add-on never closes a tab or window. If it can't open or show your work tab (or the question)
three times within two minutes, it turns focus off by itself and BOON shows "Focus stopped", so Chrome keeps working.
If Chrome ever still gets stuck, quit it (⌘Q), rename the `boon/extension` folder (for example to `extension-off`) and
open Chrome again; rename it back and click reload on the card to turn the add-on on again.

Agent mode needs a model that can call tools. Gemma 3 can't, so BOON uses Qwen3 on your computer:

```sh
ollama pull qwen3:8b
```

If a tool-capable model is picked in the model picker, BOON uses that one instead. Without a local one, it uses
the cloud model (needs the OpenRouter key). The pause button stops a task, and a task stops by itself after 20 steps.

## Features

- Streaming replies with Markdown, code blocks and tables; a collapsible "Thinking" section for reasoning models
- Pause button stops a reply mid-stream
- `+` attaches images (sent to a vision model) or text/code files (inlined into the prompt)
- Chat history and search, saved in the browser
- Works on phones (sidebar becomes a drawer)
