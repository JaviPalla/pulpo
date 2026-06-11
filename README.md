<p align="center">
  <img src="assets/icon-1024.png" width="128" alt="Pulpo" />
</p>

<h1 align="center">🐙 Pulpo</h1>

<p align="center">
  <b>Cliente de GitHub para Mac centrado en pull requests.</b><br/>
  Listado estilo Bitbucket · diffs y comentarios nativos · grafo de ramas · borradores de review.<br/>
  <i>A macOS GitHub PR client: Bitbucket-style list, native diffs &amp; review drafts, branch graph.</i>
</p>

---

## Reglas de la casa

No configurables. A propósito.

| Operación | Método |
|---|---|
| Update branch | **rebase** |
| Merge | **merge commit** |
| Squash | **jamás** — no existe en la UI ni en el código |

## Capturas

| PRs + detalle | Diff con borradores | Histórico (grafo) |
|---|---|---|
| ![Lista](docs/screenshot-list.png) | ![Cambios](docs/screenshot-changes.png) | ![Histórico](docs/screenshot-history.png) |

## Qué hace

- **Listado de PRs estilo Bitbucket** — estado (Abierta/Borrador/Fusionada/Cerrada),
  `rama-origen → rama-destino`, decisión de review, checks del CI (✓/✗/●), rama atrasada o con
  conflictos, labels, autor, comentarios y antigüedad. Buckets: *Abiertas · Mías · Para revisar ·
  Borradores · Fusionadas · Cerradas* con contadores, y búsqueda instantánea.
- **Diffs nativos** — pestaña *Cambios* con el diff completo (hunks, numeración old/new,
  colapsable por fichero). Sin saltar al navegador.
- **Borradores de review** 📝 — los comentarios (inline en una línea o generales) se guardan
  **localmente** y no tocan GitHub hasta que pulsas *Publicar…*, que los envía todos en **una sola
  review** con veredicto: 💬 Comentar · ✅ Aprobar · ± Pedir cambios. Los hilos existentes aparecen
  anclados a su línea, con respuesta directa.
- **Review con IA** 🤖 — un botón analiza el diff de la PR con Claude y genera comentarios de
  review **en inglés**, anclados a sus líneas, **como borradores**: los revisas, borras los que no
  te convenzan y publicas solo lo que tú decidas. Backend: la API de Anthropic (`ANTHROPIC_API_KEY`,
  con structured outputs) o, si no hay clave, tu CLI de Claude Code ya autenticado (`claude -p`).
- **Histórico** 📈 — grafo de commits (estilo GitKraken) con las ramas yendo y viniendo entre
  `develop`/`main` y las ramas de PR (activables). Acciones sobre cualquier commit: copiar SHA,
  crear rama, **mover una rama a ese commit** (force, con confirmación escrita) o **revertir una
  PR fusionada** (crea PR de revert).
- **Acciones de PR** — *Update branch (rebase)* y *Merge (merge commit)* con confirmación y
  borrado opcional de la rama. El merge se deshabilita solo (conflictos, checks, rama atrasada)
  explicando el motivo.
- **Notificaciones nativas** 🔔 — te avisa cuando te piden review, cuando tu PR es aprobada o le
  piden cambios, y cuando sus checks se ponen en rojo. El Dock muestra cuántas PRs esperan tu
  review.
- **Multi-repo** — varios repositorios y una vista agregada *⭐ Todos los repos*.
- **Teclado** — `⌘K` paleta de comandos · `j/k` + `Enter` navegar y abrir · `1–6` buckets ·
  `h` histórico · `R` refrescar · `Esc` cerrar.
- Modo claro/oscuro según el sistema. UI en español.

## Puesta en marcha (2 minutos)

```bash
git clone https://github.com/JesusGR4/pulpo && cd pulpo
npm install
npm run doctor   # te dice exactamente qué falta y cómo arreglarlo
npm start
```

`npm run doctor` comprueba Node, dependencias, GitHub e IA, con el comando de arreglo para
cada cosa que falte. Si arrancas sin GitHub conectado, la propia app te recibe con una
pantalla de configuración guiada y botón de reintento. Una vez conectado, Pulpo te lista
tus repositorios accesibles para que marques los que quieres vigilar (o añadas cualquier
`owner/repo` a mano) — y puedes cambiarlos cuando quieras en Ajustes ⚙.

### 1. GitHub (necesario)

Pulpo no guarda tu token salvo que tú lo pidas. Orden de resolución:

1. Variable de entorno `GITHUB_TOKEN`
2. `gh auth token` (GitHub CLI — lo habitual): `brew install gh && gh auth login`
3. Token manual desde Ajustes ⚙ (queda en `~/Library/Application Support/pulpo/config.json`, permisos 600)

El token vive solo en el proceso principal: el renderer va sandboxed con CSP estricta y habla por IPC.

### 2. Claude (opcional — para 🤖 Review con IA)

Sin configurar nada: si tienes [Claude Code](https://claude.com/claude-code) instalado y has
hecho login alguna vez, Pulpo usa esa sesión automáticamente (`claude -p` headless). Si
prefieres la API directa, exporta `ANTHROPIC_API_KEY` y Pulpo usará el SDK oficial con
salida estructurada. En Ajustes ⚙ hay un botón **"Probar conexión con Claude"** para
verificarlo desde la app.

### Empaquetar como .app (opcional)

```bash
npx electron-packager . Pulpo --platform=darwin --arch=arm64 --icon=build/icon.icns --out=dist
```

## Arquitectura

```
src/main.js      ventana, IPC, notificaciones, selftest (--selftest[-route=list|changes|history])
src/github.js    GraphQL (listado/detalle/grafo/update-branch) + REST (merge, diff, reviews)
src/ai.js        review con IA: SDK de Anthropic o CLI de Claude Code, siempre como borradores
src/drafts.js    borradores locales (userData/drafts.json)
src/config.js    repos, polling, token manual opcional
src/preload.js   puente IPC (contextBridge) — el renderer va sandboxed y sin Node
renderer/        vanilla JS + CSS — sin frameworks, sin bundler
scripts/         make-icon.js (el icono se renderiza con el propio Electron)
```

`npm run selftest` arranca la app contra la API real, captura la pantalla en
`/tmp/pulpo-selftest.png` y sale — así se verifican los cambios de UI. `npm test` corre
las tres vistas (lista, cambios, histórico) y comprueba que todas renderizan.

## Atajos

| Tecla | Acción |
|---|---|
| `⌘K` | Paleta de comandos |
| `j` / `k` + `Enter` | Navegar la lista y abrir |
| `1`–`6` | Cambiar de bucket |
| `h` | Histórico (grafo) |
| `r` | Refrescar |
| `?` | Chuleta de atajos |

## Licencia

MIT
