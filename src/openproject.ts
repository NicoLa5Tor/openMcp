import type {
  OPActivity,
  OPCollection,
  OPLink,
  OPProject,
  OPTimeEntry,
  OPWorkPackage,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 100;

export type ActivityResolution =
  | { status: "found"; id: number; name: string }
  | { status: "ambiguous"; candidates: OPActivity[] }
  | { status: "not_found"; available: OPActivity[] };

/**
 * Resuelve el nombre de una actividad (tal como aparece en el dropdown de
 * OpenProject, ej. "Especificación") a su id, tolerando mayúsculas/acentos
 * y coincidencias parciales. Prioriza match exacto; si hay más de una
 * coincidencia devuelve 'ambiguous' con los candidatos para que el llamador
 * decida en vez de adivinar.
 */
export function matchActivity(
  activities: OPActivity[],
  name: string,
): ActivityResolution {
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  const target = norm(name);

  const exact = activities.filter((a) => norm(a.name) === target);
  if (exact.length === 1) {
    return { status: "found", id: exact[0].id, name: exact[0].name };
  }
  if (exact.length > 1) {
    return { status: "ambiguous", candidates: exact };
  }

  const partial = activities.filter((a) => norm(a.name).includes(target));
  if (partial.length === 1) {
    return { status: "found", id: partial[0].id, name: partial[0].name };
  }
  if (partial.length > 1) {
    return { status: "ambiguous", candidates: partial };
  }

  return { status: "not_found", available: activities };
}

export class OpenProjectError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "OpenProjectError";
  }
}

export interface OpenProjectConfig {
  url: string;
  apiKey: string;
}

/**
 * Lee la configuración desde variables de entorno. Devuelve `null` si falta
 * algo, para que las tools de solo-local sigan funcionando sin credenciales.
 */
export function readConfig(): OpenProjectConfig | null {
  const url = process.env.OPENPROJECT_URL?.trim();
  const apiKey = process.env.OPENPROJECT_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), apiKey };
}

/** Convierte horas decimales a duración ISO 8601 (ej: 1.5 -> "PT1H30M"). */
export function hoursToISO8601(hours: number): string {
  if (!(hours > 0)) {
    throw new Error(`Las horas deben ser un número positivo (recibido: ${hours})`);
  }
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  let out = "PT";
  if (h > 0) out += `${h}H`;
  if (m > 0) out += `${m}M`;
  if (out === "PT") out = "PT0H";
  return out;
}

/** Convierte una duración ISO 8601 (PT1H30M) a horas decimales. */
export function iso8601ToHours(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?$/.exec(iso);
  if (!match) return undefined;
  const h = match[1] ? parseFloat(match[1]) : 0;
  const m = match[2] ? parseFloat(match[2]) : 0;
  return h + m / 60;
}

export class OpenProjectClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: OpenProjectConfig) {
    this.baseUrl = config.url;
    const token = Buffer.from(`apikey:${config.apiKey}`).toString("base64");
    this.authHeader = `Basic ${token}`;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new OpenProjectError(
        `No se pudo conectar con OpenProject en ${this.baseUrl}: ${
          (err as Error).message
        }. ¿Está la URL correcta y el servidor accesible?`,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.message ?? text;
      } catch {
        /* usar texto crudo */
      }
      if (res.status === 401 || res.status === 403) {
        throw new OpenProjectError(
          `OpenProject rechazó la petición (${res.status}). Revisa OPENPROJECT_API_KEY y los permisos del usuario. Detalle: ${detail}`,
          res.status,
          text,
        );
      }
      throw new OpenProjectError(
        `OpenProject respondió ${res.status} a ${path}: ${detail}`,
        res.status,
        text,
      );
    }

    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** Itera todas las páginas de una colección v3 y concatena los elementos. */
  private async collectAll<T>(
    basePath: string,
    searchParams: URLSearchParams,
  ): Promise<T[]> {
    const elements: T[] = [];
    let offset = 1;
    searchParams.set("pageSize", String(DEFAULT_PAGE_SIZE));
    for (;;) {
      searchParams.set("offset", String(offset));
      const path = `${basePath}?${searchParams.toString()}`;
      const page = await this.request<OPCollection<T>>(path);
      const batch = page?._embedded?.elements ?? [];
      elements.push(...batch);
      const total = page?.total ?? elements.length;
      if (elements.length >= total || batch.length === 0) break;
      offset += 1;
    }
    return elements;
  }

  async getProjects(): Promise<OPProject[]> {
    return this.collectAll<OPProject>(
      "/api/v3/projects",
      new URLSearchParams(),
    );
  }

  async getWorkPackages(opts: {
    projectId?: number;
    status?: string;
    assignee?: string;
  }): Promise<OPWorkPackage[]> {
    const filters: unknown[] = [];
    if (opts.status) {
      filters.push({ status: { operator: "=", values: [opts.status] } });
    }
    if (opts.assignee) {
      filters.push({ assignee: { operator: "=", values: [opts.assignee] } });
    }
    const params = new URLSearchParams();
    if (filters.length > 0) {
      params.set("filters", JSON.stringify(filters));
    }
    const basePath = opts.projectId
      ? `/api/v3/projects/${opts.projectId}/work_packages`
      : "/api/v3/work_packages";
    return this.collectAll<OPWorkPackage>(basePath, params);
  }

  /**
   * Lista las actividades de time entry disponibles.
   *
   * OpenProject NO expone una colección GET /api/v3/time_entries/activities
   * (404), y el schema genérico trae activity._links vacío. Las actividades
   * son por-proyecto y se obtienen del *form* de time_entries en el contexto
   * de un work package: POST /api/v3/time_entries/form devuelve
   * _embedded.schema.activity._links.allowedValues.
   *
   * Si no se pasa workPackageId, se toma cualquier work package como contexto
   * para poder listarlas.
   */
  /**
   * Encuentra un work package que sirva de contexto para leer las actividades
   * disponibles. Prioriza los WP donde el usuario actual YA ha registrado
   * tiempo (garantiza permiso de time-logging); si no tiene ninguno, cae al
   * primer work package accesible.
   */
  private async findContextWorkPackageId(): Promise<number | undefined> {
    try {
      const me = await this.request<{ id: number }>("/api/v3/users/me");
      if (me?.id !== undefined) {
        const filters = JSON.stringify([
          { user: { operator: "=", values: [String(me.id)] } },
        ]);
        const sortBy = JSON.stringify([["id", "desc"]]);
        const params = new URLSearchParams({
          pageSize: "1",
          filters,
          sortBy,
        });
        const te = await this.request<OPCollection<OPTimeEntry>>(
          `/api/v3/time_entries?${params.toString()}`,
        );
        const wpHref = te?._embedded?.elements?.[0]?._links?.workPackage?.href;
        const id = idFromHref(wpHref);
        if (id !== undefined) return id;
      }
    } catch {
      // seguimos con el fallback
    }
    const wps = await this.request<OPCollection<OPWorkPackage>>(
      "/api/v3/work_packages?pageSize=1",
    );
    return wps?._embedded?.elements?.[0]?.id;
  }

  async getActivities(workPackageId?: number): Promise<OPActivity[]> {
    const wpId = workPackageId ?? (await this.findContextWorkPackageId());
    if (wpId === undefined) {
      throw new OpenProjectError(
        "No se pudo determinar un work package de contexto para listar las actividades. Indica un workPackageId (uno donde tengas permiso de registrar tiempo).",
      );
    }

    const form = await this.request<{
      _embedded?: { schema?: { activity?: { _links?: { allowedValues?: OPLink[] } } } };
    }>("/api/v3/time_entries/form", {
      method: "POST",
      body: JSON.stringify({
        _links: { workPackage: { href: `/api/v3/work_packages/${wpId}` } },
      }),
    });

    const allowed = form?._embedded?.schema?.activity?._links?.allowedValues;
    if (!Array.isArray(allowed)) {
      throw new OpenProjectError(
        `OpenProject no devolvió actividades en el form de time_entries (contexto WP ${wpId}). Revisa permisos o la configuración de actividades del proyecto.`,
      );
    }
    return allowed
      .map((link) => ({ id: idFromHref(link.href), name: link.title ?? "" }))
      .filter((a): a is OPActivity => a.id !== undefined && a.name.length > 0);
  }

  async getTimeEntries(opts: {
    projectId?: number;
    workPackageId?: number;
    from?: string;
    to?: string;
  }): Promise<OPTimeEntry[]> {
    const filters: unknown[] = [];
    if (opts.projectId) {
      filters.push({ project: { operator: "=", values: [String(opts.projectId)] } });
    }
    if (opts.workPackageId) {
      filters.push({
        work_package: { operator: "=", values: [String(opts.workPackageId)] },
      });
    }
    if (opts.from || opts.to) {
      // spentOn con operador de rango de fechas "<>d"
      filters.push({
        spentOn: {
          operator: "<>d",
          values: [opts.from ?? "", opts.to ?? ""],
        },
      });
    }
    const params = new URLSearchParams();
    if (filters.length > 0) {
      params.set("filters", JSON.stringify(filters));
    }
    return this.collectAll<OPTimeEntry>("/api/v3/time_entries", params);
  }

  async createTimeEntry(payload: {
    projectId: number;
    activityId: number;
    workPackageId: number;
    hours: number;
    spentOn: string;
    description: string;
  }): Promise<OPTimeEntry> {
    const body = {
      _links: {
        project: { href: `/api/v3/projects/${payload.projectId}` },
        activity: {
          href: `/api/v3/time_entries/activities/${payload.activityId}`,
        },
        workPackage: {
          href: `/api/v3/work_packages/${payload.workPackageId}`,
        },
      },
      hours: hoursToISO8601(payload.hours),
      spentOn: payload.spentOn,
      comment: { raw: payload.description },
    };
    return this.request<OPTimeEntry>("/api/v3/time_entries", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Obtiene un work package individual (para resolver su projectId). */
  async getWorkPackage(id: number): Promise<OPWorkPackage> {
    return this.request<OPWorkPackage>(`/api/v3/work_packages/${id}`);
  }
}

/** Extrae el id numérico final de un href v3 (ej: /api/v3/projects/42 -> 42). */
export function idFromHref(href: string | null | undefined): number | undefined {
  if (!href) return undefined;
  const match = /(\d+)\/?$/.exec(href);
  return match ? Number(match[1]) : undefined;
}
