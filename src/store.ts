import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import type {
  EntryStatus,
  LocalProject,
  StoreData,
  TimelogEntry,
} from "./types.js";

const DATA_DIR = join(homedir(), ".openproject-timelog");
const DATA_FILE = join(DATA_DIR, "entries.json");

/**
 * Almacenamiento local de la bitácora sobre un fichero JSON compartido.
 *
 * El fichero guarda un objeto StoreData (v2) con proyectos locales, el
 * proyecto activo y las entries. Ficheros antiguos (un array plano de entries)
 * se migran automáticamente al leerlos, sin perder datos.
 *
 * Las escrituras se serializan en memoria (una cola de promesas) y se
 * persisten de forma atómica (fichero temporal + rename) para evitar
 * corrupción con operaciones concurrentes (p. ej. Claude Code y Claude Desktop
 * escribiendo a la vez).
 */

let writeChain: Promise<unknown> = Promise.resolve();

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function emptyStore(): StoreData {
  return { version: 2, activeProjectId: null, projects: [], entries: [] };
}

/** Normaliza cualquier contenido leído al formato StoreData v2. */
function normalize(parsed: unknown): StoreData {
  // Formato legacy: array plano de entries.
  if (Array.isArray(parsed)) {
    return {
      version: 2,
      activeProjectId: null,
      projects: [],
      entries: parsed as TimelogEntry[],
    };
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Partial<StoreData>;
    return {
      version: 2,
      activeProjectId: obj.activeProjectId ?? null,
      projects: Array.isArray(obj.projects) ? obj.projects : [],
      entries: Array.isArray(obj.entries) ? obj.entries : [],
    };
  }
  return emptyStore();
}

async function readRaw(): Promise<StoreData> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    return normalize(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return emptyStore();
    if (err instanceof SyntaxError) {
      throw new Error(
        `El fichero de bitácora está corrupto (${DATA_FILE}): ${err.message}`,
      );
    }
    throw err;
  }
}

/** Lee el store respetando la cola de escrituras (lecturas consistentes). */
async function readSerialized(): Promise<StoreData> {
  const run = writeChain.then(() => readRaw());
  writeChain = run.catch(() => undefined);
  return run;
}

async function persist(store: StoreData): Promise<void> {
  await ensureDir();
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await rename(tmp, DATA_FILE);
}

/**
 * Ejecuta una mutación sobre el store asegurando serialización: lee el estado
 * actual, aplica `mutator`, persiste y devuelve el resultado del mutator.
 */
async function withWriteLock<T>(
  mutator: (store: StoreData) => { store: StoreData; result: T },
): Promise<T> {
  const run = writeChain.then(async () => {
    const current = await readRaw();
    const { store, result } = mutator(current);
    await persist(store);
    return result;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- proyectos locales ----------

export interface NewProjectInput {
  name: string;
  openprojectProjectId?: number;
  defaultWorkPackageId?: number;
  defaultActivityId?: number;
}

export async function createProject(
  input: NewProjectInput,
): Promise<LocalProject> {
  const project: LocalProject = {
    id: randomUUID(),
    name: input.name,
    openprojectProjectId: input.openprojectProjectId,
    defaultWorkPackageId: input.defaultWorkPackageId,
    defaultActivityId: input.defaultActivityId,
    createdAt: new Date().toISOString(),
  };
  return withWriteLock((store) => {
    store.projects.push(project);
    // Si es el primero, queda activo automáticamente.
    if (store.activeProjectId === null) {
      store.activeProjectId = project.id;
    }
    return { store, result: project };
  });
}

export async function listProjects(): Promise<{
  projects: LocalProject[];
  activeProjectId: string | null;
}> {
  const store = await readSerialized();
  return { projects: store.projects, activeProjectId: store.activeProjectId };
}

export async function getActiveProject(): Promise<LocalProject | null> {
  const store = await readSerialized();
  if (!store.activeProjectId) return null;
  return store.projects.find((p) => p.id === store.activeProjectId) ?? null;
}

export async function setActiveProject(id: string): Promise<LocalProject> {
  return withWriteLock((store) => {
    const project = store.projects.find((p) => p.id === id);
    if (!project) {
      throw new Error(`No existe un proyecto local con id ${id}`);
    }
    store.activeProjectId = id;
    return { store, result: project };
  });
}

export async function updateProject(
  id: string,
  update: Partial<NewProjectInput>,
): Promise<LocalProject> {
  return withWriteLock((store) => {
    const project = store.projects.find((p) => p.id === id);
    if (!project) {
      throw new Error(`No existe un proyecto local con id ${id}`);
    }
    const target = project as LocalProject & Record<string, unknown>;
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) {
        target[key] = value;
      }
    }
    return { store, result: project };
  });
}

export async function deleteProject(
  id: string,
): Promise<{ project: LocalProject; untagged: number }> {
  return withWriteLock((store) => {
    const idx = store.projects.findIndex((p) => p.id === id);
    if (idx === -1) {
      throw new Error(`No existe un proyecto local con id ${id}`);
    }
    const [project] = store.projects.splice(idx, 1);
    if (store.activeProjectId === id) store.activeProjectId = null;
    // Desvincula las entries que apuntaban a este proyecto (no las borra).
    let untagged = 0;
    for (const e of store.entries) {
      if (e.localProjectId === id) {
        delete e.localProjectId;
        untagged++;
      }
    }
    return { store, result: { project, untagged } };
  });
}

// ---------- entries ----------

export interface NewEntryInput {
  description: string;
  hours: number;
  workPackageId?: number;
  projectId?: number;
  activityId?: number;
  spentOn?: string;
  startTime?: string;
  endTime?: string;
}

export type EntryUpdate = Partial<
  Pick<
    TimelogEntry,
    | "description"
    | "hours"
    | "workPackageId"
    | "projectId"
    | "activityId"
    | "spentOn"
    | "startTime"
    | "endTime"
  >
>;

export async function listEntries(
  status: EntryStatus | "all" = "pending",
  localProjectId?: string,
): Promise<TimelogEntry[]> {
  const store = await readSerialized();
  let entries = store.entries;
  if (status !== "all") entries = entries.filter((e) => e.status === status);
  if (localProjectId) {
    entries = entries.filter((e) => e.localProjectId === localProjectId);
  }
  return entries;
}

export async function getEntry(id: string): Promise<TimelogEntry | undefined> {
  const store = await readSerialized();
  return store.entries.find((e) => e.id === id);
}

export async function createEntry(
  input: NewEntryInput,
): Promise<TimelogEntry> {
  return withWriteLock((store) => {
    const active =
      store.activeProjectId !== null
        ? store.projects.find((p) => p.id === store.activeProjectId) ?? null
        : null;

    const entry: TimelogEntry = {
      id: randomUUID(),
      description: input.description,
      hours: input.hours,
      // Aplica defaults del proyecto activo si el campo no viene explícito.
      workPackageId: input.workPackageId ?? active?.defaultWorkPackageId,
      projectId: input.projectId ?? active?.openprojectProjectId,
      activityId: input.activityId ?? active?.defaultActivityId,
      spentOn: input.spentOn ?? todayISO(),
      startTime: input.startTime,
      endTime: input.endTime,
      status: "pending",
      createdAt: new Date().toISOString(),
      localProjectId: active?.id,
    };
    store.entries.push(entry);
    return { store, result: entry };
  });
}

export async function updateEntry(
  id: string,
  update: EntryUpdate,
): Promise<TimelogEntry> {
  return withWriteLock((store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`No existe una entry con id ${id}`);
    }
    const current = store.entries[idx];
    if (current.status !== "pending") {
      throw new Error(
        `La entry ${id} ya fue enviada (status='${current.status}') y no se puede editar`,
      );
    }
    const merged = { ...current } as TimelogEntry & Record<string, unknown>;
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    store.entries[idx] = merged;
    return { store, result: merged };
  });
}

export async function assignWorkPackage(
  entryIds: string[],
  workPackageId: number,
): Promise<{ updated: TimelogEntry[]; notFound: string[]; skipped: string[] }> {
  return withWriteLock((store) => {
    const updated: TimelogEntry[] = [];
    const notFound: string[] = [];
    const skipped: string[] = [];
    for (const id of entryIds) {
      const idx = store.entries.findIndex((e) => e.id === id);
      if (idx === -1) {
        notFound.push(id);
        continue;
      }
      if (store.entries[idx].status !== "pending") {
        skipped.push(id);
        continue;
      }
      store.entries[idx] = { ...store.entries[idx], workPackageId };
      updated.push(store.entries[idx]);
    }
    return { store, result: { updated, notFound, skipped } };
  });
}

export async function deleteEntry(id: string): Promise<TimelogEntry> {
  return withWriteLock((store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`No existe una entry con id ${id}`);
    }
    if (store.entries[idx].status !== "pending") {
      throw new Error(
        `La entry ${id} ya fue enviada y no se puede borrar (usa clear_sent)`,
      );
    }
    const [removed] = store.entries.splice(idx, 1);
    return { store, result: removed };
  });
}

/**
 * Marca varias entries como enviadas de una sola pasada (usado tras subir a
 * OpenProject). `results` mapea id -> id devuelto por OpenProject.
 */
export async function markSent(
  results: { id: string; openprojectTimeEntryId: number }[],
): Promise<void> {
  if (results.length === 0) return;
  const byId = new Map(results.map((r) => [r.id, r.openprojectTimeEntryId]));
  await withWriteLock((store) => {
    const now = new Date().toISOString();
    for (const entry of store.entries) {
      const opId = byId.get(entry.id);
      if (opId !== undefined) {
        entry.status = "sent";
        entry.sentAt = now;
        entry.openprojectTimeEntryId = opId;
      }
    }
    return { store, result: undefined };
  });
}

export async function clearSent(): Promise<number> {
  return withWriteLock((store) => {
    const before = store.entries.length;
    store.entries = store.entries.filter((e) => e.status !== "sent");
    return { store, result: before - store.entries.length };
  });
}

export const _paths = { DATA_DIR, DATA_FILE };
