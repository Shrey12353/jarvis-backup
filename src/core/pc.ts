/**
 * PC-level helpers for a real desktop assistant: capture the screen, read the
 * clipboard, list open windows. All read-only and local; the PowerShell scripts
 * live in scripts/ so nothing is assembled from escaped strings at runtime.
 */
import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runArgv } from "./proc.js";

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
export const SCREENSHOT_SCRIPT = path.join(SCRIPTS_DIR, "pc-screenshot.ps1");
export const CLIPBOARD_SCRIPT = path.join(SCRIPTS_DIR, "read-clipboard.ps1");
export const WINDOWS_SCRIPT = path.join(SCRIPTS_DIR, "list-windows.ps1");

/**
 * Run a PowerShell script with argv (no shell at all) — cmd.exe mangles the
 * nested quotes in paths, argv never does.
 */
const ps = (script: string, args: string[] = []): Promise<import("./proc.js").RunResult> =>
  runArgv(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]);

/** True when the current OS can run the PowerShell helpers. */
export function pcHelpersSupported(): boolean {
  return process.platform === "win32";
}

/** Grab the whole screen into <workspace>/screens/ and return the absolute path. */
export async function captureScreen(workspace: string): Promise<string> {
  if (!pcHelpersSupported()) throw new Error("Screen capture is only supported on Windows.");
  const dir = path.join(workspace, "screens");
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(dir, `screen-${stamp}.png`);
  const r = await ps(SCREENSHOT_SCRIPT, [out]);
  if (!existsSync(out)) {
    throw new Error(`screen capture failed: ${(r.stderr || r.stdout).trim().slice(0, 200) || "no image was produced"}`);
  }
  return out;
}

/** Current clipboard text (empty string when the clipboard holds no text). */
export async function readClipboardText(): Promise<string> {
  if (!pcHelpersSupported()) return "";
  const r = await ps(CLIPBOARD_SCRIPT);
  if (r.code !== 0) throw new Error(`could not read the clipboard: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return r.stdout.replace(/\r\n/g, "\n").trim();
}

/** Open windows as "app: title" lines. */
export async function listOpenWindows(): Promise<string> {
  if (!pcHelpersSupported()) return "";
  const r = await ps(WINDOWS_SCRIPT);
  const text = (r.stdout || "").replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error(`could not list windows: ${(r.stderr || "").trim().slice(0, 200) || "no windows reported"}`);
  return text;
}
