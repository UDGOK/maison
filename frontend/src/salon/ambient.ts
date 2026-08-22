/**
 * v0.5 K — "light on metal": a slow, generative Canvas 2D animation for the Salon's ambient screen.
 *
 * A brushed-onyx plate (pre-rendered horizontal grain) lit by three soft champagne-gold sources that
 * drift on slow Lissajous paths, plus one long specular sweep every ~40 s. Everything is additive and
 * very low-contrast so it reads as a material, not a screensaver. Reduced-motion: a single still frame.
 * Budget: ~30 fps, a handful of gradient fills per frame, paused when the tab is hidden.
 */
export interface AmbientOptions {
  reducedMotion?: boolean
  fps?: number
  seed?: number
}

interface Light {
  ax: number
  ay: number
  fx: number
  fy: number
  px: number
  py: number
  rx: number
  ry: number
  hue: [number, number, number]
  alpha: number
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class AmbientLight {
  private ctx: CanvasRenderingContext2D | null
  private grain: HTMLCanvasElement | null = null
  private raf = 0
  private last = 0
  private t0 = 0
  private running = false
  private lights: Light[]
  private dpr = 1
  private w = 0
  private h = 0
  private readonly fps: number
  readonly reducedMotion: boolean
  private onVisibility = () => (document.hidden ? this.pause() : this.resume())

  constructor(
    private canvas: HTMLCanvasElement,
    opts: AmbientOptions = {}
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })
    this.fps = opts.fps ?? 30
    this.reducedMotion = opts.reducedMotion ?? (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    const rnd = mulberry32(opts.seed ?? 7)
    this.lights = [0, 1, 2].map((i) => ({
      ax: 0.32 + rnd() * 0.12,
      ay: 0.18 + rnd() * 0.1,
      fx: 0.011 + rnd() * 0.006,
      fy: 0.008 + rnd() * 0.005,
      px: rnd() * Math.PI * 2,
      py: rnd() * Math.PI * 2,
      rx: 0.62 + rnd() * 0.28,
      ry: 0.11 + rnd() * 0.06,
      hue: i === 1 ? [222, 200, 160] : [206, 172, 112],
      alpha: 0.2 + rnd() * 0.06
    }))
  }

  /** Size to the element's CSS box (call on resize). */
  resize() {
    const r = this.canvas.getBoundingClientRect()
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.w = Math.max(1, Math.round(r.width))
    this.h = Math.max(1, Math.round(r.height))
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
    this.grain = this.makeGrain(this.w, this.h)
    this.draw(this.elapsed())
  }

  start() {
    if (this.running || !this.ctx) return
    this.running = true
    this.t0 = performance.now() - 1000 * 12 // start mid-motion so the first frame is not symmetric
    this.resize()
    document.addEventListener('visibilitychange', this.onVisibility)
    if (this.reducedMotion) return // one still frame
    this.resume()
  }

  stop() {
    this.running = false
    this.pause()
    document.removeEventListener('visibilitychange', this.onVisibility)
  }

  private pause() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private resume() {
    if (!this.running || this.reducedMotion || this.raf) return
    const step = (now: number) => {
      this.raf = requestAnimationFrame(step)
      if (now - this.last < 1000 / this.fps) return
      this.last = now
      this.draw(this.elapsed())
    }
    this.raf = requestAnimationFrame(step)
  }

  private elapsed() {
    return (performance.now() - this.t0) / 1000
  }

  /** Fine horizontal brushing, drawn once per size: sparse hairlines, never banding. */
  private makeGrain(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w))
    c.height = Math.max(1, Math.round(h))
    const g = c.getContext('2d')!
    const rnd = mulberry32(99)
    g.clearRect(0, 0, c.width, c.height)
    for (let y = 0; y < c.height; y += 1) {
      if (rnd() < 0.62) continue
      const a = 0.006 + rnd() * 0.028
      g.fillStyle = `rgba(255,241,210,${a.toFixed(3)})`
      const x0 = rnd() * c.width * 0.6 - c.width * 0.3
      const len = c.width * (0.5 + rnd() * 0.8)
      g.fillRect(x0, y, len, 1)
    }
    return c
  }

  /** Public for tests / screenshots: render the frame for time `t` (seconds). */
  draw(t: number) {
    const ctx = this.ctx
    if (!ctx) return
    const { w, h, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // base plate
    const base = ctx.createLinearGradient(0, 0, 0, h)
    base.addColorStop(0, '#0d0c0a')
    base.addColorStop(0.5, '#0a0a09')
    base.addColorStop(1, '#070706')
    ctx.fillStyle = base
    ctx.fillRect(0, 0, w, h)

    ctx.globalCompositeOperation = 'lighter'
    // drifting soft lights
    for (const L of this.lights) {
      const x = w * (0.5 + L.ax * Math.sin(t * L.fx * Math.PI * 2 + L.px))
      const y = h * (0.5 + L.ay * Math.sin(t * L.fy * Math.PI * 2 + L.py))
      const rx = w * L.rx
      const ry = h * L.ry
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(1, ry / rx)
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
      const [r, gg, b] = L.hue
      g.addColorStop(0, `rgba(${r},${gg},${b},${L.alpha})`)
      g.addColorStop(0.35, `rgba(${r},${gg},${b},${L.alpha * 0.45})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(-rx, -rx, rx * 2, rx * 2)
      ctx.restore()
    }
    // specular sweep: a thin bright band crossing the plate every ~40 s
    const period = 40
    const phase = (t % period) / period
    if (phase < 0.35) {
      const p = phase / 0.35
      const cx = w * (-0.3 + 1.6 * p)
      const ease = Math.sin(p * Math.PI)
      const g = ctx.createLinearGradient(cx - w * 0.25, 0, cx + w * 0.25, 0)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(0.5, `rgba(232,214,178,${(0.09 * ease).toFixed(3)})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.save()
      ctx.transform(1, 0, -0.35, 1, 0, 0)
      ctx.fillRect(cx - w * 0.25 + h * 0.35, 0, w * 0.5, h)
      ctx.restore()
    }
    // brushed grain, masked by the light (multiplicative feel via low alpha over lit areas)
    if (this.grain) {
      ctx.globalAlpha = 0.8
      ctx.drawImage(this.grain, 0, 0, w, h)
      ctx.globalAlpha = 1
    }
    // a faint warm top light, like a picture lamp above the plate
    const top = ctx.createLinearGradient(0, 0, 0, h * 0.5)
    top.addColorStop(0, 'rgba(201,169,110,0.07)')
    top.addColorStop(1, 'rgba(201,169,110,0)')
    ctx.fillStyle = top
    ctx.fillRect(0, 0, w, h * 0.5)
    ctx.globalCompositeOperation = 'source-over'
    // vignette
    const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75)
    v.addColorStop(0, 'rgba(0,0,0,0)')
    v.addColorStop(1, 'rgba(0,0,0,0.55)')
    ctx.fillStyle = v
    ctx.fillRect(0, 0, w, h)
  }
}
