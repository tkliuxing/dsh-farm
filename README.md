# dsh-farm 🚜

DSH service farm plugin: start, stop, restart and watch long-running project
services from the Web UI, and register them from a session (agent tools) or
from a committed `farm.yaml`.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-farm
```

Restart the DSH web surface afterwards — both halves, the browser one included,
are read when the plugin activates, and a profile watches no module roots by
default, so a page refresh alone does not pick up an edited plugin.

## What you get

- **UI**: a 🚜 **Farm** entry on the right Sidebar's guide page (the column's
  own launcher, next to Files / Browser / Terminal); picking it opens the farm
  tab in that column — services grouped by workspace with status dots,
  start/stop/restart buttons, and a log view with live follow (SSE), substring
  search and download/export. The same body falls back to dsh-farm's own
  sidebar-foot button + drawer, or to a **Farm** tab in
  [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) when
  that is installed — see [Where the UI lives](#where-the-ui-lives).
- **Delete**: 🗑 on a row removes that one service. `☑ select` switches the
  panel into multi-select — tick rows (or *select all*), then *delete (n)*
  opens a confirmation dialog listing the targets; nothing is deleted until
  you confirm it. `farm.yaml` services are greyed out in both paths: the file
  owns them, so you remove them by editing it.
- **Agent tools**: `farm_status` / `farm_start` / `farm_stop` /
  `farm_restart` / `farm_logs(service, tail, search)` /
  `farm_register(name, workspace, command, ...)` /
  `farm_unregister(service | services)`. Say "帮我把 dev server
  注册到 farm 并启动" in a session and the agent does the rest.
- **farm.yaml** (optional, per workspace, commit-friendly) — a `services:` map,
  service names at **two** spaces and their keys at four (`env` entries at six
  or more); anything else is ignored without warning:

  ```yaml
  services:
    dev-server:
      command: pnpm dev
      # cwd: sub/dir        # optional, resolved against the workspace
      autoRestart: true
      env:
        PORT: 5173
  ```

  Declared services show up in the UI and in `farm_status` (`source: yaml`) once
  their workspace is known to the supervisor, and the file stays the source of
  truth: dsh-farm never writes it and refuses to delete what it declares. See
  [Known limitations](#known-limitations) for the workspace-scan rule — a
  wrongly indented service simply does not exist — and the inline-comment
  gotcha.

## Where the UI lives

dsh-farm renders the same body in whichever home is available, decided at
runtime — first hit wins:

| Home | Where it appears |
|---|---|
| current DSH (official right Sidebar) | a **🚜 Farm** capsule on that column's guide page (its launcher, beside Files / Browser / Terminal, carrying a running-count badge); picking it opens the `farm` tab in the column |
| DSH-better-sidebar installed | a **🚜 Farm** tab in better-sidebar (single-instance, with a running-count badge) |
| neither | dsh-farm's own 🚜 footer button + right-hand drawer |

Reach the column with its conversation-header button or shortcut: the guide page
is what an empty pane shows, and a pane that already holds a page gets there
through the strip's **+** control. That capsule is the entry point — dsh-farm
adds nothing to the left column or the main area.

Nothing to configure, and no host is a dependency: on current DSH the plugin
registers a tab type in the official column, and it still works on a build that
predates it. It follows either host being enabled or disabled while DSH is
running, in both directions.

> Implementation notes for anyone extending this. **The right Sidebar home is
> the column's own two-stage tab registration, not a drawer of our own.**
> `ctx.sidebarRightTabs.register({ id, kind, title, guide })` declares the type
> — `guide` is what puts the entry capsule on the guide page, which is how
> every shipped column page (Files, Browser, Terminal) is reached — and the
> keyed `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats take
> the body and the chip under the type's own `id`. The column owns the chip,
> its close control, docking, splitting and persistence, so the body is the
> same chrome-free panel the other two homes render. The type names no
> `patterns`: it is a page opened by kind, not a viewer claiming an address.
>
> **Nothing is version-sniffed, and nothing is hard-required.** Feature
> detection is `ctx.get('sidebarRightTabs')` (undefined when the column is not
> installed) plus `ctx.on('internal/service', …)` to catch it arriving or
> leaving later, so the fallback home stays in charge on a build that predates
> the column. `sidebarRightTabs` is deliberately **not** in the client half's
> `inject`: in DSH's cordis a declared-but-missing service parks the whole
> plugin, which would take the fallback UI down with it — the plugin would
> vanish entirely rather than fall back. `betterSidebar` is handled the same
> way.
>
> The official column outranks better-sidebar when both are present: they do
> not overlap (better-sidebar replaces the *left* column), and this plugin's
> subject is a docked panel, which is exactly what the right Sidebar is.

## Behavior notes

- Services are spawned as children of the DSH process (`/bin/sh -c`), so they
  are reclaimed when DSH exits. Dynamic registrations persist across restarts
  in `$DSH_HOME/storages/dsh-farm/services.json` (state does not).
- Stop = SIGTERM, then SIGKILL after a 3s grace.
- `autoRestart` retries an abnormal exit up to 5 times with exponential
  backoff (1s → 16s).
- Logs: 5000-line in-memory ring per service plus an append-only file under
  `$DSH_HOME/storages/dsh-farm/logs/<id>.log`.
- Deleting a service stops it first, then drops its registry row, its live log
  stream and its log file. Ids are derived from `workspace + name`, so this
  keeps a later re-registration of the same name from inheriting stale logs.
  Project files are never touched.

## Known limitations

- **A workspace is only scanned for `farm.yaml` while it also has a dynamic
  service.** The supervisor's yaml scan roots are the workspaces in its dynamic
  registry, so a workspace whose *only* declaration is a `farm.yaml` is
  invisible: `GET /farm/services` returns nothing for it, `farm_status` lists
  nothing, and its services cannot be started or stopped by id — the `/:id`
  routes resolve through the same scan set and answer `404 unknown service id`.
  Naming the workspace explicitly (`GET /farm/services?workspace=/abs/path`)
  does list them, but the id routes still need a scan root.

  Workaround: keep one service per such workspace registered dynamically as an
  anchor — `farm_register` from a session, with any command. The panel has no
  register form, so there is no click path for this. Symptom to watch for:
  removing a workspace's last dynamic service strands its `farm.yaml` services,
  and a batch delete that removes both reports the yaml ones as `unknown service
  id` instead of the `declared in …/farm.yaml` refusal — stop the yaml services
  *before* deleting that last dynamic one.
- **A trailing inline comment is part of the value.** `cwd: sub # dir` resolves
  to `<workspace>/sub # dir`. Put comments on their own line; `command` mostly
  survives it because the shell also treats `#` as a comment.
- **Log search reads the in-memory ring only.** `GET /:id/logs` also returns
  the on-disk tail as `fileTail`, which the panel does not render, so right
  after a DSH restart a search says "no matching lines in the live buffer" even
  though the log file still has the history.

## HTTP API (localhost only, prefix `/farm`)

| Route | Meaning |
|---|---|
| `GET /farm/services?workspace=` | list; the `workspace` param both filters and adds that path as a `farm.yaml` scan root |
| `POST /farm/services` | register/update a dynamic service |
| `GET /farm/services/:id` | one service |
| `DELETE /farm/services/:id` | unregister one (stops it first; 400 for `farm.yaml` services) |
| `POST /farm/services/batch-delete` | unregister many — `{ ids: [] }` → `{ ok, deleted, failed }` |
| `POST /farm/services/:id/start\|stop\|restart` | lifecycle |
| `GET /farm/services/:id/logs?tail=&search=&export=1` | logs, `export=1` downloads |
| `GET /farm/services/:id/logs/stream` | SSE live follow |

## Config (override in the profile patch)

```yaml
- id: farm
  config:
    dataDir: /abs/path   # default $DSH_HOME/storages/dsh-farm
    ringLines: 5000
    stopGraceMs: 3000
```
