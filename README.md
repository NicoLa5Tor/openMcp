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

## Configuración en Claude Code

Es un MCP server estándar por stdio, así que funciona igual en
[Claude Code](https://claude.com/claude-code) (la CLI). Regístralo a nivel
usuario (disponible en todos tus proyectos) con:

```bash
claude mcp add openproject-timelog -s user \
  -e OPENPROJECT_URL=https://tu-openproject.example.com \
  -e OPENPROJECT_API_KEY=TU_API_KEY \
  -- npx -y @nicola5tor/openproject-timelog
```

Alternativa: editar directamente `~/.claude.json` (a nivel usuario) o el
`.mcp.json` del proyecto (para que solo aplique ahí), con el mismo bloque
`mcpServers` que en Claude Desktop:

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
| `log_entry` | Registra una entrada de horas. Params: `description`*, `hours`*, `workPackageId`, `projectId`, `activityId`, `activityName`, `spentOn` (def. hoy), `startTime`, `endTime`. Si no hay `workPackageId` queda pendiente de asignar. |
| `list_entries` | Lista entries por estado. Params: `status` = `pending` (def.) \| `sent` \| `all`; `groupBy` opcional = `workPackageId` \| `projectId` \| `activityId` \| `spentOn` (agrupa con subtotales). |
| `edit_entry` | Edita una entry **pendiente**. Params: `id`* + cualquier campo editable (incluye `activityName`). |
| `assign_entry` | Asigna un work package a varias entries. Params: `entryIds`*, `workPackageId`*. |
| `delete_entry` | Borra una entry **pendiente**. Param: `id`*. |
| `clear_sent` | Elimina de la bitácora local todas las entries ya enviadas (`sent`). |

### Consulta OpenProject

| Tool | Descripción |
| --- | --- |
| `get_projects` | Lista proyectos (`id`, `name`, `status`). |
| `get_work_packages` | Lista tareas. Params opcionales: `projectId`, `status`, `assignee`. |
| `get_activities` | Lista actividades de time entry (`id`, `name`). Se obtienen del schema de `time_entries` (`activity._links.allowedValues`), ya que OpenProject no expone una colección directa en `/api/v3/time_entries/activities`. |
| `get_time_entries` | Consulta horas ya registradas. Params opcionales: `projectId`, `workPackageId`, `from`, `to`. |

### Sincronización

| Tool | Descripción |
| --- | --- |
| `upload_entries` | Sube entries a OpenProject. Param opcional `entryIds`; si se omite sube todas las `pending` con `workPackageId`. Cada entry necesita `workPackageId` y `activityId`; las que falten se reportan sin subirse. Al subir, marca la entry como `sent`. |

### Vista visual

| Tool | Descripción |
| --- | --- |
| `render_gallery` | Genera un HTML autocontenido (stats, filtros por grupo y tabla) con las entries y lo escribe en un fichero temporal. Params: `status` = `pending` (def.) \| `sent` \| `all`; `groupBy` = `workPackageId` (def.) \| `projectId` \| `activityId` \| `none`; `title` opcional. Devuelve la **ruta del fichero**, no el HTML — el cliente MCP la usa para publicarla (p. ej. como Artifact en Claude), sin gastar tokens volcando el HTML en la conversación. |

\* = requerido.

## Notas de comportamiento

- **`activityName`** (en `log_entry` y `edit_entry`) resuelve el nombre tal como
  aparece en el dropdown de OpenProject (ej. "Especificación", "Pruebas") al
  `activityId` correspondiente, sin distinguir mayúsculas ni acentos. Si hay
  match exacto lo usa; si no, intenta coincidencia parcial. Si el nombre es
  ambiguo o no existe, la tool responde con la lista de actividades
  disponibles en vez de adivinar. Requiere OpenProject configurado y se
  ignora si ya se pasó `activityId` explícito.
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

> **Tú:** Muéstrame la bitácora como galería, agrupada por tarea.
> **Claude:** *(`render_gallery` groupBy="workPackageId" → publica el HTML resultante como Artifact)*

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
│   ├── gallery.ts      # generador de HTML de galería (render_gallery)
│   └── types.ts        # interfaces/types
├── package.json
├── tsconfig.json
└── README.md
```

## Licencia

MIT
