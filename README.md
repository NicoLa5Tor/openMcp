# @nicola5tor/openproject-timelog

MCP server (Model Context Protocol) para llevar una **bitácora de horas local** y
sincronizarla con **OpenProject** (API v3). Registra tu trabajo en lenguaje
natural desde Claude Desktop (u otro cliente MCP), revísalo, y súbelo a
OpenProject cuando esté listo.

- **Transporte:** stdio
- **Almacenamiento local:** `~/.openproject-timelog/entries.json`
- **Config:** variables de entorno `OPENPROJECT_URL` y `OPENPROJECT_API_KEY`

## Instalación

No hace falta instalar nada de forma global: el servidor se ejecuta con `npx`.

```bash
# probarlo directamente
npx @nicola5tor/openproject-timelog
```

O instalarlo en un proyecto:

```bash
npm install @nicola5tor/openproject-timelog
# o
pnpm add @nicola5tor/openproject-timelog
```

## Configuración en Claude Desktop

Edita el fichero de configuración (`claude_desktop_config.json`) y añade el
servidor bajo `mcpServers`:

```json
{
  "mcpServers": {
    "openproject-timelog": {
      "command": "npx",
      "args": ["-y", "@nicola5tor/openproject-timelog"],
      "env": {
        "OPENPROJECT_URL": "https://tu-openproject.example.com",
        "OPENPROJECT_API_KEY": "TU_API_KEY"
      }
    }
  }
}
```

Reinicia Claude Desktop tras guardar.

### Cómo obtener tu API key de OpenProject

En OpenProject: **Mi cuenta → Access tokens → API** y genera una clave. El
servidor autentica con Basic auth usando el usuario literal `apikey` y tu clave
como contraseña.

> Las tools **solo locales** (`log_entry`, `list_entries`, `edit_entry`,
> `assign_entry`, `delete_entry`, `clear_sent`) funcionan aunque no configures
> OpenProject. Las tools de consulta y subida requieren `OPENPROJECT_URL` y
> `OPENPROJECT_API_KEY`.

## Tools

### Bitácora local

| Tool | Descripción |
| --- | --- |
| `log_entry` | Registra una entrada de horas. Params: `description`*, `hours`*, `workPackageId`, `projectId`, `activityId`, `spentOn` (def. hoy), `startTime`, `endTime`. Si no hay `workPackageId` queda pendiente de asignar. |
| `list_entries` | Lista entries por estado. Param: `status` = `pending` (def.) \| `sent` \| `all`. |
| `edit_entry` | Edita una entry **pendiente**. Params: `id`* + cualquier campo editable. |
| `assign_entry` | Asigna un work package a varias entries. Params: `entryIds`*, `workPackageId`*. |
| `delete_entry` | Borra una entry **pendiente**. Param: `id`*. |
| `clear_sent` | Elimina de la bitácora local todas las entries ya enviadas (`sent`). |

### Consulta OpenProject

| Tool | Descripción |
| --- | --- |
| `get_projects` | Lista proyectos (`id`, `name`, `status`). |
| `get_work_packages` | Lista tareas. Params opcionales: `projectId`, `status`, `assignee`. |
| `get_activities` | Lista actividades de time entry (`id`, `name`). |
| `get_time_entries` | Consulta horas ya registradas. Params opcionales: `projectId`, `workPackageId`, `from`, `to`. |

### Sincronización

| Tool | Descripción |
| --- | --- |
| `upload_entries` | Sube entries a OpenProject. Param opcional `entryIds`; si se omite sube todas las `pending` con `workPackageId`. Cada entry necesita `workPackageId` y `activityId`; las que falten se reportan sin subirse. Al subir, marca la entry como `sent`. |

\* = requerido.

## Notas de comportamiento

- Los ids locales son **UUID v4**. Las horas se guardan en decimal (`1.5` = 1h30m)
  y se convierten a duración ISO 8601 (`PT1H30M`) al subir.
- El `projectId` de una entry, si no se indica, se **deriva del work package** al
  subir (una llamada extra a OpenProject).
- El fichero JSON se escribe de forma **atómica** (fichero temporal + rename) y
  las operaciones se **serializan** para evitar corrupción.
- Los errores de red / credenciales / permisos se devuelven como mensajes
  legibles en la respuesta de la tool, sin tumbar el servidor.

## Ejemplos de uso conversacional

> **Tú:** Registra 2 horas de hoy arreglando el login, tarea 1234.
> **Claude:** *(llama a `log_entry` con description="arreglar login", hours=2, workPackageId=1234)*

> **Tú:** Apúntame 45 minutos de reunión, ya le pongo la tarea luego.
> **Claude:** *(`log_entry` description="reunión", hours=0.75)* — queda pendiente de asignar.

> **Tú:** ¿Qué tengo pendiente de subir?
> **Claude:** *(`list_entries` status="pending")*

> **Tú:** Esas dos reuniones ponles la tarea 1234.
> **Claude:** *(`assign_entry` entryIds=[...], workPackageId=1234)*

> **Tú:** ¿Qué actividades hay? Ponle "Development" a todo y súbelo.
> **Claude:** *(`get_activities` → `edit_entry`/`assign` para activityId → `upload_entries`)*

> **Tú:** Limpia lo que ya se subió.
> **Claude:** *(`clear_sent`)*

## Desarrollo

```bash
npm install      # instala deps y compila (prepare -> build)
npm run build    # compila TypeScript a dist/
npm start        # ejecuta dist/index.js
```

Estructura:

```
openproject-timelog/
├── src/
│   ├── index.ts        # entry point, setup MCP y registro de tools
│   ├── store.ts        # CRUD bitácora local (JSON atómico)
│   ├── openproject.ts  # cliente API OpenProject v3
│   └── types.ts        # interfaces/types
├── package.json
├── tsconfig.json
└── README.md
```

## Licencia

MIT
