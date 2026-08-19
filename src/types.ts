export type EntryStatus = "pending" | "sent";

export interface TimelogEntry {
  id: string; // uuid generado al crear
  workPackageId?: number; // puede asignarse después
  projectId?: number;
  activityId?: number;
  hours: number; // en decimal (1.5 = 1h30m)
  spentOn: string; // fecha ISO YYYY-MM-DD
  startTime?: string; // HH:mm opcional
  endTime?: string; // HH:mm opcional
  description: string;
  status: EntryStatus;
  createdAt: string; // ISO datetime
  sentAt?: string; // ISO datetime cuando se subió
  openprojectTimeEntryId?: number; // ID devuelto por OpenProject al subir
  localProjectId?: string; // proyecto local (workspace) al que pertenece
}

/**
 * Proyecto local (workspace). Agrupa entries y define valores por defecto que
 * se aplican al crear horas dentro de él. Se comparte entre Claude Code y
 * Claude Desktop a través del mismo fichero de store.
 */
export interface LocalProject {
  id: string; // uuid
  name: string;
  openprojectProjectId?: number; // proyecto de OpenProject asociado
  defaultWorkPackageId?: number;
  defaultActivityId?: number;
  createdAt: string; // ISO datetime
}

/** Estructura persistida del store (v2). */
export interface StoreData {
  version: 2;
  activeProjectId: string | null;
  projects: LocalProject[];
  entries: TimelogEntry[];
}

// ---- OpenProject API (subset de la respuesta v3) ----

export interface OPLink {
  href: string | null;
  title?: string;
}

export interface OPProject {
  id: number;
  name: string;
  status?: string;
  _links?: Record<string, OPLink>;
}

export interface OPWorkPackage {
  id: number;
  subject: string;
  _links?: {
    status?: OPLink;
    assignee?: OPLink;
    project?: OPLink;
    [k: string]: OPLink | undefined;
  };
}

export interface OPActivity {
  id: number;
  name: string;
}

export interface OPTimeEntry {
  id: number;
  hours: string; // ISO 8601 duration
  spentOn: string;
  comment?: { raw?: string };
  _links?: {
    project?: OPLink;
    workPackage?: OPLink;
    activity?: OPLink;
    user?: OPLink;
    [k: string]: OPLink | undefined;
  };
}

export interface OPCollection<T> {
  total: number;
  count: number;
  pageSize: number;
  offset: number;
  _embedded: {
    elements: T[];
  };
}
