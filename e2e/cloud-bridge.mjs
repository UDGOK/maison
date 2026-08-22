// Transport bridge for running the Playwright e2e against a remote HTTPS site from inside this sandbox.
// Chromium's own TLS connections are reset by the egress proxy (curl/Node are fine), so every HTTP
// request is intercepted with context.route and performed by Playwright's Node-side request context
// (which honours HTTPS_PROXY / NODE_EXTRA_CA_CERTS), and every WebSocket is relayed through Node's
// built-in WebSocket (NODE_USE_ENV_PROXY=1). Page URLs/origins are unchanged (still https://<host>), so
// cookies, service workers, secure-context checks and Google Fonts behave exactly as in a real browser.
//
// Nothing here touches application code; it is purely sandbox plumbing.

export async function installBridge(context, { onWsFrame = () => {}, isOffline = () => false } = {}) {
  await context.route('**/*', async (route) => {
    if (isOffline()) return route.abort('internetdisconnected').catch(() => {})
    try {
      const resp = await route.fetch({ maxRedirects: 0, timeout: 60000 })
      await route.fulfill({ response: resp })
    } catch (e) {
      await route.abort('connectionfailed').catch(() => {})
    }
  })

  await context.routeWebSocket(/.*/, async (ws) => {
    const url = ws.url()
    if (isOffline()) { ws.close({ code: 1006, reason: 'offline' }); return }
    const cookies = await context.cookies(url.replace(/^ws/, 'http'))
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    const origin = new URL(url.replace(/^ws/, 'http')).origin
    onWsFrame({ url })
    let server
    try {
      server = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } })
    } catch (e) {
      onWsFrame({ err: String(e) }); ws.close({ code: 1006, reason: 'bridge' }); return
    }
    const queue = []
    let open = false
    server.onopen = () => { open = true; for (const m of queue) server.send(m); queue.length = 0 }
    server.onmessage = (m) => { const d = typeof m.data === 'string' ? m.data : Buffer.from(m.data); onWsFrame({ in: String(d).slice(0, 200) }); ws.send(d) }
    server.onerror = (e) => { onWsFrame({ err: String(e.message || e) }) }
    server.onclose = (e) => { ws.close({ code: e.code === 1005 ? 1000 : e.code, reason: e.reason || '' }).catch?.(() => {}) }
    ws.onMessage((m) => { onWsFrame({ out: String(m).slice(0, 120) }); open ? server.send(m) : queue.push(m) })
    ws.onClose((code, reason) => { try { server.close(code && code >= 1000 && code !== 1005 && code !== 1006 ? code : 1000, reason) } catch {} })
  })
}
