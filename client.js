/**
 * dsh-farm — browser half.
 *
 * A hand-written module-table bundle: executes by registering its factory with
 * window.__ModuleLoader__; the factory's exports are the client plugin.
 *
 * UI, in one of three homes, resolved at runtime (first available wins):
 *  - 'rightbar' → a tab type in the **official right Sidebar** (the DSH
 *    "侧边栏" / `ui-sidebar-right`): `ctx.sidebarRightTabs` owns the type, a
 *    `guide` entry puts the 🚜 capsule on that column's guide page — which is
 *    the column's own entry point — and picking it opens this tab. This is the
 *    current DSH model and the preferred home.
 *  - 'better'   → DSH-better-sidebar installed: the panel is registered as a
 *    tab through its `betterSidebar` service.
 *  - 'drawer'   → neither of the above: dsh-farm's own sidebar-foot button
 *    plus its right-hand drawer.
 *
 * Seats:
 *  - the tab type's `guide` entry → 🚜 capsule with a running-services badge
 *    on the right Sidebar's guide page, which is the column's own entry point
 *  - sidebar.right.pane.tab        (keyed by the type id) → the tab body:
 *    services grouped by workspace with start/stop/restart, delete,
 *    multi-select delete behind a confirm dialog, log follow (SSE), search
 *    and export
 *  - sidebar.right.pane.tab.title  (keyed by the type id) → the 🚜 chip
 *  - sidebar.footer.action / shell.overlay → the fallback home (render
 *    nothing in the other two)
 *
 * No imports: `require` resolves the platform seed table (react).
 */
window.__ModuleLoader__.load({ id: 'dsh-farm', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  const React = require('react')

  // ── tiny shared store ───────────────────────────────────────────────────
  const store = {
    open: false,
    services: [],
    loaded: false,
    error: undefined,
    logView: undefined, // { id, name, lines: [], following, search, es }
    actionError: undefined, // last failed start/stop/delete, survives a refresh
    selecting: false,       // multi-select mode in the overview
    selected: new Set(),    // service ids ticked while selecting
    confirm: undefined,     // { ids: [], busy, error } — pending delete confirmation
    home: 'drawer',         // 'rightbar' | 'better' | 'drawer' — where the UI lives
    listeners: new Set(),
    emit() { for (const fn of [...this.listeners]) { try { fn() } catch {} } },
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
  }

  // One shared 5s poll, kept alive by the mounted surfaces rather than by a
  // single component: the home that is on screen may be any of the three, and
  // a badge must stay fresh in all of them.
  let pollers = 0
  let pollTimer
  const useFarm = () => {
    const [, force] = React.useReducer((n) => n + 1, 0)
    React.useEffect(() => {
      const unsubscribe = store.subscribe(force)
      pollers += 1
      if (pollers === 1) {
        refresh()
        pollTimer = setInterval(refresh, 5000)
      }
      return () => {
        unsubscribe()
        pollers -= 1
        if (pollers === 0 && pollTimer !== undefined) {
          clearInterval(pollTimer)
          pollTimer = undefined
        }
      }
    }, [])
  }

  const refresh = async () => {
    try {
      const res = await fetch('/farm/services')
      const body = await res.json()
      store.services = body.services || []
      store.loaded = true
      store.error = undefined
      const live = new Set(store.services.map((s) => s.id))
      for (const id of [...store.selected]) if (!live.has(id)) store.selected.delete(id)
      if (store.logView && !live.has(store.logView.id)) closeLogView()
    } catch (err) {
      store.error = String(err)
    }
    store.emit()
  }

  const act = async (svc, action) => {
    await fetch(`/farm/services/${svc.id}/${action}`, { method: 'POST' })
    setTimeout(refresh, 300)
  }

  const closeLogView = () => {
    if (store.logView && store.logView.es) { try { store.logView.es.close() } catch {} }
    store.logView = undefined
  }

  // farm.yaml services are owned by the file; the server refuses to delete
  // them, so the UI greys them out instead of offering a doomed button.
  const isRemovable = (svc) => svc.source !== 'yaml'

  const asJson = async (res) => {
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }

  // refresh() clears store.error on success, so action failures live in
  // store.actionError and are set after the list has been reloaded.
  const deleteOne = async (svc) => {
    let failure
    try {
      await asJson(await fetch(`/farm/services/${svc.id}`, { method: 'DELETE' }))
      store.selected.delete(svc.id)
    } catch (err) {
      failure = `delete ${svc.name}: ${err.message || err}`
    }
    await refresh()
    store.actionError = failure
    store.emit()
  }

  const deleteSelected = async () => {
    const pending = store.confirm
    if (!pending || pending.busy) return
    pending.busy = true
    pending.error = undefined
    store.emit()
    let failure
    try {
      const body = await asJson(await fetch('/farm/services/batch-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: pending.ids }),
      }))
      for (const entry of body.deleted || []) store.selected.delete(entry.id)
      const failed = body.failed || []
      if (failed.length) failure = `${failed.length} service(s) kept — ${failed.map((f) => f.error).join('; ')}`
      store.confirm = undefined
      if (store.selected.size === 0) store.selecting = false
    } catch (err) {
      pending.busy = false
      pending.error = String(err.message || err)
    }
    await refresh()
    store.actionError = failure
    store.emit()
  }

  const exitSelect = () => {
    store.selecting = false
    store.selected.clear()
    store.confirm = undefined
  }

  // ── shared styles (theme variables only) ────────────────────────────────
  const CSS = `
.dshfarm-badge{position:relative;display:inline-flex;align-items:center;justify-content:center}
.dshfarm-icon{font-family:'Apple Color Emoji','Segoe UI Emoji',sans-serif}
/* Tab-chip glyph: the title seat's text follows it. */
.dshfarm-chip{margin-right:6px}
.dshfarm-dot{position:absolute;top:-2px;right:-4px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;
  background:var(--dsw-alias-accent-brand,#4c7dff);color:var(--dsw-alias-label-on-accent,#fff);
  font-size:10px;line-height:14px;text-align:center;font-weight:600}
.dshfarm-drawer{position:fixed;top:0;right:0;bottom:0;width:460px;max-width:92vw;z-index:10000;
  display:flex;flex-direction:column;pointer-events:auto;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border-left:1px solid var(--dsw-alias-border-secondary,#8884);box-shadow:-8px 0 24px #0003}
.dshfarm-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-secondary,#8884)}
.dshfarm-title{font-size:14px;font-weight:600;flex:1}
.dshfarm-btn{border:1px solid var(--dsw-alias-border-secondary,#8884);background:transparent;
  color:inherit;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer}
.dshfarm-btn:hover{background:var(--dsw-alias-bg-layer-2,#8881)}
.dshfarm-panel{display:flex;flex-direction:column;flex:1;min-height:0;height:100%}
.dshfarm-body{flex:1;overflow-y:auto;padding:8px 12px 16px}
.dshfarm-ws{margin:10px 0 4px;font-size:11px;opacity:.65;word-break:break-all;text-transform:uppercase;letter-spacing:.04em}
.dshfarm-svc{display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-secondary,#8882);margin-bottom:6px}
.dshfarm-svc-main{flex:1;min-width:0}
.dshfarm-svc-name{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.dshfarm-svc-cmd{font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,monospace}
.dshfarm-src{font-size:10px;padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-border-secondary,#8884);opacity:.7}
.dshfarm-st{width:8px;height:8px;border-radius:4px;flex:none}
.st-running,.st-starting{background:#34c759}.st-unhealthy{background:#ff9f0a}
.st-stopped{background:#98989d}.st-exited{background:#ff9f0a}.st-failed,.st-stopping{background:#ff453a}
.dshfarm-search{width:100%;box-sizing:border-box;margin:8px 0;padding:6px 8px;border-radius:6px;font-size:12px;
  border:1px solid var(--dsw-alias-border-secondary,#8884);background:var(--dsw-alias-bg-layer-2,#8881);color:inherit}
.dshfarm-log{flex:1;overflow:auto;background:var(--dsw-alias-bg-layer-2,#8881);border-radius:8px;padding:8px;
  font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all}
.dshfarm-log .dshfarm-stderr{color:var(--dsw-alias-label-danger,#ff453a)}
.dshfarm-log .dshfarm-meta{opacity:.55}
.dshfarm-empty{opacity:.55;font-size:12px;text-align:center;padding:24px 0}
.dshfarm-btn:disabled{opacity:.35;cursor:not-allowed}
.dshfarm-btn:disabled:hover{background:transparent}
.dshfarm-btn-danger:not(:disabled){color:var(--dsw-alias-label-danger,#ff453a);border-color:var(--dsw-alias-label-danger,#ff453a55)}
.dshfarm-btn-danger:not(:disabled):hover{background:var(--dsw-alias-label-danger,#ff453a);color:#fff}
.dshfarm-selbar{display:flex;align-items:center;gap:8px;padding:8px 14px;font-size:12px;
  border-bottom:1px solid var(--dsw-alias-border-secondary,#8884);background:var(--dsw-alias-bg-layer-2,#8881)}
.dshfarm-selcount{flex:1;opacity:.7}
.dshfarm-check{width:14px;height:14px;flex:none;pointer-events:none;accent-color:var(--dsw-alias-accent-brand,#4c7dff)}
.dshfarm-svc-pick{cursor:pointer}
.dshfarm-svc-on{border-color:var(--dsw-alias-accent-brand,#4c7dff);background:var(--dsw-alias-bg-layer-2,#8881)}
.dshfarm-err{margin:6px 0;padding:6px 8px;border-radius:6px;font-size:11px;line-height:1.5;
  color:var(--dsw-alias-label-danger,#ff453a);border:1px solid var(--dsw-alias-label-danger,#ff453a55)}
.dshfarm-mask{position:fixed;inset:0;z-index:10001;background:#0007;
  display:flex;align-items:center;justify-content:center;pointer-events:auto}
.dshfarm-modal{width:380px;max-width:90vw;border-radius:10px;padding:16px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-secondary,#8884);box-shadow:0 12px 32px #0006}
.dshfarm-modal-title{font-size:14px;font-weight:600;margin-bottom:6px}
.dshfarm-modal-text{font-size:12px;opacity:.7;line-height:1.6}
.dshfarm-modal-list{margin:10px 0 0;max-height:168px;overflow:auto;border-radius:6px;padding:8px;
  font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.7;
  background:var(--dsw-alias-bg-layer-2,#8881)}
.dshfarm-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
`
  const styleInjected = { value: false }
  const ensureStyles = () => {
    if (styleInjected.value) return
    styleInjected.value = true
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-farm'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  const STATUS_DOT = { r: (svc) => React.createElement('span', { className: `dshfarm-st st-${svc.status}`, title: svc.status }) }

  const runningCount = () => store.services.filter((s) => ['running', 'starting', 'unhealthy'].includes(s.status)).length

  // ── right-Sidebar tab type: the guide capsule's glyph ───────────────────
  // `entry.icon` is rendered as <Icon size={22|26} /> inside a fixed 26px box
  // (ui-sidebar-right's guide), so this is a plain glyph component — and it
  // carries the running-services badge, since the guide is the column's only
  // way in.
  const FarmGuideIcon = (props) => {
    useFarm()
    ensureStyles()
    const n = runningCount()
    const size = (props && props.size) || 22
    return React.createElement('span', {
      className: 'dshfarm-badge dshfarm-icon',
      style: { fontSize: Math.round(size * 0.85), lineHeight: 1 },
    },
      '🚜',
      n > 0 ? React.createElement('span', { className: 'dshfarm-dot' }, String(n)) : null,
    )
  }

  // ── right-Sidebar tab chip: 🚜 + the title captured when the tab opened ──
  const FarmRightTitle = (props) => {
    const info = props.useTabInfo()
    return React.createElement(React.Fragment, null,
      React.createElement('span', { className: 'dshfarm-icon dshfarm-chip' }, '🚜'),
      info.tab.title,
    )
  }

  // ── sidebar footer button (fallback home only) ──────────────────────────
  const FarmButton = (props) => {
    useFarm()
    ensureStyles()
    // In the hosted homes the guide capsule / tab is the way in; this component
    // stays mounted only so the footer slot keeps its registration.
    if (store.home !== 'drawer') return null
    const n = runningCount()
    const wide = props && props.wide
    return React.createElement('button', {
      className: 'dshfarm-badge dshfarm-btn',
      style: { border: 'none', fontSize: wide ? 13 : 16, padding: wide ? '4px 8px' : 6, position: 'relative' },
      title: 'dsh-farm services',
      onClick: () => {
        store.open = !store.open
        if (!store.open) exitSelect()
        refresh()
        store.emit()
      },
    },
      '🚜',
      n > 0 ? React.createElement('span', { className: 'dshfarm-dot' }, String(n)) : null,
    )
  }

  // ── log panel (second level inside the drawer) ──────────────────────────
  const LogPanel = () => {
    useFarm()
    const lv = store.logView
    const logRef = React.useRef(null)
    React.useEffect(() => {
      if (lv && lv.following && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    })
    if (!lv) return null
    const close = () => {
      if (lv.es) lv.es.close()
      store.logView = undefined
      store.emit()
    }
    const doSearch = async (e) => {
      if (e.key !== 'Enter') return
      const q = e.target.value
      const res = await fetch(`/farm/services/${lv.id}/logs?tail=2000&search=${encodeURIComponent(q)}`)
      const body = await res.json()
      lv.search = q
      lv.lines = body.lines || []
      lv.detached = true
      store.emit()
    }
    const toggleFollow = () => {
      if (lv.es) { lv.es.close(); lv.es = undefined; lv.following = false }
      else {
        lv.following = true
        lv.lines = []
        lv.detached = false
        const es = new EventSource(`/farm/services/${lv.id}/logs/stream`)
        es.onmessage = (ev) => {
          try {
            const entry = JSON.parse(ev.data)
            lv.lines.push(entry)
            if (lv.lines.length > 5000) lv.lines.splice(0, lv.lines.length - 5000)
            store.emit()
          } catch {}
        }
        es.onerror = () => { lv.following = false; store.emit() }
        lv.es = es
      }
      store.emit()
    }
    const doExport = async () => {
      const res = await fetch(`/farm/services/${lv.id}/logs?export=1`)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `farm-${lv.name}.log`
      a.click()
      URL.revokeObjectURL(a.href)
    }
    const cls = (e) => e.stream === 'stderr' ? 'dshfarm-stderr' : e.stream === 'meta' ? 'dshfarm-meta' : undefined
    return React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'dshfarm-head' },
        React.createElement('button', { className: 'dshfarm-btn', onClick: close }, '←'),
        React.createElement('span', { className: 'dshfarm-title' }, `logs · ${lv.name}`),
        React.createElement('button', { className: 'dshfarm-btn', onClick: toggleFollow },
          lv.es ? '⏸ stop follow' : '▶ follow'),
        React.createElement('button', { className: 'dshfarm-btn', onClick: doExport }, 'export'),
      ),
      React.createElement('div', { style: { padding: '0 12px' } },
        React.createElement('input', {
          className: 'dshfarm-search', placeholder: 'search in live ring buffer… (Enter)',
          defaultValue: lv.search || '', onKeyDown: doSearch,
        }),
      ),
      React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', padding: '0 12px 12px', minHeight: 0 } },
        React.createElement('div', { className: 'dshfarm-log', ref: logRef },
          lv.lines.length === 0
            ? React.createElement('div', { className: 'dshfarm-empty' },
                lv.detached ? 'no matching lines in the live buffer' : 'waiting for output… press ▶ follow to stream live logs')
            : lv.lines.map((e, i) => React.createElement('div', { key: i, className: cls(e) },
                `${new Date(e.at).toISOString().slice(11, 19)} ${e.text}`)),
        ),
      ),
    )
  }

  // ── confirm dialog (multi-select delete) ────────────────────────────────
  const ConfirmDelete = () => {
    useFarm()
    const pending = store.confirm
    if (!pending) return null
    const targets = store.services.filter((svc) => pending.ids.includes(svc.id))
    const cancel = () => { if (pending.busy) return; store.confirm = undefined; store.emit() }
    return React.createElement('div', { className: 'dshfarm-mask', onClick: cancel },
      React.createElement('div', { className: 'dshfarm-modal', onClick: (e) => e.stopPropagation() },
        React.createElement('div', { className: 'dshfarm-modal-title' },
          `Delete ${pending.ids.length} service${pending.ids.length > 1 ? 's' : ''}?`),
        React.createElement('div', { className: 'dshfarm-modal-text' },
          'Running services are stopped first. This removes them from the farm registry and deletes their log file — project files are untouched.'),
        React.createElement('div', { className: 'dshfarm-modal-list' },
          targets.length
            ? targets.map((svc) => React.createElement('div', { key: svc.id },
                `${svc.name}  ·  ${svc.status}`))
            : React.createElement('div', { style: { opacity: 0.6 } }, '(services already gone)'),
        ),
        pending.error
          ? React.createElement('div', { className: 'dshfarm-err' }, pending.error)
          : null,
        React.createElement('div', { className: 'dshfarm-modal-actions' },
          React.createElement('button', {
            className: 'dshfarm-btn', disabled: pending.busy, onClick: cancel,
          }, 'cancel'),
          React.createElement('button', {
            className: 'dshfarm-btn dshfarm-btn-danger', disabled: pending.busy, onClick: deleteSelected,
          }, pending.busy ? 'deleting…' : `delete ${pending.ids.length}`),
        ),
      ),
    )
  }

  // ── panel: the service list itself, free of any chrome ──────────────────
  // Rendered by all three homes. `hosted` decides only whether the panel draws
  // its own close affordance; everything below the head row is identical
  // either way.
  const FarmPanel = (props) => {
    useFarm()
    ensureStyles()
    const hosted = !!(props && props.hosted)
    // Esc unwinds the innermost layer: confirm dialog, then log panel, then —
    // standalone only — the drawer itself. Hosted, there is nothing to close
    // below the log panel, so Esc just leaves multi-select.
    React.useEffect(() => {
      const onKey = (e) => {
        if (e.key !== 'Escape') return
        if (store.confirm) {
          if (store.confirm.busy) return
          store.confirm = undefined
        } else if (store.logView) {
          closeLogView()
        } else if (!hosted) {
          store.open = false
          exitSelect()
        } else if (store.selecting) {
          exitSelect()
        } else return
        store.emit()
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [hosted])
    const byWs = new Map()
    for (const svc of store.services) {
      if (!byWs.has(svc.workspace)) byWs.set(svc.workspace, [])
      byWs.get(svc.workspace).push(svc)
    }
    const groups = [...byWs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const close = () => { store.open = false; exitSelect(); store.emit() }
    const removable = store.services.filter(isRemovable)
    const allPicked = removable.length > 0 && removable.every((svc) => store.selected.has(svc.id))
    const toggleSelect = (svc) => {
      if (!isRemovable(svc)) return
      if (store.selected.has(svc.id)) store.selected.delete(svc.id)
      else store.selected.add(svc.id)
      store.emit()
    }
    const toggleAll = () => {
      if (allPicked) store.selected.clear()
      else for (const svc of removable) store.selected.add(svc.id)
      store.emit()
    }
    const openLogs = (svc) => {
      closeLogView()
      store.logView = { id: svc.id, name: svc.name, lines: [], following: false, es: undefined, search: '' }
      store.emit()
    }
    return React.createElement('div', { className: 'dshfarm-panel' },
      React.createElement('div', { className: 'dshfarm-head' },
        React.createElement('span', { className: 'dshfarm-title' }, hosted ? '🚜 services' : '🚜 dsh-farm · services'),
        React.createElement('button', {
          className: 'dshfarm-btn',
          disabled: !store.selecting && removable.length === 0,
          title: store.selecting ? 'leave multi-select' : 'select several services to delete',
          onClick: () => {
            if (store.selecting) exitSelect()
            else { store.selecting = true; store.actionError = undefined }
            store.emit()
          },
        }, store.selecting ? 'done' : '☑ select'),
        React.createElement('button', { className: 'dshfarm-btn', onClick: refresh }, '↻ refresh'),
        hosted ? null : React.createElement('button', { className: 'dshfarm-btn', onClick: close }, '✕'),
      ),
      store.selecting
        ? React.createElement('div', { className: 'dshfarm-selbar' },
            React.createElement('span', { className: 'dshfarm-selcount' },
              `${store.selected.size} of ${removable.length} selected`),
            React.createElement('button', {
              className: 'dshfarm-btn', disabled: removable.length === 0, onClick: toggleAll,
            }, allPicked ? 'clear all' : 'select all'),
            React.createElement('button', {
              className: 'dshfarm-btn dshfarm-btn-danger',
              disabled: store.selected.size === 0,
              onClick: () => { store.confirm = { ids: [...store.selected], busy: false, error: undefined }; store.emit() },
            }, `delete (${store.selected.size})`),
          )
        : null,
      React.createElement('div', { className: 'dshfarm-body' },
        store.error ? React.createElement('div', { className: 'dshfarm-empty' }, `error: ${store.error}`) : null,
        store.actionError
          ? React.createElement('div', {
              className: 'dshfarm-err', title: 'click to dismiss', style: { cursor: 'pointer' },
              onClick: () => { store.actionError = undefined; store.emit() },
            }, store.actionError)
          : null,
        !store.error && groups.length === 0
          ? React.createElement('div', { className: 'dshfarm-empty' },
              store.loaded ? 'no services yet — ask the agent to register one (farm_register) or add a farm.yaml' : 'loading…')
          : null,
        groups.map(([ws, svcs]) => React.createElement('div', { key: ws },
          React.createElement('div', { className: 'dshfarm-ws' }, ws),
          svcs.map((svc) => {
            const canRemove = isRemovable(svc)
            const picked = store.selected.has(svc.id)
            const yamlHint = 'declared in farm.yaml — edit the file to remove it'
            return React.createElement('div', {
              key: svc.id,
              className: `dshfarm-svc${store.selecting && canRemove ? ' dshfarm-svc-pick' : ''}${picked ? ' dshfarm-svc-on' : ''}`,
              onClick: store.selecting ? () => toggleSelect(svc) : undefined,
              title: store.selecting && !canRemove ? yamlHint : undefined,
            },
              store.selecting
                ? React.createElement('input', {
                    type: 'checkbox', className: 'dshfarm-check',
                    checked: picked, disabled: !canRemove, readOnly: true,
                  })
                : STATUS_DOT.r(svc),
              React.createElement('div', { className: 'dshfarm-svc-main' },
                React.createElement('div', { className: 'dshfarm-svc-name' },
                  svc.name,
                  React.createElement('span', { className: 'dshfarm-src' }, svc.source),
                  svc.pid ? React.createElement('span', { style: { fontSize: 10, opacity: 0.6 } }, `pid ${svc.pid}`) : null,
                ),
                React.createElement('div', { className: 'dshfarm-svc-cmd' }, svc.command),
              ),
              store.selecting ? null : [
                React.createElement('button', { key: 'start', className: 'dshfarm-btn', onClick: () => act(svc, 'start') }, 'start'),
                React.createElement('button', { key: 'stop', className: 'dshfarm-btn', onClick: () => act(svc, 'stop') }, 'stop'),
                React.createElement('button', { key: 'restart', className: 'dshfarm-btn', title: 'restart', onClick: () => act(svc, 'restart') }, '↻'),
                React.createElement('button', { key: 'logs', className: 'dshfarm-btn', onClick: () => openLogs(svc) }, 'logs'),
                React.createElement('button', {
                  key: 'delete',
                  className: 'dshfarm-btn dshfarm-btn-danger',
                  disabled: !canRemove,
                  title: canRemove ? `delete ${svc.name}` : yamlHint,
                  onClick: () => deleteOne(svc),
                }, '🗑'),
              ],
            )
          }),
        )),
      ),
      store.logView ? React.createElement(LogPanel) : null,
    )
  }

  // ── fallback home: dsh-farm's own right-hand drawer ───────────────────
  const Overview = () => {
    useFarm()
    if (store.home !== 'drawer' || !store.open) return null
    const closeAll = () => {
      if (store.confirm) return // the dialog owns the screen until answered
      closeLogView()
      exitSelect()
      store.open = false
      store.emit()
    }
    return React.createElement(React.Fragment, null,
      // Invisible click-catcher under the drawer: clicking anywhere outside
      // closes it, and it keeps the click from reaching the UI underneath.
      React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'auto' },
        onClick: closeAll,
      }),
      React.createElement('div', { className: 'dshfarm-drawer', style: { pointerEvents: 'auto' } },
        React.createElement(FarmPanel, { hosted: false }),
      ),
      React.createElement(ConfirmDelete),
    )
  }

  // ── right-Sidebar home: the tab body the official column docks ──────────
  // The column owns the chip, its close control, docking and persistence; this
  // is only the body swapped in when our tab is open. Same panel the other
  // homes render, without our own close affordance.
  const FarmRightTab = () => React.createElement(React.Fragment, null,
    React.createElement(FarmPanel, { hosted: true }),
    React.createElement(ConfirmDelete),
  )

  // ── hosted tab home: the page better-sidebar renders in its own tab ────
  const FarmTab = (props) => {
    // Any mounted surface keeps the shared poll alive, so a hidden tab costs
    // nothing extra; refresh once when it comes back into view.
    const visible = !props || props.visible !== false
    React.useEffect(() => { if (visible) refresh() }, [visible])
    return React.createElement(React.Fragment, null,
      React.createElement(FarmPanel, { hosted: true }),
      React.createElement(ConfirmDelete),
    )
  }

  // ── plugin ──────────────────────────────────────────────────────────────
  module.exports = {
    inject: ['slots'],
    apply(ctx) {
      // ── home resolution ───────────────────────────────────────────────
      // Exactly one of the three surfaces below is live at a time, each
      // reporting itself: `hasRightbar` once the official right Sidebar gives
      // us its tab registry, `hasBetter` when better-sidebar accepted our tab.
      // Neither is a hard dependency.
      //
      // The official column outranks better-sidebar: the two do not overlap
      // (better-sidebar replaces the *left* column), and this plugin's subject
      // is a docked panel, which is exactly what the right Sidebar is.
      let hasRightbar = false
      let hasBetter = false

      const resolveHome = () => {
        const next = hasRightbar ? 'rightbar' : hasBetter ? 'better' : 'drawer'
        if (next === store.home) return
        store.home = next
        store.open = false        // the drawer has no reason to stay open
        store.emit()
      }

      // ── fallback home: footer button + overlay drawer ──────────────────
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'dsh-farm-button', order: 100, label: 'dsh-farm' },
        FarmButton,
      )), 'dsh-farm: footer button')

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-farm.overview', order: 100, label: 'dsh-farm overview' },
        Overview,
      )), 'dsh-farm: overview drawer')

      // ── optional homes ────────────────────────────────────────────────
      // Neither `sidebarRightTabs` nor `betterSidebar` is in `inject`: a
      // declared service that is missing parks the whole plugin, which would
      // take the fallback UI down with it — the opposite of what we want.
      // ctx.get() is the runtime's optional-lookup hook (undefined when the
      // provider is absent), and `internal/service` catches either provider
      // arriving or leaving later, in both directions.
      if (typeof ctx.get !== 'function') return   // host predates optional lookup

      // ── preferred home: a tab type in the official right Sidebar ───────
      // Two-stage registration, the same public path the shipped Files,
      // Terminal and Browser types use: `ctx.sidebarRightTabs.register` owns
      // the type and its `guide` entry — that capsule *is* the column's entry
      // point — and the keyed `sidebar.right.pane.tab` seat owns the body,
      // under the type's own `id`.
      const FARM_ID = 'dsh-farm'   // implementation identity, and the body's key
      const FARM_KIND = 'farm'     // what `openTab` names
      let releaseRightbar

      const claimRightbar = (tabs) => {
        const disposers = []
        try {
          disposers.push(tabs.register({
            id: FARM_ID,
            kind: FARM_KIND,
            // No `patterns`: this is a page type, opened by kind, not a viewer.
            title: () => 'Farm',
            guide: [{
              id: 'services',
              order: 30,
              title: () => 'Farm',
              description: () => 'start, stop and watch project services',
              icon: FarmGuideIcon,
            }],
          }))
          disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: FARM_ID },
            FarmRightTab,
          )))
          disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
            { name: 'sidebar.right.pane.tab.title', key: FARM_ID },
            FarmRightTitle,
          )))
        } catch (err) {
          for (const dispose of disposers.reverse()) { try { dispose() } catch {} }
          console.error('[dsh-farm] right-sidebar tab registration failed:', err)
          return false
        }
        return () => { for (const dispose of disposers.reverse()) { try { dispose() } catch {} } }
      }

      const syncRightbar = () => {
        let tabs
        try { tabs = ctx.get('sidebarRightTabs') } catch { tabs = undefined }
        if (tabs && !releaseRightbar) {
          const release = claimRightbar(tabs)
          if (release) { releaseRightbar = release; hasRightbar = true }
        } else if (!tabs && releaseRightbar) {
          // The provider unloaded and its registry went with it; drop the
          // handle rather than calling a disposer into a dead registry.
          releaseRightbar = undefined
          hasRightbar = false
        }
        resolveHome()
      }

      let release   // live better-sidebar tab registration, while we have one

      const claim = (bs) => {
        const tab = {
          id: 'dsh-farm:services',
          title: 'Farm',
          icon: '🚜',
          order: 60,
          single: true,
          component: FarmTab,
        }
        // Capability-gated: badges landed in better-sidebar v0.12.0, and the
        // callback runs on every tab-bar render, so keep it to a count.
        const features = bs.features ? [...bs.features] : []
        if (features.includes('badge')) tab.badge = () => runningCount() || null
        return bs.registerTab(tab)
      }

      // Both directions are idempotent: `internal/service` can fire more than
      // once for the same arrival, and a second registerTab would throw.
      const sync = () => {
        let bs
        try { bs = ctx.get('betterSidebar') } catch { bs = undefined }
        if (bs && !release) {
          try {
            release = claim(bs)
          } catch (err) {
            release = undefined
            console.error('[dsh-farm] better-sidebar tab registration failed:', err)
            return
          }
          hasBetter = true
        } else if (!bs && release) {
          // The provider unloaded and its registry went with it; drop the
          // handle rather than calling a disposer into a dead registry.
          release = undefined
          hasBetter = false
        }
        resolveHome()
      }

      syncRightbar()
      sync()
      ctx.on('internal/service', (name) => {
        if (name === 'sidebarRightTabs') syncRightbar()
        else if (name === 'betterSidebar') sync()
      })
      ctx.effect(() => () => {
        if (releaseRightbar) { try { releaseRightbar() } catch {} releaseRightbar = undefined }
        hasRightbar = false
        if (release) { try { release() } catch {} release = undefined }
        hasBetter = false
      }, 'dsh-farm: release the hosted tabs')
    },
  }

  return module.exports
} })
