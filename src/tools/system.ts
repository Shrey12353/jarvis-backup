import { run } from "../core/proc.js";
import type { Tool } from "./types.js";

export const systemTools: Tool[] = [
  {
    name: "open_url",
    description: "Open a URL in the user's default browser (their normal profile, not the agent's Playwright browser).",
    safety: "auto",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(args) {
      const url = String(args.url);
      const cmd = process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
      const r = await run(cmd, { timeoutMs: 15_000 });
      return r.code === 0 ? `Opened ${url}` : `Failed: ${(r.stderr || r.stdout).trim()}`;
    },
  },
  {
    name: "launch_app",
    description: "Launch an installed application by name (e.g. spotify, notepad, chrome, explorer).",
    safety: "ask",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run(args) {
      const name = String(args.name).replace(/[&|<>^"]/g, "");
      const cmd = process.platform === "win32"
        ? `start "" "${name}"`
        : process.platform === "darwin"
          ? `open -a "${name}"`
          : name;
      const res = await run(cmd, { timeoutMs: 15_000 });
      return res.code === 0 ? `Launched ${name}` : `Could not launch "${name}": ${(res.stderr || res.stdout).trim()}`;
    },
  },
  {
    name: "notify",
    description: "Show a Windows toast/notification (or OS equivalent) with a message.",
    safety: "auto",
    parameters: { type: "object", properties: { message: { type: "string" }, title: { type: "string" } }, required: ["message"] },
    async run(args) {
      const msg = String(args.message).replace(/"/g, "'").slice(0, 200);
      const title = String(args.title || "Jarvis").replace(/"/g, "'").slice(0, 60);
      const cmd = process.platform === "win32"
        ? `powershell -NoProfile -Command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${title}'))|Out-Null; $t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('${msg}'))|Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Jarvis.Agent').Show([Windows.UI.Notifications.ToastNotification]::new($t))"`
        : process.platform === "darwin"
          ? `osascript -e 'display notification "${msg}" with title "${title}"'`
          : `notify-send "${title}" "${msg}"`;
      const r = await run(cmd, { timeoutMs: 20_000 });
      return r.code === 0 ? "Notification sent" : `Notify failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`;
    },
  },
];
