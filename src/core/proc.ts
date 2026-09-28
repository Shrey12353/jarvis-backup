import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** true = platform shell; string = specific shell executable */
  shell?: boolean | string;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function fileExists(f: string): boolean {
  try {
    accessSync(f, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the first shell executable that actually exists. A stale COMSPEC or a
 * broken PATH previously surfaced as the cryptic "spawn cmd.exe ENOENT".
 */
function resolveWindowsShell(): string {
  const root = process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    process.env.COMSPEC,
    path.join(root, "System32", "cmd.exe"),
    "cmd.exe",
  ].filter((x): x is string => !!x);
  return candidates.find(fileExists) ?? candidates[candidates.length - 1];
}

/** cwd must exist, or Node reports a misleading ENOENT on the shell executable. */
function cwdProblem(cwd: string | undefined): string | null {
  if (!cwd) return null;
  return fileExists(cwd) ? null : `working directory does not exist: ${cwd}`;
}

function shellFor(shell: boolean | string | undefined): string | undefined {
  if (shell === false) return undefined;
  if (typeof shell === "string") return shell;
  return isWindows() ? process.env.COMSPEC || "cmd.exe" : "/bin/bash";
}

function shellArgs(cmd: string): { shell: string | undefined; args: string[] } {
  if (!isWindows()) return { shell: "/bin/bash", args: ["-lc", cmd] };
  const shell = process.env.COMSPEC || "cmd.exe";
  return { shell, args: ["/d", "/s", "/c", cmd] };
}

/** Run a command in the platform shell. Captured output; kills on timeout. */
export function run(cmd: string, opts: RunOptions = {}): Promise<RunResult> {
  const { cwd, timeoutMs = 120_000, env, shell } = opts;
  const cwdErr = cwdProblem(cwd);
  if (cwdErr) return Promise.resolve({ stdout: "", stderr: cwdErr, code: 127, timedOut: false });
  const { shell: sh, args } = shellArgs(cmd);
  const shellExe = isWindows() ? (typeof shell === "string" ? shell : resolveWindowsShell()) : sh!;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shellExe, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (e) {
      resolve({ stdout: "", stderr: String(e), code: 127, timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(0, 100_000) + "\n...[truncated]...\n" + stdout.slice(-100_000);
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(0, 50_000) + "\n...[truncated]...\n" + stderr.slice(-50_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      const enoent = (e as NodeJS.ErrnoException).code === "ENOENT";
      const hint = enoent
        ? ` (could not start "${shellExe}"${cwd ? ` in cwd "${cwd}"` : ""} — check the cwd exists and the shell is available)`
        : "";
      resolve({ stdout, stderr: stderr + `${(e as NodeJS.ErrnoException).code === "ENOENT" ? "spawn ENOENT" : String(e)}${hint}`, code: 127, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/** Run without a shell (argv array). Used for direct CLIs where quoting matters. */
export function runArgv(argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const cwdErr = cwdProblem(opts.cwd);
  if (cwdErr) return Promise.resolve({ stdout: "", stderr: cwdErr, code: 127, timedOut: false });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      resolve({ stdout: "", stderr: String(e), code: 127, timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 120_000);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      const enoent = (e as NodeJS.ErrnoException).code === "ENOENT";
      const hint = enoent ? ` (executable "${argv[0]}" not found${opts.cwd ? ` in cwd "${opts.cwd}"` : ""})` : "";
      resolve({ stdout, stderr: stderr + `${enoent ? "spawn ENOENT" : String(e)}${hint}`, code: 127, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}
