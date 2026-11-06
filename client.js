/**
 * dsh-restart — browser half.
 *
 * Renders one control in `conversation.header.leading`, the window's top-left
 * seat inside the conversation header (before the Session title, and mounted
 * even without a Session). The click posts to the Host route the Host half
 * registered; the Host starts its detached relauncher and the window closes.
 *
 * Nothing is rendered for a profile that cannot restart (a plain `dsh web`
 * server, or a browser tab on one), because the capability comes from the
 * Electron shell the page is running in.
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-restart'

    /** Host endpoints registered by `index.js`. */
    const STATUS_URL = '/dsh-restart/status'
    const RESTART_URL = '/dsh-restart/restart'

    /** Dictionary entries; `zh` and `en` are the two baseline locales. */
    const zh = {
      restart: '重启 DSH',
      restarting: '正在重启…',
      failed: '无法重启',
      browserWarning: '重启会关闭当前浏览器页面（新实例会使用新的端口），之后请从系统托盘重新打开应用。确定继续？',
    }
    const en = {
      restart: 'Restart DSH',
      restarting: 'Restarting…',
      failed: 'Restart failed',
      browserWarning: 'Restarting closes this browser page (the new instance listens on a new port). Reopen the app from the system tray afterwards. Continue?',
    }

    /** Copy used when the namespace translator is unavailable or not yet ready. */
    const FALLBACK = typeof document !== 'undefined' && /^zh/i.test(document.documentElement.lang ?? '') ? zh : en

    /**
     * Translate one key with the slot-injected translator, falling back to the
     * bundled English copy so the control never renders a bare key.
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

    const CSS = [
      '.dshr-root{position:relative;display:inline-flex;align-items:center;-webkit-app-region:no-drag}',
      '.dshr-button{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;line-height:1;cursor:pointer;white-space:nowrap;-webkit-app-region:no-drag;transition:background-color .12s ease,color .12s ease,border-color .12s ease}',
      '.dshr-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshr-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshr-button:disabled{cursor:default}',
      '.dshr-icon{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;flex:none}',
      '.dshr-button[data-busy] .dshr-icon{animation:dshr-spin .9s linear infinite}',
      '.dshr-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dshr-error{position:absolute;left:0;top:36px;z-index:60;width:max-content;max-width:240px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:16px;white-space:normal}',
      '.dshr-error-title{color:var(--dsw-alias-state-error-primary);font-weight:500;margin-bottom:2px}',
      '@keyframes dshr-spin{to{transform:rotate(360deg)}}',
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

    /** Restart glyph drawn with `currentColor`; no shipped icon package is loaded. */
    function RestartIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 15,
          height: 15,
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
     * Header action that asks the Host to relaunch the desktop application.
     * @param {object} props - slot props; the framework injects `t`.
     * @returns {object | null} the action, or null while unknown/unsupported.
     */
    function RestartButton({ t }) {
      const [supported, setSupported] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const hideTimer = React.useRef(undefined)

      React.useEffect(() => {
        let cancelled = false
        fetch(STATUS_URL, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (!cancelled) setSupported(payload !== null && payload.supported === true)
          })
          .catch(() => {
            if (!cancelled) setSupported(false)
          })
        return () => {
          cancelled = true
          clearTimeout(hideTimer.current)
        }
      }, [])

      if (supported !== true) return null

      const restart = async () => {
        if (busy) return
        // The desktop app's own page restarts without ceremony; a plain browser
        // tab on the same Host would lose its connection for good, so ask first.
        const inDesktopShell = Boolean(window.dshDesktop) || window.location.protocol === 'dsh-app:'
        if (!inDesktopShell && !window.confirm(translate(t, 'browserWarning'))) return
        setBusy(true)
        setError(null)
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
          setError(failure instanceof Error ? failure.message : String(failure))
          clearTimeout(hideTimer.current)
          hideTimer.current = setTimeout(() => setError(null), 8000)
        }
      }

      const label = translate(t, busy ? 'restarting' : 'restart')
      return h(
        React.Fragment,
        null,
        h('style', { key: 'dshr-style' }, CSS),
        h(
          'div',
          { key: 'dshr-root', className: 'dshr-root' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshr-button',
              title: label,
              'aria-label': label,
              disabled: busy,
              'data-busy': busy ? 'true' : undefined,
              onClick: restart,
            },
            h('span', { className: 'dshr-icon' }, h(RestartIcon, null)),
            h('span', { className: 'dshr-label' }, label),
          ),
          error === null
            ? null
            : h(
                'div',
                { className: 'dshr-error', role: 'alert' },
                h('div', { className: 'dshr-error-title' }, translate(t, 'failed')),
                h('div', null, error),
              ),
        ),
      )
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
        ctx.slots.inject('conversation.header.leading', () =>
          ctx.slots.register(
            { name: 'conversation.header.leading', locale: NS },
            RestartButton,
          ),
        )
      },
    }
  },
})
