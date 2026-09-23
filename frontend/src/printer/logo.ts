/**
 * v1.4 — the tenant's mark on receipts.
 *
 * Both receipt builders are synchronous by design (`buildReceiptLayout` is a pure model the tests
 * exercise without a canvas; `buildReceiptXml` returns a string), so the mark is prepared **once,
 * ahead of time**: `prepareReceiptLogo(url)` loads the image and rasterises it to the two forms a
 * thermal head wants — a monochrome bitmap for the reader canvas and the packed 1-bit rows the
 * Epson ePOS `<image>` element takes — and the builders read the cache. No mark ready at print
 * time simply means no mark on that receipt; the receipt never waits.
 *
 * The mark is gold on transparent. Painted on white and thresholded, it becomes a clean black
 * silhouette, which is exactly what a 203 dpi thermal head prints best.
 */

export interface LogoRaster {
  /** dots — padded to a multiple of 8 */
  width: number
  height: number
  /** packed rows, 1 bit per dot, MSB first, 1 = black — base64 */
  base64: string
}

interface Prepared {
  url: string
  image: HTMLImageElement | null
  mono: HTMLCanvasElement | null
  raster: LogoRaster | null
}

let prepared: Prepared | null = null
let inflight: Promise<void> | null = null

/** Side of the mark on the 384-dot reader receipt. */
export const RECEIPT_LOGO_SIDE = 112
/** Width of the mark on an 80 mm Epson (576 dots) — a multiple of 8. */
export const EPOS_LOGO_WIDTH = 144

export function receiptLogoReady(url?: string | null): boolean {
  return !!url && !!prepared && prepared.url === url && !!prepared.mono
}

export function receiptLogoCanvas(url?: string | null): HTMLCanvasElement | null {
  return receiptLogoReady(url) ? prepared!.mono : null
}

export function receiptLogoRaster(url?: string | null): LogoRaster | null {
  return receiptLogoReady(url) ? prepared!.raster : null
}

/** Paint `img` on white at `side`×`side`, threshold to pure black/white. */
export function monoCanvas(img: CanvasImageSource, side: number, threshold = 168): HTMLCanvasElement | null {
  const c = document.createElement('canvas')
  c.width = side
  c.height = side
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, side, side)
  ctx.drawImage(img, 0, 0, side, side)
  const data = ctx.getImageData(0, 0, side, side)
  const d = data.data
  for (let i = 0; i < d.length; i += 4) {
    // alpha-composite over white first: a transparent dot is white, never black
    const a = d[i + 3] / 255
    const r = d[i] * a + 255 * (1 - a)
    const g = d[i + 1] * a + 255 * (1 - a)
    const b = d[i + 2] * a + 255 * (1 - a)
    const v = (r + g + b) / 3 < threshold ? 0 : 255
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(data, 0, 0)
  return c
}

/** Pack a monochrome canvas into ePOS-Print `<image>` rows (1 bit/dot, MSB first, 1 = black). */
export function packRaster(mono: HTMLCanvasElement): LogoRaster | null {
  const ctx = mono.getContext('2d')
  if (!ctx) return null
  const w = mono.width
  const h = mono.height
  const bytesPerRow = Math.ceil(w / 8)
  const out = new Uint8Array(bytesPerRow * h)
  const px = ctx.getImageData(0, 0, w, h).data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const black = px[(y * w + x) * 4] < 128
      if (black) out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  let bin = ''
  for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i])
  return { width: bytesPerRow * 8, height: h, base64: typeof btoa === 'function' ? btoa(bin) : '' }
}

function loadImage(url: string, timeoutMs = 4000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const t = setTimeout(() => reject(new Error('logo load timed out')), timeoutMs)
    img.onload = () => {
      clearTimeout(t)
      resolve(img)
    }
    img.onerror = () => {
      clearTimeout(t)
      reject(new Error('logo failed to load'))
    }
    img.src = url
  })
}

/** Load and rasterise the mark once per URL. Safe to call often; a failure leaves no mark. */
export async function prepareReceiptLogo(url?: string | null): Promise<void> {
  if (!url || typeof document === 'undefined') {
    prepared = null
    return
  }
  if (prepared && prepared.url === url) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const image = await loadImage(url)
      const mono = monoCanvas(image, RECEIPT_LOGO_SIDE)
      const wide = monoCanvas(image, EPOS_LOGO_WIDTH)
      prepared = { url, image, mono, raster: wide ? packRaster(wide) : null }
    } catch {
      prepared = { url, image: null, mono: null, raster: null }
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Tests / a brand change: forget the prepared mark. */
export function resetReceiptLogo(): void {
  prepared = null
  inflight = null
}
