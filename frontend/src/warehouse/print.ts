/**
 * v0.6 P — silent printing from the wall: the document (packing list `/printview?...` or the label
 * PDF) is loaded into a hidden iframe and `contentWindow.print()` is called. With Chrome started as
 * `--kiosk --kiosk-printing` the dialog is skipped and the default printer prints (docs/shipping.md).
 *
 * Every job is recorded on `window.__maisonLastWallPrint` (and a `maison-wall-print` event fires) so the
 * e2e can assert the hook without a printer.
 */
export interface WallPrintJob {
  kind: 'packing_list' | 'label'
  url: string
  shipment: string
  at: string
  /** how the job was dispatched: iframe print, opened in a new window (PDF), or dry-run (tests) */
  via: 'iframe' | 'window' | 'dry'
}

declare global {
  interface Window {
    __maisonLastWallPrint?: WallPrintJob
    __maisonWallPrints?: WallPrintJob[]
    __maisonWallPrintDry?: boolean
  }
}

const FRAME_ID = 'maison-wall-print-frame'
let queue: Promise<void> = Promise.resolve()

function record(job: WallPrintJob) {
  window.__maisonLastWallPrint = job
  window.__maisonWallPrints = [...(window.__maisonWallPrints || []), job].slice(-50)
  window.dispatchEvent(new CustomEvent('maison-wall-print', { detail: job }))
}

function isPdf(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url)
}

/** Print one document; jobs run one after the other (a second iframe print while the first is open is dropped by Chrome). */
export function printDocument(kind: WallPrintJob['kind'], url: string, shipment: string): Promise<WallPrintJob> {
  const run = (): Promise<WallPrintJob> =>
    new Promise((resolve) => {
      const job: WallPrintJob = { kind, url, shipment, at: new Date().toISOString(), via: 'iframe' }
      if (typeof document === 'undefined' || window.__maisonWallPrintDry) {
        job.via = 'dry'
        record(job)
        resolve(job)
        return
      }
      // Cross-origin PDFs (a real Shippo label) cannot be printed from an iframe: open them, kiosk-printing prints.
      let sameOrigin = true
      try {
        sameOrigin = new URL(url, location.href).origin === location.origin
      } catch {
        sameOrigin = false
      }
      if (!sameOrigin || (isPdf(url) && !/Chrome/i.test(navigator.userAgent))) {
        job.via = 'window'
        window.open(url, '_blank', 'noopener')
        record(job)
        resolve(job)
        return
      }
      let frame = document.getElementById(FRAME_ID) as HTMLIFrameElement | null
      if (frame) frame.remove()
      frame = document.createElement('iframe')
      frame.id = FRAME_ID
      frame.setAttribute('aria-hidden', 'true')
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0'
      let done = false
      const finish = () => {
        if (done) return
        done = true
        record(job)
        resolve(job)
        // keep the frame a little so the print spooler has the document, then drop it
        setTimeout(() => frame?.remove(), 15_000)
      }
      frame.onload = () => {
        try {
          const w = frame!.contentWindow
          if (w) {
            w.focus()
            // PDFs in Chrome's viewer need a tick before print() renders
            setTimeout(() => {
              try {
                w.print()
              } catch {
                /* blocked */
              }
              finish()
            }, isPdf(url) ? 600 : 150)
            return
          }
        } catch {
          /* cross-origin after redirect */
        }
        finish()
      }
      frame.onerror = finish
      setTimeout(finish, 12_000)
      frame.src = url
      document.body.appendChild(frame)
    })
  const next = queue.then(run)
  queue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

export function packingListUrl(shipment: string): string {
  return `/printview?doctype=Maison%20Shipment&name=${encodeURIComponent(shipment)}&format=Maison%20Packing%20List&no_letterhead=1`
}
