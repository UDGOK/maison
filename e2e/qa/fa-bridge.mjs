// FINAL ACCEPTANCE — same sandbox transport bridge as ../cloud-bridge.mjs, with one addition:
// a *document* response that is a 3xx is turned into a tiny HTML page that navigates to the
// Location target. Chromium follows a redirect fulfilled through `route.fulfill` on a connection
// that is NOT intercepted (the egress proxy then resets it), so `/shop/cart` -> `/shop/register`
// died with ERR_CONNECTION_RESET; re-issuing the hop as a fresh navigation keeps every request on
// the bridge and leaves `page.url()` correct. Sandbox plumbing only; no application code involved.
export async function installBridge(context, { onWsFrame = () => {}, isOffline = () => false } = {}) {
  await context.route('**/*', async (route) => {
    if (isOffline()) return route.abort('internetdisconnected').catch(() => {})
    const req = route.request()
    const isDoc = req.resourceType() === 'document'
    try {
      const resp = await route.fetch({ maxRedirects: isDoc ? 0 : 20, timeout: 60000 })
      const loc = resp.headers()['location']
      if (isDoc && resp.status() >= 300 && resp.status() < 400 && loc) {
        const target = new URL(loc, req.url()).toString()
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><meta name="x-bridge-redirect" content="${resp.status()}"><script>location.replace(${JSON.stringify(target)})</script>`
        })
        return
      }
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
