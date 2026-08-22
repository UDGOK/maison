/**
 * Client-side image resize: longest edge ≤ `maxEdge` px, JPEG at `quality`. Uses
 * `createImageBitmap` (honours EXIF orientation in modern browsers) with an <img> fallback.
 */
export const MAX_EDGE = 1200
export const JPEG_QUALITY = 0.86

/** Target size for a source w×h so the longest edge is ≤ maxEdge (never upscales). */
export function fitWithin(w: number, h: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h, 1))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; release(): void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() }
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('Could not decode image'))
      i.src = url
    })
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

export async function resizeImage(file: Blob, maxEdge = MAX_EDGE, quality = JPEG_QUALITY): Promise<Blob> {
  const d = await decode(file)
  try {
    const { width, height } = fitWithin(d.width, d.height, maxEdge)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.fillStyle = '#ffffff' // flatten transparency onto white for JPEG
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(d.source, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality))
    if (!blob) throw new Error('Could not encode JPEG')
    return blob
  } finally {
    d.release()
  }
}
