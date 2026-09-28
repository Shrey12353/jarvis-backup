# Jarvis — Local Voice-Controlled AI Agent

A fully local AI agent that runs on your Windows PC (works on macOS/Linux too) and does
things for you: writes and runs code, controls Git/GitHub, deploys to Vercel, manages
Supabase, drives a real browser, opens apps, searches the web — and answers **by voice**.

- **Brain:** a local LLM via [Ollama](https://ollama.com) — nothing leaves your machine
- **Hands:** a tool belt of 25+ tools (shell, filesystem, git/gh, vercel, supabase, browser, VS Code, system, web search)
- **Voice:** wake word ("computer", "jarvis", …) → local speech-to-text → agent → spoken reply
- **Safety:** every tool has a tier — `auto`, `ask` (you approve), `dangerous` (always confirmed), plus a hard deny list

## Quick start

```powershell
# 1. Install Ollama and pull a model (7–8B class recommended)
winget install Ollama.Ollama
ollama pull qwen2.5-coder:7b

# 2. Install CLI tools you want the agent to drive (all optional, checked by `npm run doctor`)
winget install GitHub.cli          # gh — GitHub
npm i -g vercel supabase           # deploy CLIs
npm i playwright && npm run setup:browser   # browser tools (Chromium)

# 3. Configure
copy config.example.yaml config.yaml
copy .env.example .env             # optional: Picovoice key for wake word

# 4. Run
npm install
npm run doctor                     # verifies everything is wired up
npm run chat                       # terminal chat agent
npm run run -- "create a todo app in ./myapp and git init it"
npm run voice                      # wake-word voice mode
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run chat` | Interactive chat; `/tools`, `/new` (clear session), `/auto` (toggle full-auto), `/quit` |
| `npm run run -- "…"` | One-shot request, then exit |
| `npm run voice` | Wake-word mode (Porcupine) with push-to-talk fallback |
| `npm run doctor` | Check Ollama, CLIs, Playwright, env vars |
| `npm test` | Unit tests (deny list, safety gate, config, JSON repair) |

## Tools the agent can use

| Group | Tools | Tier |
| --- | --- | --- |
| Shell | `shell` (any command), `shell_readonly` (whitelisted, no approval) | ask / auto |
| Files | `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files` | auto / ask |
| Git/GitHub | `git_status`, `git_commit`, `git_push`, `github` (any `gh` subcommand) | auto / ask |
| Vercel | `vercel_deploy` (preview or `--prod`), `vercel_status`, arbitrary subcommands | ask / auto |
| Supabase | `supabase` (db push, migrations, functions…), `supabase_status` | ask / auto |
| Browser | `browser_navigate`, `browser_read`, `browser_click`, `browser_type`, `browser_extract`, `browser_screenshot`, `browser_tabs` | auto |
| VS Code | `vscode_open`, `vscode_cmd` (install extensions…) | auto / ask |
| System | `open_url`, `launch_app`, `notify` (Windows toast) | auto / ask |
| Web | `web_search` (DuckDuckGo, no API key) | auto |
| Memory | `remember`, `forget`, `memory_list` — facts about you that survive every chat | auto |
| Reminders | `remind_add`, `remind_list`, `remind_cancel` — Windows toast + chat note, repeats supported | auto |
| This PC | `read_clipboard`, `screenshot_screen` (+ vision model), `list_windows`, `describe_image`, `file_info` | auto |
| Activity | `what_did_you_do` — every action it took today, in plain language | auto |
| Trading | `trade_universe`, `trade_signals`, `trade_compare`, `trade_backtest`, `trade_engine` (paper only) | auto |

The agent decides which tools to call, one step at a time, reading results between calls.
Tool output is truncated before it goes back to the model, and the whole session is
persisted to `data/sessions/session.json` so conversations survive restarts.

## Voice setup

Three optional pieces — the agent degrades gracefully without them:

1. **Wake word** ([Porcupine](https://picovoice.ai), free key): `npm i @picovoice/porcupine-node @picovoice/pvrecorder-node`, put `PICOVOICE_ACCESS_KEY=...` in `.env`. Built-in keywords include `computer`, `jarvis`, `alexa`. Custom phrase? Train a `.ppn` and point `voice.wake_word` at it.
2. **Speech-to-text** — either:
   - [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (recommended): build it, download a `ggml-base.en.bin` model, then set:
     ```yaml
     voice:
       stt:
         command: "D:/tools/whisper.cpp/main.exe -m D:/models/ggml-base.en.bin -nt {wav}"
     ```
   - or Vosk: `npm i vosk`, download the small model, set `voice.stt.vosk_model: models/vosk-model-small-en-us-0.15`
3. **Text-to-speech** — none needed on Windows: the `sapi` engine uses built-in Windows voices.

No wake word installed? `npm run voice` falls back to **push-to-talk**: press Enter, speak, press Enter.

## Safety model

- **`auto`** tools run without asking (reads, searches, navigation).
- **`ask`** tools (shell, writes, commits, pushes, deploys) show you exactly what will run and wait for `y/N`.
- **`dangerous`** tier always confirms — even with full-auto on — unless you set `allow_dangerous: true` in config (at your own risk).
- **Hard deny list**: `rm -rf /`, `format C:`, `del /s`, `shutdown`, `bcdedit`, `vssadmin delete shadows`, `cipher /w`, fork-bomb, raw-disk `dd`, HKLM registry writes — refused in every mode.
- **Full-auto switch**: `--full-auto` flag or `/auto` in chat, or `agent.full_auto: true` in config. Ask-tier tools stop prompting; dangerous ones still don't.

## Architecture

```
src/
  main.ts            CLI entrypoints: chat | voice | run | doctor
  index.ts           tool registry assembly
  core/
    config.ts        config.yaml + .env loader (deep-merged defaults)
    ollama.ts        Ollama HTTP client — streaming chat + native tool calls
    agent.ts         the loop: LLM ⇄ tools ⇄ memory, persisted session
    safety.ts        command classification + approval policy
    proc.ts          hardened process runner (timeouts, output caps)
    logger.ts        data/logs/agent-*.log
  tools/             one module per capability, uniform Tool interface
  voice/
    mic.ts           Porcupine wake word + WAV capture (silence detection)
    stt.ts           whisper.cpp or vosk transcription
    tts.ts           SAPI (Windows) / say / spd-say
    loop.ts          wake → record → transcribe → agent → speak
```

The agent uses Ollama's **native tool-calling** (streamed), so any tool-capable model
works — `qwen2.5-coder:7b`, `llama3.1:8b`, etc. Tune `ollama.model` in `config.yaml`.

## Personal-assistant layer

Built for a non-coder running this on their own PC:

- **Memory** — facts you tell it (or it learns in the background with the local model) live in
  `data/memory/user.md`, a plain file you can read, edit or delete. It is injected into every
  chat, so it stops asking the same questions. The 🧠 Memory panel shows what it knows.
- **Reminders** — "remind me at 6pm" sets a real Windows notification plus a note in the chat.
  Repeats (`daily`, `weekdays`, `weekly`) are supported; they survive reboots because they live in
  `data/reminders.json` and are fired by the UI server's ticker (so keep Jarvis running).
- **Live progress** — long scans/backtests stream "fetching prices: 420 of 2,317" style progress to
  the UI so a 5-minute job never looks stuck.
- **Screen & clipboard** — the 🖥 button (or asking in chat) grabs the screen, the local vision
  model reads it, and Jarvis answers about what you're looking at. `read_clipboard` covers
  "fix this thing I copied".
- **Your own folders** — the agent may READ `~/Downloads`, `~/Desktop`, `~/Documents`, `~/Pictures`
  (configurable via `agent.read_roots`); writes are still confined to the workspace.
- **Activity log** — `data/activity/YYYY-MM-DD.jsonl` plus the 📋 Today panel: exactly what it did,
  when, in plain language (secrets redacted).

## Notes & limits

- Ollama tool calling needs a recent Ollama version and a model that supports tools.
- The `github`/`vercel`/`supabase` tools drive the official CLIs, so auth is whatever those CLIs have (`gh auth login`, `vercel login`, `supabase login` — or env tokens).
- Long-running interactive commands (dev servers) will block until timeout — run them via `start`/background tricks or ask the agent to use `timeout_seconds`.
- Everything the agent does is logged under `data/logs/`; session memory is plain JSON you can inspect or delete.
- Reminders only fire while the UI server runs — the Windows auto-start launcher keeps it running in the
  background, so reminders work after a reboot without opening a window.
- Background fact-learning uses the local model (free, private) and is limited to one run every few minutes.
