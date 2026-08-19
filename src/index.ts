#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  assignWorkPackage,
  clearSent,
  createEntry,
  deleteEntry,
  getEntry,
  listEntries,
  markSent,
  updateEntry,
} from "./store.js";
import {
  OpenProjectClient,
  OpenProjectError,
  idFromHref,
  iso8601ToHours,
  matchActivity,
  readConfig,
} from "./openproject.js";
import { buildGalleryHtml, writeGalleryFile } from "./gallery.js";
import type { TimelogEntry } from "./types.js";

// ---------- helpers de formato ----------

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function formatEntry(e: TimelogEntry): string {
  const parts = [
    `• [${e.status}] ${e.id}`,
    `    ${e.hours}h · ${e.spentOn}${
      e.startTime ? ` (${e.startTime}${e.endTime ? `–${e.endTime}` : ""})` : ""
    }`,
    `    ${e.description || "(sin descripción)"}`,
    `    WP: ${e.workPackageId ?? "—"} · Proyecto: ${
      e.projectId ?? "—"
    } · Actividad: ${e.activityId ?? "—"}`,
  ];
  if (e.status === "sent") {
    parts.push(
      `    Enviada: ${e.sentAt ?? "?"} · OpenProject TE id: ${
        e.openprojectTimeEntryId ?? "?"
      }`,
    );
  }
  return parts.join("\n");
}

function groupLabel(
  e: TimelogEntry,
  groupBy: "workPackageId" | "projectId" | "activityId" | "spentOn",
): string {
  switch (groupBy) {
    case "workPackageId":
      return e.workPackageId !== undefined ? `WP ${e.workPackageId}` : "Sin asignar";
    case "projectId":
      return e.projectId !== undefined ? `Proyecto ${e.projectId}` : "Sin proyecto";
    case "activityId":
      return e.activityId !== undefined ? `Actividad ${e.activityId}` : "Sin actividad";
    case "spentOn":
      return e.spentOn;
  }
}

/** Devuelve un cliente configurado o lanza un error legible. */
function requireClient(): OpenProjectClient {
  const config = readConfig();
  if (!config) {
    throw new OpenProjectError(
      "OpenProject no está configurado. Define las variables de entorno OPENPROJECT_URL y OPENPROJECT_API_KEY.",
    );
  }
  return new OpenProjectClient(config);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Resuelve un nombre de actividad (ej. "Especificación") al activityId de
 * OpenProject. Lanza un error legible si no hay match único.
 */
async function resolveActivityByName(
  client: OpenProjectClient,
  name: string,
): Promise<number> {
  const activities = await client.getActivities();
  const resolved = matchActivity(activities, name);
  if (resolved.status === "found") return resolved.id;
  if (resolved.status === "ambiguous") {
    const options = resolved.candidates
      .map((a) => `"${a.name}" (id ${a.id})`)
      .join(", ");
    throw new Error(
      `La actividad "${name}" es ambigua, coincide con: ${options}. Sé más específico o usa activityId directamente.`,
    );
  }
  const options = resolved.available.map((a) => `"${a.name}" (id ${a.id})`).join(", ");
  throw new Error(
    `No existe una actividad llamada "${name}" en OpenProject. Disponibles: ${options}.`,
  );
}

// ---------- servidor ----------

const server = new McpServer({
  name: "openproject-timelog",
  version: "0.1.0",
});

// 1. log_entry
server.registerTool(
  "log_entry",
  {
    title: "Registrar entrada en la bitácora",
    description:
      "Registra una entrada de horas en la bitácora local. Si no se indica workPackageId queda pendiente de asignar (con assign_entry).",
    inputSchema: {
      description: z.string().describe("Qué se hizo"),
      hours: z.number().positive().describe("Horas en decimal (1.5 = 1h30m)"),
      workPackageId: z.number().int().positive().optional(),
      projectId: z.number().int().positive().optional(),
      activityId: z.number().int().positive().optional(),
      activityName: z
        .string()
        .optional()
        .describe(
          "Nombre de la actividad tal como aparece en OpenProject (ej. 'Especificación'); alternativa a activityId, se resuelve automáticamente. Ignorado si activityId ya viene indicado.",
        ),
      spentOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Fecha YYYY-MM-DD (por defecto hoy)"),
      startTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
      endTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
    },
  },
  async ({ activityName, ...args }) => {
    try {
      let activityId = args.activityId;
      if (activityId === undefined && activityName) {
        activityId = await resolveActivityByName(requireClient(), activityName);
      }
      const entry = await createEntry({ ...args, activityId });
      return text(`Entry creada:\n${formatEntry(entry)}`);
    } catch (err) {
      return errorText(`No se pudo crear la entry: ${describeError(err)}`);
    }
  },
);

// 2. list_entries
server.registerTool(
  "list_entries",
  {
    title: "Listar entradas de la bitácora",
    description:
      "Lista las entries de la bitácora local filtrando por status, opcionalmente agrupadas.",
    inputSchema: {
      status: z
        .enum(["pending", "sent", "all"])
        .default("pending")
        .describe("Filtro de estado"),
      groupBy: z
        .enum(["workPackageId", "projectId", "activityId", "spentOn"])
        .optional()
        .describe("Agrupa el resultado por este campo (con subtotales)"),
    },
  },
  async ({ status, groupBy }) => {
    try {
      const entries = await listEntries(status);
      if (entries.length === 0) {
        return text(`No hay entries con status '${status}'.`);
      }
      const totalHours = entries.reduce((acc, e) => acc + e.hours, 0);
      const header = `${entries.length} entr${
        entries.length === 1 ? "y" : "ies"
      } (${status}) · ${totalHours.toFixed(2)}h en total`;

      if (!groupBy) {
        return text(header + "\n\n" + entries.map(formatEntry).join("\n\n"));
      }

      const groups = new Map<string, TimelogEntry[]>();
      for (const e of entries) {
        const key = groupLabel(e, groupBy);
        const arr = groups.get(key) ?? [];
        arr.push(e);
        groups.set(key, arr);
      }
      const lines = [header, ""];
      for (const [key, es] of groups) {
        const groupHours = es.reduce((acc, e) => acc + e.hours, 0);
        lines.push(
          `— ${key} — ${es.length} entr${
            es.length === 1 ? "y" : "ies"
          } · ${groupHours.toFixed(2)}h`,
        );
        lines.push(...es.map(formatEntry), "");
      }
      return text(lines.join("\n"));
    } catch (err) {
      return errorText(`No se pudieron listar las entries: ${describeError(err)}`);
    }
  },
);

// 3. edit_entry
server.registerTool(
  "edit_entry",
  {
    title: "Editar una entrada pendiente",
    description:
      "Edita campos de una entry con status 'pending'. Solo se aplican los campos indicados.",
    inputSchema: {
      id: z.string().describe("Id de la entry"),
      description: z.string().optional(),
      hours: z.number().positive().optional(),
      workPackageId: z.number().int().positive().optional(),
      projectId: z.number().int().positive().optional(),
      activityId: z.number().int().positive().optional(),
      activityName: z
        .string()
        .optional()
        .describe(
          "Nombre de la actividad tal como aparece en OpenProject; alternativa a activityId, se resuelve automáticamente. Ignorado si activityId ya viene indicado.",
        ),
      spentOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      startTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
      endTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
    },
  },
  async ({ id, activityName, ...update }) => {
    try {
      let activityId = update.activityId;
      if (activityId === undefined && activityName) {
        activityId = await resolveActivityByName(requireClient(), activityName);
      }
      const entry = await updateEntry(id, { ...update, activityId });
      return text(`Entry actualizada:\n${formatEntry(entry)}`);
    } catch (err) {
      return errorText(`No se pudo editar la entry: ${describeError(err)}`);
    }
  },
);

// 4. assign_entry
server.registerTool(
  "assign_entry",
  {
    title: "Asignar work package a entries",
    description:
      "Asigna un workPackageId a una o varias entries pendientes (por sus ids).",
    inputSchema: {
      entryIds: z.array(z.string()).min(1),
      workPackageId: z.number().int().positive(),
    },
  },
  async ({ entryIds, workPackageId }) => {
    try {
      const { updated, notFound, skipped } = await assignWorkPackage(
        entryIds,
        workPackageId,
      );
      const lines = [
        `Asignadas ${updated.length} entries al work package ${workPackageId}.`,
      ];
      if (notFound.length > 0) {
        lines.push(`No encontradas: ${notFound.join(", ")}`);
      }
      if (skipped.length > 0) {
        lines.push(`Omitidas (ya enviadas): ${skipped.join(", ")}`);
      }
      if (updated.length > 0) {
        lines.push("", ...updated.map(formatEntry));
      }
      return text(lines.join("\n"));
    } catch (err) {
      return errorText(`No se pudo asignar: ${describeError(err)}`);
    }
  },
);

// 5. delete_entry
server.registerTool(
  "delete_entry",
  {
    title: "Borrar una entrada pendiente",
    description: "Borra una entry con status 'pending'.",
    inputSchema: {
      id: z.string(),
    },
  },
  async ({ id }) => {
    try {
      const removed = await deleteEntry(id);
      return text(`Entry borrada:\n${formatEntry(removed)}`);
    } catch (err) {
      return errorText(`No se pudo borrar la entry: ${describeError(err)}`);
    }
  },
);

// 6. get_projects
server.registerTool(
  "get_projects",
  {
    title: "Listar proyectos de OpenProject",
    description: "Obtiene los proyectos disponibles en OpenProject.",
    inputSchema: {},
  },
  async () => {
    try {
      const client = requireClient();
      const projects = await client.getProjects();
      const rows = projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p._links?.status?.title ?? p.status ?? null,
      }));
      return json(rows);
    } catch (err) {
      return errorText(`No se pudieron obtener los proyectos: ${describeError(err)}`);
    }
  },
);

// 7. get_work_packages
server.registerTool(
  "get_work_packages",
  {
    title: "Listar work packages de OpenProject",
    description:
      "Obtiene tareas/work packages, opcionalmente filtradas por proyecto, status o assignee.",
    inputSchema: {
      projectId: z.number().int().positive().optional(),
      status: z.string().optional().describe("Id de status para filtrar"),
      assignee: z.string().optional().describe("Id de usuario assignee"),
    },
  },
  async (opts) => {
    try {
      const client = requireClient();
      const wps = await client.getWorkPackages(opts);
      const rows = wps.map((w) => ({
        id: w.id,
        subject: w.subject,
        status: w._links?.status?.title ?? null,
        assignee: w._links?.assignee?.title ?? null,
        project: w._links?.project?.title ?? null,
      }));
      return json(rows);
    } catch (err) {
      return errorText(
        `No se pudieron obtener los work packages: ${describeError(err)}`,
      );
    }
  },
);

// 8. get_activities
server.registerTool(
  "get_activities",
  {
    title: "Listar actividades de time entry",
    description: "Obtiene las actividades disponibles para registrar tiempo.",
    inputSchema: {},
  },
  async () => {
    try {
      const client = requireClient();
      const activities = await client.getActivities();
      return json(activities.map((a) => ({ id: a.id, name: a.name })));
    } catch (err) {
      return errorText(
        `No se pudieron obtener las actividades: ${describeError(err)}`,
      );
    }
  },
);

// 9. get_time_entries
server.registerTool(
  "get_time_entries",
  {
    title: "Consultar horas registradas en OpenProject",
    description:
      "Consulta time entries ya registradas en OpenProject, con filtros opcionales.",
    inputSchema: {
      projectId: z.number().int().positive().optional(),
      workPackageId: z.number().int().positive().optional(),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    },
  },
  async (opts) => {
    try {
      const client = requireClient();
      const entries = await client.getTimeEntries(opts);
      const rows = entries.map((e) => ({
        id: e.id,
        hours: iso8601ToHours(e.hours) ?? e.hours,
        spentOn: e.spentOn,
        comment: e.comment?.raw ?? "",
        workPackage: e._links?.workPackage?.title ?? null,
        project: e._links?.project?.title ?? null,
        activity: e._links?.activity?.title ?? null,
        user: e._links?.user?.title ?? null,
      }));
      const total = rows.reduce(
        (acc, r) => acc + (typeof r.hours === "number" ? r.hours : 0),
        0,
      );
      return text(
        `${rows.length} time entries · ${total.toFixed(2)}h\n\n` +
          JSON.stringify(rows, null, 2),
      );
    } catch (err) {
      return errorText(
        `No se pudieron obtener las time entries: ${describeError(err)}`,
      );
    }
  },
);

// 10. upload_entries
server.registerTool(
  "upload_entries",
  {
    title: "Subir entries a OpenProject",
    description:
      "Sube a OpenProject las entries indicadas (o todas las pending con workPackageId si se omite entryIds). Cada entry necesita workPackageId y activityId.",
    inputSchema: {
      entryIds: z
        .array(z.string())
        .optional()
        .describe(
          "Ids a subir; si se omite, sube todas las pending con workPackageId asignado",
        ),
    },
  },
  async ({ entryIds }) => {
    try {
      const client = requireClient();
      const pending = await listEntries("pending");

      let candidates: TimelogEntry[];
      const notFound: string[] = [];
      if (entryIds && entryIds.length > 0) {
        candidates = [];
        for (const id of entryIds) {
          const found = pending.find((e) => e.id === id);
          if (found) candidates.push(found);
          else notFound.push(id);
        }
      } else {
        candidates = pending.filter((e) => e.workPackageId !== undefined);
      }

      // Validar que cada candidata tenga workPackageId y activityId.
      const valid: TimelogEntry[] = [];
      const missing: { id: string; falta: string[] }[] = [];
      for (const e of candidates) {
        const falta: string[] = [];
        if (e.workPackageId === undefined) falta.push("workPackageId");
        if (e.activityId === undefined) falta.push("activityId");
        if (falta.length > 0) missing.push({ id: e.id, falta });
        else valid.push(e);
      }

      const uploaded: { id: string; openprojectTimeEntryId: number }[] = [];
      const failed: { id: string; error: string }[] = [];
      const projectCache = new Map<number, number | undefined>();

      for (const e of valid) {
        try {
          // Resolver projectId: usar el de la entry o derivarlo del work package.
          let projectId = e.projectId;
          if (projectId === undefined) {
            const wpId = e.workPackageId!;
            if (projectCache.has(wpId)) {
              projectId = projectCache.get(wpId);
            } else {
              const wp = await client.getWorkPackage(wpId);
              projectId = idFromHref(wp._links?.project?.href);
              projectCache.set(wpId, projectId);
            }
          }
          if (projectId === undefined) {
            throw new Error(
              "no se pudo determinar el projectId (indícalo en la entry)",
            );
          }
          const te = await client.createTimeEntry({
            projectId,
            activityId: e.activityId!,
            workPackageId: e.workPackageId!,
            hours: e.hours,
            spentOn: e.spentOn,
            description: e.description,
          });
          uploaded.push({ id: e.id, openprojectTimeEntryId: te.id });
        } catch (err) {
          failed.push({ id: e.id, error: describeError(err) });
        }
      }

      await markSent(uploaded);

      const lines: string[] = [];
      lines.push(
        `Subidas OK: ${uploaded.length} · Fallidas: ${failed.length} · Sin datos: ${missing.length}${
          notFound.length ? ` · No encontradas: ${notFound.length}` : ""
        }`,
      );
      if (uploaded.length > 0) {
        lines.push(
          "",
          "Subidas:",
          ...uploaded.map(
            (u) => `  ✓ ${u.id} -> OpenProject TE ${u.openprojectTimeEntryId}`,
          ),
        );
      }
      if (missing.length > 0) {
        lines.push(
          "",
          "No subidas (faltan datos):",
          ...missing.map((m) => `  ✗ ${m.id}: falta ${m.falta.join(", ")}`),
        );
      }
      if (failed.length > 0) {
        lines.push(
          "",
          "Fallidas:",
          ...failed.map((f) => `  ✗ ${f.id}: ${f.error}`),
        );
      }
      if (notFound.length > 0) {
        lines.push("", `Ids no encontrados en pending: ${notFound.join(", ")}`);
      }
      return text(lines.join("\n"));
    } catch (err) {
      return errorText(`No se pudieron subir las entries: ${describeError(err)}`);
    }
  },
);

// 11. clear_sent
server.registerTool(
  "clear_sent",
  {
    title: "Limpiar entries enviadas",
    description: "Borra de la bitácora local todas las entries con status 'sent'.",
    inputSchema: {},
  },
  async () => {
    try {
      const cleared = await clearSent();
      return text(`Se limpiaron ${cleared} entries enviadas.`);
    } catch (err) {
      return errorText(`No se pudieron limpiar: ${describeError(err)}`);
    }
  },
);

// 12. render_gallery
server.registerTool(
  "render_gallery",
  {
    title: "Generar galería visual de la bitácora",
    description:
      "Genera un HTML autocontenido (stats, filtros por grupo y tabla) con las entries de la bitácora y lo escribe en un fichero temporal. Devuelve la ruta del fichero (no el HTML) para publicarla con la tool Artifact, evitando gastar tokens en volcar el HTML en la respuesta.",
    inputSchema: {
      status: z
        .enum(["pending", "sent", "all"])
        .default("pending")
        .describe("Filtro de estado"),
      groupBy: z
        .enum(["workPackageId", "projectId", "activityId", "none"])
        .default("workPackageId")
        .describe("Campo por el que agrupar y colorear las entries"),
      title: z.string().optional().describe("Título de la galería"),
    },
  },
  async ({ status, groupBy, title }) => {
    try {
      const entries = await listEntries(status);
      if (entries.length === 0) {
        return text(`No hay entries con status '${status}' para mostrar.`);
      }
      const html = buildGalleryHtml(entries, { groupBy, title, status });
      const filePath = await writeGalleryFile(html);
      const totalHours = entries.reduce((acc, e) => acc + e.hours, 0);
      return text(
        `Galería generada: ${entries.length} entries · ${totalHours.toFixed(2)}h\n` +
          `Archivo: ${filePath}\n\n` +
          `Publícala con la tool Artifact usando esa ruta como file_path.`,
      );
    } catch (err) {
      return errorText(`No se pudo generar la galería: ${describeError(err)}`);
    }
  },
);

// ---------- arranque ----------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No usar stdout para logs: interfiere con el protocolo stdio.
  process.stderr.write("openproject-timelog MCP server listo (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`Error fatal: ${describeError(err)}\n`);
  process.exit(1);
});
