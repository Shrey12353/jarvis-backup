/**
 * Office & visual tools — so Jarvis can work with real documents and pictures
 * of data instead of only plain text.
 *
 *   read_spreadsheet   Excel (.xlsx/.xls/.ods) and CSV/TSV → a markdown table
 *   write_spreadsheet  write .xlsx / .csv / .ods from rows or CSV text
 *   make_chart         bar / line / area / pie / donut → an SVG picture
 *   make_diagram       flow / architecture boxes with arrows → an SVG picture
 *
 * Charts and diagrams are generated as SVG with no native dependency, so they
 * work offline and render inline in the Jarvis UI (which serves workspace files
 * through /api/serve-attachment).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { confineToWorkspace, resolveReadablePath, resolveReadRoots } from "../core/config.js";
import type { Tool, ToolContext } from "./types.js";
import * as XLSX from "xlsx";

const PALETTE = ["#7c6cf6", "#4b6bfb", "#2dd4bf", "#f59e0b", "#f2555f", "#a78bfa", "#34d399", "#60a5fa"];

const MAX_CELLS = 2_000;

// ---------- small helpers ----------

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Pick a fresh file name so repeated calls never clobber earlier output. */
function uniqueName(dir: string, base: string, ext: string): Promise<string> {
  return (async () => {
    let name = `${base}${ext}`;
    let n = 1;
    while (true) {
      try {
        await fs.access(path.join(dir, name));
      } catch {
        return path.join(dir, name);
      }
      name = `${base}-${++n}${ext}`;
    }
  })();
}

/**
 * Charts and diagrams are always SVG. Models like to invent a path ending in
 * .png — writing SVG bytes into a .png file makes the UI serve it as an image
 * that never loads, so force the extension instead of trusting the argument.
 */
function asSvgPath(p: string): string {
  return /\.svg$/i.test(p) ? p : p.replace(/\.[a-z0-9]+$/i, "") + ".svg";
}

function resolveWritePath(ctx: ToolContext, p: string): string {
  const confined = confineToWorkspace(p, ctx.cfg.agent.workspace);
  if (!confined) {
    throw new Error(`Refused: I can only write inside my workspace (${ctx.cfg.agent.workspace}). Use a relative path.`);
  }
  return confined;
}

function resolveReadPath(ctx: ToolContext, p: string): string {
  const abs = resolveReadablePath(p, ctx.cfg.agent.workspace, resolveReadRoots(ctx.cfg));
  if (!abs) {
    throw new Error(`Refused: "${p}" is outside what I may read (my workspace plus your Downloads/Desktop/Documents/Pictures).`);
  }
  return abs;
}

function rel(ctx: ToolContext, abs: string): string {
  return path.relative(ctx.cfg.agent.workspace, abs).replace(/\\/g, "/");
}

/** Rows → a GitHub-flavoured markdown table (renders as a real table in the UI). */
function toMarkdownTable(rows: unknown[][], hasHeader: boolean): string {
  if (!rows.length) return "(empty sheet)";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: unknown[]) => Array.from({ length: width }, (_, i) => cell(r[i]).replace(/\|/g, "\\|").replace(/\n+/g, " "));
  const head = pad(hasHeader ? rows[0] : Array.from({ length: width }, (_, i) => `Col ${i + 1}`));
  const body = (hasHeader ? rows.slice(1) : rows).map(pad);
  const out = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const r of body) out.push(`| ${r.join(" | ")} |`);
  return out.join("\n");
}

// ---------- SVG charts ----------

interface Series {
  name: string;
  values: number[];
}

function normalizeChartData(args: Record<string, unknown>): { labels: string[]; series: Series[] } {
  const labels = Array.isArray(args.labels) ? args.labels.map((l) => String(l)) : [];
  let series: Series[] = [];
  if (Array.isArray(args.series) && args.series.length) {
    series = (args.series as Array<{ name?: unknown; values?: unknown }>).map((s, i) => ({
      name: String(s?.name ?? `Series ${i + 1}`),
      values: (Array.isArray(s?.values) ? (s!.values as unknown[]) : []).map(num),
    }));
  } else if (Array.isArray(args.values)) {
    series = [{ name: String(args.series_name ?? args.title ?? "Value"), values: (args.values as unknown[]).map(num) }];
  }
  if (!labels.length) {
    const len = Math.max(0, ...series.map((s) => s.values.length));
    for (let i = 0; i < len; i++) labels.push(String(i + 1));
  }
  return { labels, series };
}

function wrapText(text: string, max: number): string[] {
  const words = String(text).split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function svgShell(width: number, height: number, title: string, body: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, system-ui, sans-serif">`,
    `<defs>`,
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#12141c"/><stop offset="1" stop-color="#0a0c11"/></linearGradient>`,
    `<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7c6cf6"/><stop offset="1" stop-color="#4b6bfb"/></linearGradient>`,
    `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7c6cf6"/></marker>`,
    `</defs>`,
    `<rect width="${width}" height="${height}" fill="url(#bg)"/>`,
    title ? `<text x="40" y="46" fill="#e9ecf3" font-size="24" font-weight="600">${esc(title)}</text>` : "",
    body,
    `</svg>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function barLineAreaSvg(type: string, title: string, labels: string[], series: Series[]): string {
  const W = 1000;
  const H = 580;
  const pad = { l: 78, r: 40, t: title ? 92 : 54, b: 96 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const all = series.flatMap((s) => s.values);
  const vmax = Math.max(0, ...all);
  const vmin = Math.min(0, ...all);
  const span = vmax - vmin || 1;
  const y = (v: number) => pad.t + ((vmax - v) / span) * plotH;
  const parts: string[] = [];

  // gridlines + y labels
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = vmin + (span * i) / ticks;
    const gy = y(v);
    parts.push(`<line x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${W - pad.r}" y2="${gy.toFixed(1)}" stroke="#ffffff18"/>`);
    const lbl = Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 100) / 100);
    parts.push(`<text x="${pad.l - 12}" y="${(gy + 4).toFixed(1)}" fill="#8b93a8" font-size="13" text-anchor="end">${esc(lbl)}</text>`);
  }
  // zero line
  if (vmin < 0) parts.push(`<line x1="${pad.l}" y1="${y(0).toFixed(1)}" x2="${W - pad.r}" y2="${y(0).toFixed(1)}" stroke="#ffffff44"/>`);

  const n = Math.max(1, labels.length);
  const slot = plotW / n;
  const x = (i: number) => pad.l + slot * i + slot / 2;

  // x labels
  const step = Math.ceil(n / 14);
  labels.forEach((l, i) => {
    if (i % step) return;
    const short = l.length > 12 ? l.slice(0, 11) + "…" : l;
    parts.push(`<text x="${x(i).toFixed(1)}" y="${pad.t + plotH + 26}" fill="#8b93a8" font-size="13" text-anchor="middle">${esc(short)}</text>`);
  });

  if (type === "bar") {
    const groupW = slot * 0.68;
    const barW = groupW / series.length;
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const bx = x(i) - groupW / 2 + barW * si;
        const top = Math.min(y(v), y(0));
        const hgt = Math.max(1, Math.abs(y(v) - y(0)));
        parts.push(`<rect x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, barW - 6).toFixed(1)}" height="${hgt.toFixed(1)}" rx="5" fill="${PALETTE[si % PALETTE.length]}" opacity="0.92"/>`);
      });
    });
  } else {
    series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      if (type === "area") {
        const base = y(Math.max(0, vmin)).toFixed(1);
        parts.push(`<path d="M ${x(0).toFixed(1)},${base} L ${pts.join(" L ")} L ${x(s.values.length - 1).toFixed(1)},${base} Z" fill="${color}" opacity="0.22"/>`);
      }
      parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
      s.values.forEach((v, i) => parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${color}"/>`));
    });
  }

  // legend (multi-series only)
  if (series.length > 1) {
    series.forEach((s, si) => {
      const lx = pad.l + si * 190;
      const ly = H - 34;
      parts.push(`<rect x="${lx}" y="${ly - 11}" width="14" height="14" rx="3" fill="${PALETTE[si % PALETTE.length]}"/>`);
      parts.push(`<text x="${lx + 22}" y="${ly + 2}" fill="#c9d0de" font-size="13">${esc(s.name.slice(0, 22))}</text>`);
    });
  }
  return svgShell(W, H, title, parts.join("\n"));
}

function pieSvg(type: string, title: string, labels: string[], series: Series[]): string {
  const W = 1000;
  const H = 580;
  const s = series[0] ?? { name: "Value", values: [] };
  const total = s.values.reduce((a, v) => a + Math.abs(v), 0) || 1;
  const cx = 330;
  const cy = H / 2 + 10;
  const r = 190;
  const inner = type === "donut" ? 110 : 0;
  const parts: string[] = [];
  let angle = -Math.PI / 2;
  s.values.forEach((v, i) => {
    const frac = Math.abs(v) / total;
    const a2 = angle + frac * Math.PI * 2;
    const x1 = cx + Math.cos(angle) * r;
    const y1 = cy + Math.sin(angle) * r;
    const x2 = cx + Math.cos(a2) * r;
    const y2 = cy + Math.sin(a2) * r;
    const large = frac > 0.5 ? 1 : 0;
    const color = PALETTE[i % PALETTE.length];
    const d =
      inner > 0
        ? `M ${cx + Math.cos(angle) * inner} ${cy + Math.sin(angle) * inner} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${cx + Math.cos(a2) * inner} ${cy + Math.sin(a2) * inner} A ${inner} ${inner} 0 ${large} 0 ${cx + Math.cos(angle) * inner} ${cy + Math.sin(angle) * inner} Z`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    parts.push(`<path d="${d}" fill="${color}" opacity="0.94" stroke="#0a0c11" stroke-width="2"/>`);
    if (frac > 0.04) {
      const mid = (angle + a2) / 2;
      const px = cx + Math.cos(mid) * r * 0.68;
      const py = cy + Math.sin(mid) * r * 0.68;
      parts.push(`<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" fill="#0a0c11" font-size="15" font-weight="700" text-anchor="middle">${Math.round(frac * 100)}%</text>`);
    }
    angle = a2;
  });
  // legend
  labels.forEach((l, i) => {
    const ly = 110 + i * 30;
    parts.push(`<rect x="640" y="${ly - 12}" width="15" height="15" rx="3" fill="${PALETTE[i % PALETTE.length]}"/>`);
    const pct = Math.round((Math.abs(s.values[i] ?? 0) / total) * 100);
    parts.push(`<text x="666" y="${ly + 1}" fill="#c9d0de" font-size="14">${esc(l.slice(0, 26))} — ${pct}%</text>`);
  });
  return svgShell(W, H, title, parts.join("\n"));
}

// ---------- SVG diagram ----------

interface Node {
  id: string;
  label: string;
}
interface Edge {
  from: string;
  to: string;
  label?: string;
}

function diagramSvg(title: string, nodes: Node[], edges: Edge[]): string {
  // Longest-path layering left → right, so a flow reads like a pipeline.
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (!indeg.has(e.to) || !adj.has(e.from)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.get(e.from)!.push(e.to);
  }
  const level = new Map<string, number>();
  const roots = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const queue = (roots.length ? roots : nodes.slice(0, 1).map((n) => n.id)).map((id) => ({ id, lv: 0 }));
  for (const n of nodes) level.set(n.id, 0);
  while (queue.length) {
    const { id, lv } = queue.shift()!;
    if (lv > (level.get(id) ?? 0)) level.set(id, lv);
    for (const next of adj.get(id) ?? []) queue.push({ id: next, lv: lv + 1 });
  }
  // Group by level (cap at 5 columns for readability).
  const byLevel = new Map<number, Node[]>();
  for (const n of nodes) {
    const lv = Math.min(level.get(n.id) ?? 0, 4);
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(n);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const boxW = 200;
  const boxH = 66;
  const gapX = 96;
  const gapY = 26;
  const padX = 40;
  const padTop = title ? 96 : 40;
  const maxRows = Math.max(...levels.map((lv) => byLevel.get(lv)!.length));
  const H = Math.max(300, padTop + maxRows * boxH + (maxRows - 1) * gapY + 70);
  const W = Math.max(600, padX * 2 + levels.length * boxW + (levels.length - 1) * gapX);
  const pos = new Map<string, { x: number; y: number }>();
  levels.forEach((lv, col) => {
    const group = byLevel.get(lv)!;
    const blockH = group.length * boxH + (group.length - 1) * gapY;
    const y0 = padTop + (H - padTop - 70 - blockH) / 2;
    group.forEach((n, row) => {
      pos.set(n.id, { x: padX + col * (boxW + gapX), y: y0 + row * (boxH + gapY) });
    });
  });
  const parts: string[] = [];
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + boxW;
    const y1 = a.y + boxH / 2;
    const x2 = b.x;
    const y2 = b.y + boxH / 2;
    const mx = (x1 + x2) / 2;
    parts.push(`<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="#7c6cf6" stroke-width="2.5" marker-end="url(#arrow)" opacity="0.85"/>`);
    if (e.label) parts.push(`<text x="${mx}" y="${(y1 + y2) / 2 - 8}" fill="#8b93a8" font-size="12" text-anchor="middle">${esc(e.label)}</text>`);
  }
  for (const n of nodes) {
    const p = pos.get(n.id)!;
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${boxW}" height="${boxH}" rx="14" fill="#1a1e2b" stroke="#7c6cf6" stroke-opacity="0.5"/>`);
    const lines = wrapText(n.label, 24).slice(0, 3);
    const startY = p.y + boxH / 2 - ((lines.length - 1) * 16) / 2 + 5;
    lines.forEach((ln, i) => parts.push(`<text x="${p.x + boxW / 2}" y="${startY + i * 16}" fill="#e9ecf3" font-size="14" text-anchor="middle">${esc(ln)}</text>`));
  }
  return svgShell(Math.round(W), Math.round(H), title, parts.join("\n"));
}

// ---------- tools ----------

export const officeTools: Tool[] = [
  {
    name: "read_spreadsheet",
    description:
      "Read an Excel workbook (.xlsx/.xls/.ods) or a CSV/TSV file and return the rows as a markdown table. Use this for any spreadsheet or CSV, including ones in the user's Downloads folder.",
    safety: "auto",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Spreadsheet path (relative to workspace or absolute)" },
        sheet: { type: "string", description: "Sheet name (default: the first sheet)" },
        max_rows: { type: "number", description: "Max data rows to return (default 200)" },
        header_row: { type: "boolean", description: "Treat the first row as column names (default true)" },
      },
      required: ["path"],
    },
    async run(args, ctx) {
      const abs = resolveReadPath(ctx, String(args.path));
      const buf = await fs.readFile(abs);
      const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
      if (!wb.SheetNames.length) return "(no sheets found)";
      const sheetName = args.sheet ? String(args.sheet) : wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      if (!ws) return `No sheet named "${sheetName}". Sheets: ${wb.SheetNames.join(", ")}`;
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: "" }) as unknown[][];
      const limit = Math.max(1, Math.min(Number(args.max_rows ?? 200) || 200, 1_000));
      const rows = aoa.slice(0, limit + 1).slice(0, MAX_CELLS);
      const header = args.header_row === false ? false : true;
      const note =
        aoa.length > rows.length ? `\n\n(showing ${rows.length} of ${aoa.length} rows — raise max_rows for more)` : "";
      const sheets = wb.SheetNames.length > 1 ? `\n\nSheets in this file: ${wb.SheetNames.join(", ")}` : "";
      return `${sheetName}:\n${toMarkdownTable(rows, header)}${note}${sheets}`;
    },
  },
  {
    name: "write_spreadsheet",
    description:
      "Create a real spreadsheet file (.xlsx, .csv or .ods) from rows of data. Pass rows as an array of arrays (first row = headers). Use this whenever the user asks for Excel or a CSV.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Output path ending in .xlsx, .csv or .ods (e.g. reports/sales.xlsx)" },
        rows: { type: "array", description: "Array of rows; each row is an array of cell values", items: { type: "array" } },
        csv: { type: "string", description: "Alternatively, raw CSV text to convert" },
        sheet: { type: "string", description: "Sheet name (default Sheet1)" },
      },
      required: ["path"],
    },
    async run(args, ctx) {
      const abs = resolveWritePath(ctx, String(args.path));
      const ext = path.extname(abs).toLowerCase();
      const bookType = ext === ".csv" ? "csv" : ext === ".ods" ? "ods" : "xlsx";
      let aoa: unknown[][] = [];
      if (Array.isArray(args.rows) && args.rows.length) {
        aoa = (args.rows as unknown[][]).map((r) => (Array.isArray(r) ? r : [r]));
      } else if (typeof args.csv === "string" && args.csv.trim()) {
        const parsed = XLSX.read(args.csv, { type: "string" });
        aoa = XLSX.utils.sheet_to_json<unknown[]>(parsed.Sheets[parsed.SheetNames[0]], { header: 1, blankrows: false, defval: "" }) as unknown[][];
      } else {
        throw new Error("Provide either `rows` or `csv`.");
      }
      if (!aoa.length) throw new Error("No data to write.");
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa as unknown[][]);
      XLSX.utils.book_append_sheet(wb, ws, String(args.sheet || "Sheet1").slice(0, 31));
      const out = XLSX.write(wb, { bookType, type: "buffer" }) as Buffer;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, out);
      const cols = Math.max(...aoa.map((r) => r.length));
      return `Wrote ${rel(ctx, abs)} — ${aoa.length} rows x ${cols} columns (${Math.round(out.length / 1024)} KB).`;
    },
  },
  {
    name: "make_chart",
    description:
      "Draw a bar, line, area, pie or donut chart from data and save it as an SVG picture in the workspace. ALWAYS use this when the user asks for a chart, graph or plot.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "bar | line | area | pie | donut" },
        title: { type: "string", description: "Chart title" },
        labels: { type: "array", description: "Category labels along the x-axis / pie slices", items: { type: "string" } },
        values: { type: "array", description: "Numbers for a single series", items: { type: "number" } },
        series: {
          type: "array",
          description: "Multiple series: [{name, values:[...]}] (bar/line/area only)",
          items: { type: "object" },
        },
        series_name: { type: "string", description: "Name for the single series (for the legend)" },
        path: { type: "string", description: "Output path; always saved as .svg (default charts/<slug>.svg)" },
      },
      required: ["type", "labels"],
    },
    async run(args, ctx) {
      const type = String(args.type || "bar").toLowerCase();
      const { labels, series } = normalizeChartData(args);
      if (!series.length || !series.some((s) => s.values.length)) {
        throw new Error("No data: pass `values` (single series) or `series` (multiple).");
      }
      // Pie/donut are single-series only — fold extras into the first.
      const usable = type === "pie" || type === "donut" ? [series[0]] : series;
      const title = String(args.title ?? "");
      const svg =
        type === "pie" || type === "donut"
          ? pieSvg(type, title, labels, usable)
          : barLineAreaSvg(type === "line" || type === "area" ? type : "bar", title, labels, usable);
      let abs: string;
      if (args.path) {
        abs = resolveWritePath(ctx, asSvgPath(String(args.path)));
      } else {
        const dir = resolveWritePath(ctx, "charts");
        await fs.mkdir(dir, { recursive: true });
        const slug = (title || type).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || type;
        abs = await uniqueName(dir, slug, ".svg");
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, svg, "utf8");
      const r = rel(ctx, abs);
      return `Chart saved to ${r}. To show it in your reply, include this exactly: ![${title || "chart"}](local:${r})`;
    },
  },
  {
    name: "make_diagram",
    description:
      "Draw a flowchart / block diagram (boxes joined by arrows) and save it as an SVG picture. Use for process flows, architecture and step-by-step diagrams. Give either `steps` (a simple chain) or `nodes` + `edges`.",
    safety: "ask",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Diagram title" },
        steps: { type: "array", description: "Simple left-to-right chain of step labels", items: { type: "string" } },
        nodes: { type: "array", description: "Boxes: [{id, label}]", items: { type: "object" } },
        edges: { type: "array", description: "Arrows: [{from, to, label?}] (ids from nodes)", items: { type: "object" } },
        path: { type: "string", description: "Output path; always saved as .svg (default diagrams/<slug>.svg)" },
      },
      required: [],
    },
    async run(args, ctx) {
      let nodes: Node[] = [];
      let edges: Edge[] = [];
      if (Array.isArray(args.steps) && args.steps.length) {
        nodes = (args.steps as unknown[]).map((s, i) => ({ id: `s${i + 1}`, label: String(s) }));
        edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
      } else if (Array.isArray(args.nodes) && args.nodes.length) {
        nodes = (args.nodes as Array<{ id?: unknown; label?: unknown }>).map((n, i) => ({
          id: String(n?.id ?? `n${i + 1}`),
          label: String(n?.label ?? n?.id ?? `Step ${i + 1}`),
        }));
        edges = (Array.isArray(args.edges) ? (args.edges as Array<{ from?: unknown; to?: unknown; label?: unknown }>) : []).map((e) => ({
          from: String(e?.from ?? ""),
          to: String(e?.to ?? ""),
          label: e?.label === undefined ? undefined : String(e.label),
        }));
      } else {
        throw new Error("Give `steps`, or `nodes` with `edges`.");
      }
      const title = String(args.title ?? "");
      const svg = diagramSvg(title, nodes, edges);
      let abs: string;
      if (args.path) {
        abs = resolveWritePath(ctx, asSvgPath(String(args.path)));
      } else {
        const dir = resolveWritePath(ctx, "diagrams");
        await fs.mkdir(dir, { recursive: true });
        const slug = (title || "diagram").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "diagram";
        abs = await uniqueName(dir, slug, ".svg");
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, svg, "utf8");
      const r = rel(ctx, abs);
      return `Diagram saved to ${r} (${nodes.length} boxes, ${edges.length} arrows). To show it in your reply, include this exactly: ![${title || "diagram"}](local:${r})`;
    },
  },
];
