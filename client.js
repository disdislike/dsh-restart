/**
 * dsh-restart — browser half.
 *
 * Renders one control in a Host-approved seat and lets the user pick which one
 * from Settings → General:
 *
 *   header-left       conversation.header.leading        (root, default)
 *   header-actions    conversation.session.header.actions
 *   header-utilities  conversation.session.header.utilities
 *   composer-left     conversation.input.left
 *   sidebar-footer    sidebar.footer.action
 *
 * Every seat is a normal flex child of the host row; the variant classes only
 * match that row's own height, gap, radius and label colour, so the control
 * snaps into the row instead of being positioned by hand. The choice lives in
 * localStorage (per browser) because the Host half has no Config schema here.
 *
 * The click posts to the Host route the Host half registered; the Host starts
 * its detached relauncher and the window closes. A plain browser tab on the
 * same Host asks first, because a restart would take its connection with it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-restart'

    /** Host endpoints registered by `index.js`. */
    const STATUS_URL = '/dsh-restart/status'
    const RESTART_URL = '/dsh-restart/restart'

    /** Namespaced storage key for the chosen seat. */
    const PLACEMENT_KEY = 'dsh-restart:placement'

    /** Dictionary entries; `zh` and `en` are the two baseline locales. */
    const zh = {
      restart: '重启 DSH',
      restarting: '正在重启…',
      failed: '无法重启',
      browserWarning: '重启会关闭当前浏览器页面（新实例会使用新的端口），之后请从系统托盘重新打开应用。确定继续？',
      'placement.title': '重启按钮位置',
      'placement.header-left': '工作区顶部左（标题前）',
      'placement.header-actions': '工作区顶部中（标题旁）',
      'placement.header-utilities': '工作区顶部右（工具栏）',
      'placement.composer-left': '输入框左侧',
      'placement.sidebar-footer': '侧边栏底部',
      'placement.header-left.hint': '会话标题左侧，始终显示',
      'placement.header-actions.hint': '会话标题右侧，跟标题栏一起显示',
      'placement.header-utilities.hint': '标题栏右侧工具区，图标按钮',
      'placement.composer-left.hint': '输入框工具行左侧',
      'placement.sidebar-footer.hint': '头像与设置那一行上方',
      'placement.needsSession': '需要打开一个会话',
      'placement.sidebarBusy': '该位置已被其他插件占用（默认是「动态插件」面板）',
      'placement.onlyDesktop': '仅 DeepSeek Harness 桌面端可用',
    }
    const en = {
      restart: 'Restart DSH',
      restarting: 'Restarting…',
      failed: 'Restart failed',
      browserWarning: 'Restarting closes this browser page (the new instance listens on a new port). Reopen the app from the system tray afterwards. Continue?',
      'placement.title': 'Restart button position',
      'placement.header-left': 'Work area top left (before the title)',
      'placement.header-actions': 'Work area top (next to the title)',
      'placement.header-utilities': 'Work area top right (utilities)',
      'placement.composer-left': 'Composer tool row',
      'placement.sidebar-footer': 'Sidebar foot',
      'placement.header-left.hint': 'Left of the session title, always shown',
      'placement.header-actions.hint': 'Right of the session title, shown with the header',
      'placement.header-utilities.hint': 'Icon button inside the header utilities',
      'placement.composer-left.hint': 'Left end of the composer tool row',
      'placement.sidebar-footer.hint': 'Above the account and settings row',
      'placement.needsSession': 'Needs an open session',
      'placement.sidebarBusy': 'That seat is taken by another plugin (the dynamic-plugin panel by default)',
      'placement.onlyDesktop': 'Desktop app only',
    }

    /** Copy used when the namespace translator is unavailable or not yet ready. */
    const FALLBACK = typeof document !== 'undefined' && /^zh/i.test(document.documentElement.lang ?? '') ? zh : en

    /**
     * Translate one key with the slot-injected translator, falling back to the
     * bundled copy so the control never renders a bare key.
     * @param {((key: string) => string) | undefined} t - namespace translator.
     * @param {string} key - dictionary key.
     * @returns {string} display text.
     */
    function translate(t, key) {
      if (typeof t === 'function') {
        try {
          const value = t(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch {
          // Fall through to the bundled copy.
        }
      }
      return FALLBACK[key] ?? key
    }

    /**
     * Every seat this plugin supports.
     *
     * `kind` decides the registration shape: a list seat needs its own `id`
     * (and `order`); a single seat must not pass either. `variant` selects the
     * matching control metrics; `scope` is only used by the settings hint.
     */
    const PLACEMENTS = [
      { id: 'header-left', slot: 'conversation.header.leading', kind: 'single', scope: 'root', variant: 'header' },
      { id: 'header-actions', slot: 'conversation.session.header.actions', kind: 'list', scope: 'session', variant: 'header', order: 30 },
      { id: 'header-utilities', slot: 'conversation.session.header.utilities', kind: 'list', scope: 'session', variant: 'utility', order: 30 },
      { id: 'composer-left', slot: 'conversation.input.left', kind: 'list', scope: 'session', variant: 'composer', order: 40 },
      { id: 'sidebar-footer', slot: 'sidebar.footer.action', kind: 'list', scope: 'root', variant: 'sidebar', order: 5 },
    ]

    /** The seat used when nothing else is chosen or available. */
    const DEFAULT_PLACEMENT = 'header-left'

    /** Seat ids, for validating the stored value. */
    const PLACEMENT_IDS = new Set(PLACEMENTS.map((entry) => entry.id))

    // ---------------------------------------------------------------------
    // Placement preference: one module-level store shared by the settings row
    // and the mount manager. Persisted in localStorage; an unavailable storage
    // only costs persistence, never the choice itself.
    // ---------------------------------------------------------------------

    /**
     * @returns {string} the stored seat, or the default.
     */
    function readPlacement() {
      try {
        const stored = globalThis.localStorage?.getItem(PLACEMENT_KEY)
        return PLACEMENT_IDS.has(stored) ? stored : DEFAULT_PLACEMENT
      } catch {
        return DEFAULT_PLACEMENT
      }
    }

    let currentPlacement = readPlacement()
    const placementListeners = new Set()

    /** @returns {string} the chosen seat id. */
    const getPlacement = () => currentPlacement

    /**
     * @param {() => void} listener - change callback.
     * @returns {() => void} unsubscribe.
     */
    const subscribePlacement = (listener) => {
      placementListeners.add(listener)
      return () => placementListeners.delete(listener)
    }

    /**
     * Choose a seat and persist it.
     * @param {string} next - one of {@link PLACEMENT_IDS}.
     */
    const setPlacement = (next) => {
      if (!PLACEMENT_IDS.has(next) || next === currentPlacement) return
      currentPlacement = next
      try {
        globalThis.localStorage?.setItem(PLACEMENT_KEY, next)
      } catch {
        // Persistence is optional; the in-memory choice still applies.
      }
      for (const listener of [...placementListeners]) listener()
    }

    /** React hook over the placement store. */
    const usePlacement = () => React.useSyncExternalStore(subscribePlacement, getPlacement, getPlacement)

    // ---------------------------------------------------------------------
    // Host capability: fetched once and shared by the control and the settings
    // row, so switching seats does not re-ask.
    // ---------------------------------------------------------------------

    let statusValue = 'unknown'
    let statusRequest
    const statusListeners = new Set()

    /**
     * @param {string} next - `unknown`, `supported` or `unsupported`.
     */
    function setStatus(next) {
      if (next === statusValue) return
      statusValue = next
      for (const listener of [...statusListeners]) listener()
    }

    /** Resolve the Host capability once per page. */
    function ensureStatus() {
      if (statusValue !== 'unknown' || statusRequest !== undefined) return
      statusRequest = fetch(STATUS_URL, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => setStatus(payload !== null && payload.supported === true ? 'supported' : 'unsupported'))
        .catch(() => setStatus('unsupported'))
        .then(() => {
          statusRequest = undefined
        })
    }

    /**
     * @param {() => void} listener - change callback.
     * @returns {() => void} unsubscribe.
     */
    const subscribeStatus = (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    }

    /** React hook over the Host capability. */
    const useStatus = () => React.useSyncExternalStore(subscribeStatus, () => statusValue, () => statusValue)

    // ---------------------------------------------------------------------
    // Sidebar-foot availability. `sidebar.footer.action` is a list seat, but a
    // shipped entry (the dynamic-plugin badge) takes the whole row, so a second
    // entry would spill outside the column. The seat is offered only while no
    // other entry occupies it, and a later occupant moves the button back.
    // ---------------------------------------------------------------------

    let sidebarAvailable = true
    let slotsPort
    const sidebarListeners = new Set()

    /**
     * @returns {boolean} whether `sidebar.footer.action` has a foreign entry.
     */
    function readSidebarAvailable() {
      try {
        const entries = slotsPort?.entriesOfSlot?.('sidebar.footer.action') ?? []
        return !entries.some((entry) => (entry?.options?.id ?? '') !== 'dsh-restart')
      } catch {
        return true
      }
    }

    /** Re-read the sidebar seat and notify the row when it changed. */
    function refreshSidebar() {
      const next = readSidebarAvailable()
      if (next === sidebarAvailable) return
      sidebarAvailable = next
      for (const listener of [...sidebarListeners]) listener()
    }

    /**
     * @param {() => void} listener - change callback.
     * @returns {() => void} unsubscribe.
     */
    const subscribeSidebar = (listener) => {
      sidebarListeners.add(listener)
      return () => sidebarListeners.delete(listener)
    }

    /** React hook over the sidebar seat availability. */
    const useSidebarAvailable = () => React.useSyncExternalStore(subscribeSidebar, () => sidebarAvailable, () => sidebarAvailable)

    // ---------------------------------------------------------------------
    // Styles. Every size below is copied from the row the variant lands in, so
    // the control inherits that row's alignment instead of a hand-tuned offset.
    // ---------------------------------------------------------------------

    const CONTROL_CSS = [
      '.dshr-root{position:relative;display:inline-flex;align-items:center;-webkit-app-region:no-drag}',
      '.dshr-button{display:inline-flex;align-items:center;border:1px solid transparent;background:transparent;font-family:inherit;line-height:1;cursor:pointer;white-space:nowrap;-webkit-app-region:no-drag;transition:background-color .12s ease,color .12s ease}',
      '.dshr-button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshr-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshr-button:disabled{cursor:default}',
      '.dshr-icon{display:inline-flex;align-items:center;justify-content:center;flex:none}',
      '.dshr-button[data-busy] .dshr-icon{animation:dshr-spin .9s linear infinite}',
      '.dshr-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dshr-root[data-variant="header"] .dshr-button{height:28px;padding:0 7px;gap:5px;border-radius:var(--dsw-radius-sm);font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dshr-root[data-variant="utility"] .dshr-button{width:24px;height:24px;padding:0;justify-content:center;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary)}',
      '.dshr-root[data-variant="composer"]{margin-left:2px}',
      '.dshr-root[data-variant="composer"] .dshr-button{height:26px;padding:0 8px;gap:5px;border-radius:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshr-root[data-variant="sidebar"]{width:100%;margin:8px 0 0}',
      '.dshr-root[data-variant="sidebar"] .dshr-button{width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;gap:8px;border-radius:12px;font-size:14px;color:var(--dsw-alias-label-primary)}',
      '.dshr-root[data-variant="sidebar"][data-wide="false"]{width:36px;height:36px;margin:0}',
      '.dshr-root[data-variant="sidebar"][data-wide="false"] .dshr-button{width:36px;height:36px;margin:0;padding:0;border-radius:50%;justify-content:center;gap:0}',
      '.dshr-notice{position:fixed;z-index:2147483000;width:max-content;max-width:248px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:16px;white-space:normal}',
      '.dshr-notice-title{color:var(--dsw-alias-state-error-primary);font-weight:500;margin-bottom:2px}',
      '@keyframes dshr-spin{to{transform:rotate(360deg)}}',
    ].join('')

    const SETTINGS_CSS = [
      '.dshr-setting{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px}',
      '.dshr-setting-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dshr-setting-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}',
      '.dshr-setting-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}',
      '.dshr-select{height:30px;max-width:280px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;cursor:pointer}',
      '.dshr-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshr-select:disabled{cursor:default;opacity:.6}',
    ].join('')

    /**
     * Read a failure reason out of a non-OK response.
     * @param {Response} response - failed response.
     * @returns {Promise<string>} human-readable reason.
     */
    async function readFailure(response) {
      try {
        const text = await response.text()
        if (text !== '') {
          try {
            const parsed = JSON.parse(text)
            const detail = parsed?.error ?? parsed?.message
            if (typeof detail === 'string' && detail !== '') return detail
          } catch {
            return text.slice(0, 200)
          }
        }
      } catch {
        // Fall through to the status line.
      }
      return `HTTP ${response.status}`
    }

    /**
     * Restart glyph drawn with `currentColor`; no shipped icon package is loaded.
     * @param {{ size: number }} props - glyph edge in pixels.
     * @returns {object} the svg element.
     */
    function RestartIcon({ size }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M13.4 8A5.4 5.4 0 1 1 11.8 4.2' }),
        h('path', { d: 'M13.4 2.4v3.4H10' }),
      )
    }

    /**
     * Icon edge and label visibility per seat variant.
     * @param {string} variant - one of the catalog variants.
     * @param {boolean | undefined} wide - sidebar owner state.
     * @returns {{ icon: number, label: boolean }} presentation facts.
     */
    function presentation(variant, wide) {
      if (variant === 'utility') return { icon: 15, label: false }
      if (variant === 'sidebar') return { icon: 16, label: wide !== false }
      if (variant === 'composer') return { icon: 14, label: true }
      return { icon: 14, label: true }
    }

    /**
     * The control itself, rendered inside whichever seat is mounted.
     * @param {object} props - slot props: `variant`, owner `wide`, and `t`.
     * @returns {object | null} the control, or null while unknown/unsupported.
     */
    function RestartButton({ variant, wide, t }) {
      const status = useStatus()
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const buttonRef = React.useRef(null)
      const hideTimer = React.useRef(undefined)

      React.useEffect(() => {
        ensureStatus()
        return () => clearTimeout(hideTimer.current)
      }, [])

      if (status !== 'supported') return null

      /**
       * Show one failure bubble next to the control for eight seconds.
       * @param {unknown} failure - the thrown value.
       */
      const showNotice = (failure) => {
        const message = failure instanceof Error ? failure.message : String(failure)
        const rect = buttonRef.current?.getBoundingClientRect()
        const viewport = window.innerWidth
        let anchor = { left: 16, top: 64 }
        if (rect !== undefined) {
          const left = Math.max(8, Math.min(rect.left, viewport - 260))
          anchor = rect.bottom + 96 < window.innerHeight
            ? { left, top: rect.bottom + 6 }
            : { left, bottom: window.innerHeight - rect.top + 6 }
        }
        setNotice({ message, anchor })
        clearTimeout(hideTimer.current)
        hideTimer.current = setTimeout(() => setNotice(null), 8000)
      }

      const restart = async () => {
        if (busy) return
        // The desktop app's own page restarts without ceremony; a plain browser
        // tab on the same Host would lose its connection for good, so ask first.
        const inDesktopShell = Boolean(window.dshDesktop) || window.location.protocol === 'dsh-app:'
        if (!inDesktopShell && !window.confirm(translate(t, 'browserWarning'))) return
        setBusy(true)
        setNotice(null)
        try {
          const response = await fetch(RESTART_URL, {
            method: 'POST',
            headers: { 'x-dsh-restart': '1' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(await readFailure(response))
          // The desktop shell closes this window shortly; keep showing progress.
        } catch (failure) {
          setBusy(false)
          showNotice(failure)
        }
      }

      const label = translate(t, busy ? 'restarting' : 'restart')
      const { icon, label: withLabel } = presentation(variant, wide)
      return h(
        React.Fragment,
        null,
        h('style', { key: 'dshr-control-style' }, CONTROL_CSS),
        h(
          'div',
          {
            key: 'dshr-root',
            className: 'dshr-root',
            'data-variant': variant,
            'data-wide': variant === 'sidebar' ? String(wide !== false) : undefined,
          },
          h(
            'button',
            {
              ref: buttonRef,
              type: 'button',
              className: 'dshr-button',
              title: label,
              'aria-label': label,
              disabled: busy,
              'data-busy': busy ? 'true' : undefined,
              onClick: restart,
            },
            h('span', { className: 'dshr-icon' }, h(RestartIcon, { size: icon })),
            withLabel ? h('span', { className: 'dshr-label' }, label) : null,
          ),
        ),
        notice === null
          ? null
          : createPortal(
            h(
              'div',
              { className: 'dshr-notice', role: 'alert', style: notice.anchor },
              h('div', { className: 'dshr-notice-title' }, translate(t, 'failed')),
              h('div', null, notice.message),
            ),
            document.body,
          ),
      )
    }

    /**
     * Settings → General row that picks the seat.
     * @param {object} props - slot props; the framework injects `t`.
     * @returns {object} the preference row.
     */
    function PlacementRow({ t }) {
      const placementId = usePlacement()
      const status = useStatus()
      const sidebarFree = useSidebarAvailable()
      const placement = PLACEMENTS.find((entry) => entry.id === placementId) ?? PLACEMENTS[0]

      const hints = [translate(t, `placement.${placement.id}.hint`)]
      if (placement.scope === 'session') hints.push(translate(t, 'placement.needsSession'))
      if (placement.id === 'sidebar-footer' && !sidebarFree) hints.push(translate(t, 'placement.sidebarBusy'))
      if (status === 'unsupported') hints.push(translate(t, 'placement.onlyDesktop'))

      return h(
        React.Fragment,
        null,
        h('style', { key: 'dshr-settings-style' }, SETTINGS_CSS),
        h(
          'div',
          { className: 'dshr-setting' },
          h(
            'div',
            { className: 'dshr-setting-text' },
            h('span', { className: 'dshr-setting-title' }, translate(t, 'placement.title')),
            h('span', { className: 'dshr-setting-hint' }, hints.join(' · ')),
          ),
          h(
            'select',
            {
              className: 'dshr-select',
              'aria-label': translate(t, 'placement.title'),
              value: placementId,
              onChange: (event) => setPlacement(event.target.value),
            },
            PLACEMENTS.map((entry) => h(
              'option',
              {
                key: entry.id,
                value: entry.id,
                disabled: entry.id === 'sidebar-footer' && !sidebarFree,
              },
              translate(t, `placement.${entry.id}`),
            )),
          ),
        ),
      )
    }

    /**
     * Pick the seat to mount now: the chosen one, or the default while the
     * chosen seat is unavailable.
     * @returns {{ placed: object, requested: object }} both catalog entries.
     */
    function resolvePlacement() {
      const requested = PLACEMENTS.find((entry) => entry.id === getPlacement()) ?? PLACEMENTS[0]
      if (requested.id === 'sidebar-footer' && !sidebarAvailable) {
        return { placed: PLACEMENTS[0], requested }
      }
      return { placed: requested, requested }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, 'zh', zh),
          'dsh-restart: zh dictionary',
        )
        ctx.effect(
          () => ctx.locale.register(NS, 'en', en),
          'dsh-restart: en dictionary',
        )

        slotsPort = ctx.slots
        refreshSidebar()
        ensureStatus()

        /** Dispose of the current seat registration, if any. */
        let disposeSeat = () => {}
        /** Seat id currently registered, for the no-op check. */
        let mountedSeat

        /** Mount (or re-point) the control at the resolved seat. */
        const mountSeat = () => {
          const { placed } = resolvePlacement()
          if (placed.id === mountedSeat) return
          disposeSeat()
          disposeSeat = () => {}
          mountedSeat = undefined
          const options = { name: placed.slot, locale: NS, inject: () => ({ variant: placed.variant }) }
          if (placed.kind === 'list') {
            options.id = 'dsh-restart'
            options.order = placed.order
          }
          try {
            disposeSeat = ctx.slots.inject(placed.slot, () => ctx.slots.register(options, RestartButton))
            mountedSeat = placed.id
          } catch (error) {
            console.error(`[dsh-restart] could not mount at ${placed.slot}`, error)
          }
        }

        ctx.effect(() => {
          const offPlacement = subscribePlacement(mountSeat)
          return () => offPlacement()
        }, 'dsh-restart: placement preference')

        try {
          ctx.effect(
            () => ctx.slots.subscribe('sidebar.footer.action', () => {
              refreshSidebar()
              mountSeat()
            }),
            'dsh-restart: sidebar seat',
          )
        } catch (error) {
          console.error('[dsh-restart] sidebar seat is not observable', error)
        }

        try {
          ctx.slots.inject('settings.general.item', () => ctx.slots.register(
            { name: 'settings.general.item', id: 'dsh-restart-placement', order: 20, locale: NS },
            PlacementRow,
          ))
        } catch (error) {
          console.error('[dsh-restart] settings row is unavailable', error)
        }

        ctx.effect(() => () => {
          disposeSeat()
          disposeSeat = () => {}
          mountedSeat = undefined
        }, 'dsh-restart: seat cleanup')

        mountSeat()
      },
    }
  },
})
