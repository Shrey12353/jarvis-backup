/** OS notifications (Windows toast, macOS, Linux) — shared by the notify tool and reminders. */
import { run } from "./proc.js";

/** Clean a string for safe use inside a PowerShell single-quoted literal / shell string. */
function clean(s: string, max: number): string {
  return String(s ?? "")
    .replace(/[\r\n]+/g, " · ")
    .replace(/['"`$\\]/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Show a desktop notification. Returns true when the OS accepted it.
 * Never throws — a failed toast must not break a reminder or a tool call.
 */
export async function showNotification(message: string, title = "Jarvis"): Promise<boolean> {
  const msg = clean(message, 200) || "Jarvis has a message";
  const head = clean(title, 60) || "Jarvis";
  try {
    const cmd =
      process.platform === "win32"
        ? `powershell -NoProfile -Command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${head}'))|Out-Null; $t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('${msg}'))|Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Jarvis.Agent').Show([Windows.UI.Notifications.ToastNotification]::new($t))"`
        : process.platform === "darwin"
          ? `osascript -e 'display notification "${msg}" with title "${head}"'`
          : `notify-send "${head}" "${msg}"`;
    const r = await run(cmd, { timeoutMs: 20_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}
