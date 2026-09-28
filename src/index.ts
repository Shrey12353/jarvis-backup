import { DefaultToolRegistry } from "./tools/types.js";
import type { Tool, DefaultToolRegistry as RegistryType } from "./tools/types.js";
import { shellTool, safeShellTool } from "./tools/shell.js";
import { fsTools } from "./tools/fs.js";
import { gitTools } from "./tools/git.js";
import { deployTools } from "./tools/deploy.js";
import { browserTools } from "./tools/browser.js";
import { vscodeTools } from "./tools/vscode.js";
import { systemTools } from "./tools/system.js";
import { webTools } from "./tools/web.js";
import { gmailTools } from "./tools/gmail.js";
import { calendarTools } from "./tools/calendar.js";
import { imageGenTools } from "./tools/imagegen.js";
import { tradingTools } from "./tools/trading.js";
import { aiTools } from "./tools/ai.js";
import { memoryTools } from "./tools/memory-tools.js";
import { reminderTools } from "./tools/reminders.js";
import { pcTools } from "./tools/pc.js";
import { activityTools } from "./tools/activity.js";

export function buildRegistry(): RegistryType {
  const reg = new DefaultToolRegistry();
  const groups: Tool[][] = [
    [shellTool, safeShellTool],
    fsTools,
    gitTools,
    deployTools,
    browserTools(),
    vscodeTools,
    systemTools,
    webTools,
    gmailTools,
    calendarTools,
    imageGenTools,
    tradingTools,
    aiTools,
    // Personal-assistant layer: memory, reminders, PC awareness, activity log.
    memoryTools,
    reminderTools,
    pcTools,
    activityTools,
  ];
  for (const group of groups) {
    for (const tool of group) reg.register(tool);
  }
  return reg;
}
