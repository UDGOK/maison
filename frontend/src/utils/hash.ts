/** SHA-256 hex (WebCrypto); falls back to a tiny pure-JS implementation for non-secure contexts. */
export async function sha256Hex(input: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  return sha256Sync(input)
}

// Compact SHA-256 for http:// LAN contexts where crypto.subtle is unavailable.
function sha256Sync(ascii: string): string {
  const rrot = (v: number, a: number) => (v >>> a) | (v << (32 - a))
  const words: number[] = []
  const len = ascii.length * 8
  let result = ''
  const k: number[] = []
  const h: number[] = []
  let primeCounter = 0
  const isComposite: Record<number, boolean> = {}
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 313; i += candidate) isComposite[i] = true
      h[primeCounter] = (Math.pow(candidate, 0.5) * 4294967296) | 0
      k[primeCounter++] = (Math.pow(candidate, 1 / 3) * 4294967296) | 0
    }
  }
  ascii += '\x80'
  while ((ascii.length % 64) - 56) ascii += '\x00'
  for (let i = 0; i < ascii.length; i++) {
    const j = ascii.charCodeAt(i)
    if (j >> 8) return ''
    words[i >> 2] |= j << (((3 - i) % 4) * 8)
  }
  words[words.length] = (len / 4294967296) | 0
  words[words.length] = len
  for (let j = 0; j < words.length; ) {
    const w = words.slice(j, (j += 16))
    const oldH = h.slice(0, 8)
    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15],
        w2 = w[i - 2]
      const a = h[0],
        e = h[4]
      const temp1 =
        h[7] +
        (rrot(e, 6) ^ rrot(e, 11) ^ rrot(e, 25)) +
        ((e & h[5]) ^ (~e & h[6])) +
        k[i] +
        (w[i] =
          i < 16 ? w[i] : (w[i - 16] + (rrot(w15, 7) ^ rrot(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rrot(w2, 17) ^ rrot(w2, 19) ^ (w2 >>> 10))) | 0)
      const temp2 = (rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22)) + ((a & h[1]) ^ (a & h[2]) ^ (h[1] & h[2]))
      h.splice(0, 0, (temp1 + temp2) | 0)
      h.pop()
      h[4] = (h[4] + temp1) | 0
    }
    for (let i = 0; i < 8; i++) h[i] = (h[i] + oldH[i]) | 0
  }
  for (let i = 0; i < 8; i++) for (let j = 3; j + 1; j--) result += ((h[i] >> (j * 8)) & 255).toString(16).padStart(2, '0')
  return result
}
