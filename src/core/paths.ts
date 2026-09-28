import { promises as fs } from "node:fs";
import path from "node:path";

export async function ensureDirs(dataDir: string): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join(dataDir, "logs"), { recursive: true }),
    fs.mkdir(path.join(dataDir, "sessions"), { recursive: true }),
    fs.mkdir(path.join(dataDir, "screenshots"), { recursive: true }),
  ]);
}
