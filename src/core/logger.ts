import { promises as fs } from "node:fs";
import path from "node:path";
import { nowStamp } from "./util.js";

let logFile: string | null = null;
let queue: Promise<void> = Promise.resolve();

export function initLogging(dataDir: string): string {
  const dir = path.join(dataDir, "logs");
  logFile = path.join(dir, `agent-${nowStamp()}.log`);
  fs.mkdir(dir, { recursive: true }).catch(() => {});
  return logFile;
}

export async function log(line: string, level: "info" | "warn" | "error" = "info"): Promise<void> {
  const stamped = `[${new Date().toISOString()}] [${level}] ${line}`;
  if (level === "error") console.error(stamped);
  else console.log(stamped);
  if (logFile) {
    queue = queue.then(() => fs.appendFile(logFile!, stamped + "\n").catch(() => {}));
    await queue;
  }
}
