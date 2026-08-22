// Copies the face-api model weights (tiny_face_detector, face_landmark_68_tiny, face_recognition)
// and the TF.js WASM backend binaries from node_modules into public/models/. Run after upgrading
// @vladmandic/face-api or @tensorflow/tfjs-backend-wasm:  node scripts/copy-models.mjs
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const src = resolve(root, 'node_modules/@vladmandic/face-api/model')
const wasm = resolve(root, 'node_modules/@tensorflow/tfjs-backend-wasm/dist')
const out = resolve(root, 'public/models')
mkdirSync(resolve(out, 'wasm'), { recursive: true })
let bytes = 0
for (const f of readdirSync(src)) {
  if (!/^(tiny_face_detector|face_landmark_68_tiny|face_recognition)_model/.test(f)) continue
  copyFileSync(resolve(src, f), resolve(out, f))
  bytes += statSync(resolve(out, f)).size
  console.log('models/' + f)
}
for (const f of readdirSync(wasm)) {
  if (!f.endsWith('.wasm')) continue
  copyFileSync(resolve(wasm, f), resolve(out, 'wasm', f))
  bytes += statSync(resolve(out, 'wasm', f)).size
  console.log('models/wasm/' + f)
}
console.log(`${(bytes / 1024 / 1024).toFixed(2)} MB total`)
