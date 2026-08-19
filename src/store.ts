import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import type { EntryStatus, TimelogEntry } from "./types.js";

const DATA_DIR = join(homedir(), ".openproject-timelog");
const DATA_FILE = join(DATA_DIR, "entries.json");

/**
 * Almacenamiento local de la bitácora sobre un fichero JSON.
 *
 * Las escrituras se serializan en memoria (una cola de promesas) y se
 * persisten de forma atómica (escritura a fichero temporal + rename) para
 * evitar corrupción si hay operaciones concurrentes.
 */

let writeChain: Promise<unknown> = Promise.resolve();

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

/** Lee la bitácora respetando la cola de escrituras (lecturas consistentes). */
async function readSerialized(): Promise<TimelogEntry[]> {
  const run = writeChain.then(() => readAll());
  writeChain = run.catch(() => undefined);
  return run;
}

async function readAll(): Promise<TimelogEntry[]> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TimelogEntry[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    if (err instanceof SyntaxError) {
      throw new Error(
        `El fichero de bitácora está corrupto (${DATA_FILE}): ${err.message}`,
      );
    }
    throw err;
  }
}

async function persist(entries: TimelogEntry[]): Promise<void> {
  await ensureDir();
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
  await rename(tmp, DATA_FILE);
}

/**
 * Ejecuta una mutación sobre la bitácora asegurando serialización: lee el
 * estado actual, aplica `mutator`, persiste y devuelve el resultado del mutator.
 */
async function withWriteLock<T>(
  mutator: (entries: TimelogEntry[]) => { entries: TimelogEntry[]; result: T },
): Promise<T> {
  const run = writeChain.then(async () => {
    const current = await readAll();
    const { entries, result } = mutator(current);
    await persist(entries);
    return result;
  });
  // Mantener la cadena viva incluso si esta operación falla.
  writeChain = run.catch(() => undefined);
  return run;
}

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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function listEntries(
  status: EntryStatus | "all" = "pending",
): Promise<TimelogEntry[]> {
  const all = await readSerialized();
  if (status === "all") return all;
  return all.filter((e) => e.status === status);
}

export async function getEntry(id: string): Promise<TimelogEntry | undefined> {
  const all = await readSerialized();
  return all.find((e) => e.id === id);
}

export async function createEntry(
  input: NewEntryInput,
): Promise<TimelogEntry> {
  const entry: TimelogEntry = {
    id: randomUUID(),
    description: input.description,
    hours: input.hours,
    workPackageId: input.workPackageId,
    projectId: input.projectId,
    activityId: input.activityId,
    spentOn: input.spentOn ?? todayISO(),
    startTime: input.startTime,
    endTime: input.endTime,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  return withWriteLock((entries) => {
    entries.push(entry);
    return { entries, result: entry };
  });
}

export async function updateEntry(
  id: string,
  update: EntryUpdate,
): Promise<TimelogEntry> {
  return withWriteLock((entries) => {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`No existe una entry con id ${id}`);
    }
    const current = entries[idx];
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
    entries[idx] = merged;
    return { entries, result: merged };
  });
}

export async function assignWorkPackage(
  entryIds: string[],
  workPackageId: number,
): Promise<{ updated: TimelogEntry[]; notFound: string[]; skipped: string[] }> {
  return withWriteLock((entries) => {
    const updated: TimelogEntry[] = [];
    const notFound: string[] = [];
    const skipped: string[] = [];
    for (const id of entryIds) {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) {
        notFound.push(id);
        continue;
      }
      if (entries[idx].status !== "pending") {
        skipped.push(id);
        continue;
      }
      entries[idx] = { ...entries[idx], workPackageId };
      updated.push(entries[idx]);
    }
    return { entries, result: { updated, notFound, skipped } };
  });
}

export async function deleteEntry(id: string): Promise<TimelogEntry> {
  return withWriteLock((entries) => {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`No existe una entry con id ${id}`);
    }
    if (entries[idx].status !== "pending") {
      throw new Error(
        `La entry ${id} ya fue enviada y no se puede borrar (usa clear_sent)`,
      );
    }
    const [removed] = entries.splice(idx, 1);
    return { entries, result: removed };
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
  await withWriteLock((entries) => {
    const now = new Date().toISOString();
    for (const entry of entries) {
      const opId = byId.get(entry.id);
      if (opId !== undefined) {
        entry.status = "sent";
        entry.sentAt = now;
        entry.openprojectTimeEntryId = opId;
      }
    }
    return { entries, result: undefined };
  });
}

export async function clearSent(): Promise<number> {
  return withWriteLock((entries) => {
    const remaining = entries.filter((e) => e.status !== "sent");
    const cleared = entries.length - remaining.length;
    return { entries: remaining, result: cleared };
  });
}

export const _paths = { DATA_DIR, DATA_FILE };
