# Jarvis Relay — the 24/7 cloud twin

A tiny, dependency-free Node app that gives Jarvis an always-on presence:
Telegram bot + reminders + cloud-brain chat, running on a ~$5/month VPS.

## How the two Jarvises divide the work

| | Home Jarvis (your PC) | Jarvis Cloud (VPS relay) |
|---|---|---|
| Chat brain | Groq cloud + local Ollama fallback | Same Groq cloud brain |
| Telegram | @steelshreybot (linked to your phone) | its OWN bot (create below) |
| Reminders | fire only while the PC is on | **fire 24/7, pushed to your phone** |
| PC hands (screen, files, Gmail browser, voice, trading) | ✅ | ❌ (twin says so honestly) |

Both bots use the same owner-linking protocol: first `/start` claims; sending
`/link <pin>` from another chat moves ownership (pins are independent per bot).

## Deploy (10 minutes, once)

1. **Get a tiny VPS** — any provider works (Hetzner CX11, DigitalOcean,
   Linode, Oracle free tier). Ubuntu 24.04, 1 GB RAM is plenty.

2. **Create the cloud bot** — in Telegram, message **@BotFather** →
   `/newbot` → name it (e.g. "Jarvis Cloud") → copy the new token.

3. **Install Node and the relay** on the VPS:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
   sudo apt-get install -y nodejs
   sudo mkdir -p /opt/jarvis-relay && sudo chown $USER /opt/jarvis-relay
   # copy jarvis-relay/relay.mjs and relay.env.example to /opt/jarvis-relay
   cd /opt/jarvis-relay
   mv relay.env.example .env   # then paste the two keys into it
   ```

4. **Run it under systemd** (auto-restart = true 24/7):
   ```bash
   sudo tee /etc/systemd/system/jarvis-relay.service > /dev/null <<'EOF'
   [Unit]
   Description=Jarvis Relay (24/7 Telegram twin)
   After=network-online.target

   [Service]
   User=YOUR_VPS_USERNAME
   WorkingDirectory=/opt/jarvis-relay
   EnvironmentFile=/opt/jarvis-relay/.env
   Environment=TZ=Asia/Kolkata
   ExecStart=/usr/bin/node /opt/jarvis-relay/relay.mjs
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl daemon-reload
   sudo systemctl enable --now jarvis-relay
   journalctl -u jarvis-relay -f        # watch the log; note the pairing PIN
   ```

5. **Link your phone** — send `/start` to the new cloud bot, or
   `/link <pin-from-the-log>` to move an existing link. Then:
   `/remind in 8 hours take medicines` — it fires even with your PC off.

## Upgrading the relay

Copy the new `relay.mjs` over the old one, then
`sudo systemctl restart jarvis-relay`. State (`data.json` — owner, reminders,
history) survives restarts; missed reminders fire immediately on boot.

## Notes

- `TZ=Asia/Kolkata` makes every reminder time YOUR local time.
- Groq free tier limits still apply (the relay retries once on 429).
- The chat history is a light 12-turn window — the twin is for talk + timers,
  not deep work. Deep work still belongs to home Jarvis.
