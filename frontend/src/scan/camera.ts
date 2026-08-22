/**
 * Camera scanning driver. Prefers the native `BarcodeDetector` (Safari 17+, Chrome); falls back
 * to `@zxing/browser` (lazy-loaded so the bundle only pays for it when needed).
 */

export type CameraScannerKind = 'native' | 'zxing'

export interface CameraScanner {
  kind: CameraScannerKind
  /** Start streaming into `video` and call `onResult` for every decoded value (deduplicated). */
  start(video: HTMLVideoElement, onResult: (value: string, format: string) => void, onError?: (e: Error) => void): Promise<void>
  stop(): void
}

export const NATIVE_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'data_matrix', 'itf']

interface DetectedBarcode {
  rawValue: string
  format: string
}
interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?(): Promise<string[]>
}

export function nativeDetectorCtor(): BarcodeDetectorCtor | null {
  const w = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
  return typeof w.BarcodeDetector === 'function' ? w.BarcodeDetector : null
}

export async function hasNativeDetector(): Promise<boolean> {
  const ctor = nativeDetectorCtor()
  if (!ctor) return false
  try {
    const f = ctor.getSupportedFormats ? await ctor.getSupportedFormats() : NATIVE_FORMATS
    return f.includes('qr_code')
  } catch {
    return false
  }
}

export const VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
}

class NativeScanner implements CameraScanner {
  kind: CameraScannerKind = 'native'
  private stream: MediaStream | null = null
  private raf = 0
  private stopped = false
  private lastValue = ''
  private lastAt = 0

  async start(video: HTMLVideoElement, onResult: (v: string, f: string) => void, onError?: (e: Error) => void) {
    const Ctor = nativeDetectorCtor()!
    const supported = Ctor.getSupportedFormats ? await Ctor.getSupportedFormats() : NATIVE_FORMATS
    const detector = new Ctor({ formats: NATIVE_FORMATS.filter((f) => supported.includes(f)) })
    this.stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS)
    video.srcObject = this.stream
    video.setAttribute('playsinline', 'true')
    await video.play()
    this.stopped = false
    const tick = async () => {
      if (this.stopped) return
      try {
        if (video.readyState >= 2) {
          const codes = await detector.detect(video)
          for (const c of codes) {
            const now = Date.now()
            if (c.rawValue && (c.rawValue !== this.lastValue || now - this.lastAt > 2000)) {
              this.lastValue = c.rawValue
              this.lastAt = now
              onResult(c.rawValue, c.format)
            }
          }
        }
      } catch (e) {
        onError?.(e as Error)
      }
      if (!this.stopped) this.raf = window.setTimeout(tick, 120)
    }
    void tick()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.raf)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
  }
}

class ZxingScanner implements CameraScanner {
  kind: CameraScannerKind = 'zxing'
  private controls: { stop(): void } | null = null
  private lastValue = ''
  private lastAt = 0

  async start(video: HTMLVideoElement, onResult: (v: string, f: string) => void, onError?: (e: Error) => void) {
    const { BrowserMultiFormatReader } = await import('@zxing/browser')
    const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 150, delayBetweenScanSuccess: 800 })
    video.setAttribute('playsinline', 'true')
    this.controls = await reader.decodeFromConstraints(VIDEO_CONSTRAINTS, video, (result, err) => {
      if (result) {
        const text = result.getText()
        const now = Date.now()
        if (text && (text !== this.lastValue || now - this.lastAt > 2000)) {
          this.lastValue = text
          this.lastAt = now
          onResult(text, String(result.getBarcodeFormat()))
        }
      } else if (err && !/NotFound|Checksum|Format/i.test(err.name)) onError?.(err)
    })
  }

  stop() {
    this.controls?.stop()
    this.controls = null
  }
}

export async function createCameraScanner(): Promise<CameraScanner> {
  return (await hasNativeDetector()) ? new NativeScanner() : new ZxingScanner()
}

export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}
