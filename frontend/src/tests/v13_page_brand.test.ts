/**
 * v1.3.2 — the brand printed into the page shell (`window.awanz_brand`) is what every screen
 * shows before the first API answer. Until this release nothing read it, so a second tenant's
 * till said "CLOUDCHASERZ" until a store catalogue was loaded.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BRAND, normalizeBrand, pageBrand } from '@/brand/tokens'

const shell = window as unknown as { awanz_brand?: unknown }

describe('v1.3.2 — page-shell brand', () => {
  afterEach(() => {
    delete shell.awanz_brand
  })

  it('falls back to the built-in defaults when the shell carries nothing', () => {
    expect(pageBrand()).toBeNull()
    expect(normalizeBrand(null).brand_name).toBe(DEFAULT_BRAND.brand_name)
  })

  it('ignores a shell value that is not an object', () => {
    shell.awanz_brand = 'nope'
    expect(pageBrand()).toBeNull()
    shell.awanz_brand = ['nope']
    expect(pageBrand()).toBeNull()
  })

  it('reads the tenant from window.awanz_brand before any bootstrap', () => {
    shell.awanz_brand = {
      brand_name: 'Scents of Arabia',
      product_name: 'AWANZ POS by Scents of Arabia',
      wordmark_text: 'SCENTS OF ARABIA',
      sub_mark: 'روائح العرب',
      tagline: 'Fine Oud & Perfumes',
      vertical: 'Perfume',
      brand_logo: 'https://example.test/files/scents-of-arabia-mark.png'
    }
    const b = normalizeBrand(null)
    expect(b.brand_name).toBe('Scents of Arabia')
    expect(b.wordmark_text).toBe('SCENTS OF ARABIA')
    expect(b.sub_mark).toBe('روائح العرب')
    expect(b.tagline).toBe('Fine Oud & Perfumes')
    expect(b.vertical).toBe('Perfume')
    expect(b.brand_logo).toBe('https://example.test/files/scents-of-arabia-mark.png')
    expect(b.rewards_program_name).toBe('Scents of Arabia Rewards')
  })

  it('lets the API answer win over the shell, key by key — never the first tenant', () => {
    shell.awanz_brand = { brand_name: 'Scents of Arabia', tagline: 'Fine Oud & Perfumes', vertical: 'Perfume' }
    const b = normalizeBrand({ brand_name: 'Scents of Arabia Owasso' })
    expect(b.brand_name).toBe('Scents of Arabia Owasso')
    expect(b.tagline).toBe('Fine Oud & Perfumes')
    expect(b.vertical).toBe('Perfume')
    expect(b.tagline).not.toBe(DEFAULT_BRAND.tagline)
  })
})
