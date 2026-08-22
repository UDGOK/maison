/**
 * Client recognition (camera) — SCAFFOLD ONLY. Nothing in the POS performs recognition.
 *
 * This interface reserves the seam where a recognition backend would plug in. Any real
 * implementation MUST respect the legal constraints documented in frontend/README.md
 * ("Facial recognition: legal notice"): explicit per-client opt-in consent stored on the
 * Customer (`maison_face_consent` + `maison_face_consent_on`), BIPA (Illinois) written-release
 * and retention-schedule requirements, CCPA notice/deletion rights, and a visible in-store
 * notice. Without stored consent a provider must never return a customer match.
 *
 * Frames are never uploaded by the POS itself; `maison_face_id` on Customer is a reserved,
 * hidden field populated only by a consented enrolment flow that does not exist yet.
 */

export interface RecognitionFrame {
  /** Raw frame from the camera (ImageBitmap / video element / canvas). */
  source: ImageBitmap | HTMLVideoElement | HTMLCanvasElement
  width: number
  height: number
  /** ms since epoch */
  capturedAt: number
}

export interface RecognitionResult {
  /** Customer id (`Customer.name`) when a consented match is found. */
  customer?: string
  /** 0–1; providers should leave `customer` undefined below their own threshold. */
  confidence: number
}

export interface RecognitionProvider {
  /** Stable id for Settings / telemetry. */
  readonly id: string
  /** False until a real, consent-aware provider is configured. */
  readonly available: boolean
  identify(frame: RecognitionFrame): Promise<RecognitionResult>
}

/** Default provider: does nothing, never matches. */
export class NullProvider implements RecognitionProvider {
  readonly id = 'null'
  readonly available = false
  async identify(): Promise<RecognitionResult> {
    return { confidence: 0 }
  }
}

let current: RecognitionProvider = new NullProvider()

export function recognitionProvider(): RecognitionProvider {
  return current
}

/** Reserved for a future, consent-aware implementation. */
export function setRecognitionProvider(p: RecognitionProvider) {
  current = p
}
