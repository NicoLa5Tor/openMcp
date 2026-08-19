import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TimelogEntry } from "./types.js";

const GALLERY_DIR = join(tmpdir(), "openproject-timelog-gallery");

export type GalleryGroupBy = "workPackageId" | "projectId" | "activityId" | "none";

export interface GalleryOptions {
  groupBy: GalleryGroupBy;
  title?: string;
  status: string;
}

// Pares [fondo, texto] para las badges de grupo; se ciclan si hay más grupos que colores.
const PALETTE: [string, string][] = [
  ["#1e3a5f", "#60a5fa"],
  ["#1a3a2a", "#4ade80"],
  ["#3b2a1a", "#fb923c"],
  ["#3a1e3a", "#e879f9"],
  ["#1a2f3a", "#22d3ee"],
  ["#3a1e1e", "#f87171"],
  ["#2a2a1a", "#facc15"],
  ["#1e2a3a", "#818cf8"],
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function groupKey(e: TimelogEntry, groupBy: GalleryGroupBy): string {
  switch (groupBy) {
    case "workPackageId":
      return e.workPackageId !== undefined ? `WP ${e.workPackageId}` : "Sin asignar";
    case "projectId":
      return e.projectId !== undefined ? `Proyecto ${e.projectId}` : "Sin proyecto";
    case "activityId":
      return e.activityId !== undefined ? `Actividad ${e.activityId}` : "Sin actividad";
    case "none":
    default:
      return "Todas";
  }
}

/** Genera el HTML autocontenido de la galería a partir de las entries dadas. */
export function buildGalleryHtml(
  entries: TimelogEntry[],
  opts: GalleryOptions,
): string {
  const title = opts.title ?? "Bitácora de horas";
  const totalHours = entries.reduce((a, e) => a + e.hours, 0);
  const dates = entries.map((e) => e.spentOn).sort();
  const period = dates.length > 0 ? `${dates[0]} → ${dates[dates.length - 1]}` : "—";

  const groupsMap = new Map<string, TimelogEntry[]>();
  for (const e of entries) {
    const key = groupKey(e, opts.groupBy);
    const arr = groupsMap.get(key) ?? [];
    arr.push(e);
    groupsMap.set(key, arr);
  }
  const groupKeys = [...groupsMap.keys()];

  const statCards = [
    { label: "Total horas", value: `${totalHours.toFixed(1)}h` },
    { label: "Entradas", value: String(entries.length) },
    ...groupKeys.map((k) => {
      const es = groupsMap.get(k)!;
      const h = es.reduce((a, e) => a + e.hours, 0);
      return { label: k, value: `${h.toFixed(1)}h` };
    }),
    { label: "Período", value: period },
  ]
    .map(
      (c) => `
    <div class="stat">
      <div class="stat-label">${escapeHtml(c.label)}</div>
      <div class="stat-value">${escapeHtml(c.value)}</div>
    </div>`,
    )
    .join("");

  const filterButtons =
    opts.groupBy === "none"
      ? ""
      : [
          `<button class="filter-btn active" data-filter="all" type="button">Todas (${entries.length})</button>`,
          ...groupKeys.map((k) => {
            const count = groupsMap.get(k)!.length;
            return `<button class="filter-btn" data-filter="${escapeHtml(
              k,
            )}" type="button">${escapeHtml(k)} (${count})</button>`;
          }),
        ].join("\n");

  const rows = entries
    .map((e, i) => {
      const key = groupKey(e, opts.groupBy);
      const idx = groupKeys.indexOf(key);
      const [bg, fg] = PALETTE[idx % PALETTE.length];
      const time = e.startTime
        ? `${e.startTime}${e.endTime ? `–${e.endTime}` : ""}`
        : "—";
      return `
    <tr data-group="${escapeHtml(key)}">
      <td class="idx">${i + 1}</td>
      <td class="date">${escapeHtml(e.spentOn)}</td>
      <td class="time">${escapeHtml(time)}</td>
      <td class="hours">${e.hours}h</td>
      <td><span class="badge" style="background:${bg};color:${fg}">${escapeHtml(
        key,
      )}</span></td>
      <td class="desc">${escapeHtml(e.description || "(sin descripción)")}</td>
      <td><span class="badge badge-${e.status}">${e.status}</span></td>
    </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #0f1117; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 4px; color: #f8fafc; }
  .subtitle { font-size: 0.85rem; color: #94a3b8; margin-bottom: 20px; }

  .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { background: #1e2535; border: 1px solid #2d3748; border-radius: 10px; padding: 14px 20px; min-width: 140px; }
  .stat-label { font-size: 0.72rem; color: #64748b; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
  .stat-value { font-size: 1.5rem; font-weight: 700; color: #38bdf8; font-variant-numeric: tabular-nums; }

  .filters { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-btn { background: #1e2535; border: 1px solid #2d3748; border-radius: 6px; color: #94a3b8; font-size: 0.8rem; padding: 6px 14px; cursor: pointer; transition: all .15s; }
  .filter-btn:hover, .filter-btn.active { background: #38bdf8; color: #0f1117; border-color: #38bdf8; font-weight: 600; }
  .filter-btn:focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }

  .table-wrap { overflow-x: auto; border-radius: 12px; border: 1px solid #2d3748; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  thead tr { background: #1e2535; }
  th { padding: 11px 14px; text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: .06em; color: #64748b; white-space: nowrap; border-bottom: 1px solid #2d3748; }
  tbody tr { border-bottom: 1px solid #1e2535; transition: background .1s; }
  tbody tr:hover { background: #1a2033; }
  td { padding: 10px 14px; vertical-align: middle; }
  td.idx { color: #475569; font-size: .75rem; }
  td.desc { max-width: 420px; line-height: 1.45; color: #cbd5e1; }

  .badge { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 0.72rem; font-weight: 600; white-space: nowrap; }
  .badge-pending { background: #2d2a1a; color: #fbbf24; }
  .badge-sent { background: #1a3a2a; color: #4ade80; }
  .hours { font-weight: 700; color: #f8fafc; text-align: right; font-variant-numeric: tabular-nums; }
  .time { color: #64748b; font-size: 0.75rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .date { white-space: nowrap; color: #94a3b8; font-variant-numeric: tabular-nums; }

  @media (prefers-reduced-motion: reduce) {
    .filter-btn { transition: none; }
    tbody tr { transition: none; }
  }
</style>
</head>
<body>

<h1>${escapeHtml(title)}</h1>
<p class="subtitle">${entries.length} entradas · Estado: ${escapeHtml(opts.status)}</p>

<div class="stats">${statCards}</div>

<div class="filters">
${filterButtons}
</div>

<div class="table-wrap">
<table>
  <thead>
    <tr>
      <th>#</th>
      <th>Fecha</th>
      <th>Horario</th>
      <th>Horas</th>
      <th>Grupo</th>
      <th>Descripción</th>
      <th>Estado</th>
    </tr>
  </thead>
  <tbody id="tbody">${rows}</tbody>
</table>
</div>

<script>
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const f = btn.dataset.filter;
    document.querySelectorAll('#tbody tr').forEach((row) => {
      row.style.display = (f === 'all' || row.dataset.group === f) ? '' : 'none';
    });
  });
});
</script>
</body>
</html>
`;
}

/** Escribe el HTML de la galería a un fichero temporal y devuelve su ruta absoluta. */
export async function writeGalleryFile(html: string): Promise<string> {
  await mkdir(GALLERY_DIR, { recursive: true });
  const filePath = join(GALLERY_DIR, `gallery-${randomUUID()}.html`);
  await writeFile(filePath, html, "utf8");
  return filePath;
}
