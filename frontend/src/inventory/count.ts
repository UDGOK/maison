/**
 * Cycle-count comparison model (pure; mirrors `inventory.submit_cycle_count`).
 * The screen keeps the scanned set / counted map and derives progress + discrepancies.
 */
export interface CountExpected {
  serials: Record<string, string[]>
  qty: Record<string, number>
}

export interface CountProgress {
  expected_serials: number
  scanned_known: number
  unexpected: string[]
  missing: { item_code: string; serial_no: string }[]
  by_item: { item_code: string; expected: number; scanned: number }[]
  qty_differences: { item_code: string; expected: number; counted: number; diff: number }[]
  clean: boolean
}

export function compareCount(
  expected: CountExpected,
  scanned: Iterable<string>,
  counted: Record<string, number | null | undefined>
): CountProgress {
  const owner = new Map<string, string>()
  for (const [item, list] of Object.entries(expected.serials)) for (const s of list) owner.set(s, item)
  const set = new Set<string>()
  const unexpected: string[] = []
  for (const raw of scanned) {
    const s = String(raw).trim()
    if (!s || set.has(s) || unexpected.includes(s)) continue
    if (owner.has(s)) set.add(s)
    else unexpected.push(s)
  }
  const missing: CountProgress['missing'] = []
  const by_item: CountProgress['by_item'] = []
  for (const [item, list] of Object.entries(expected.serials)) {
    let n = 0
    for (const s of list) {
      if (set.has(s)) n++
      else missing.push({ item_code: item, serial_no: s })
    }
    by_item.push({ item_code: item, expected: list.length, scanned: n })
  }
  const qty_differences: CountProgress['qty_differences'] = []
  for (const [item, exp] of Object.entries(expected.qty)) {
    const c = counted[item]
    if (c === null || c === undefined || c === ('' as unknown)) continue
    const cv = Number(c)
    if (Number.isFinite(cv) && cv !== exp)
      qty_differences.push({ item_code: item, expected: exp, counted: cv, diff: cv - exp })
  }
  return {
    expected_serials: owner.size,
    scanned_known: set.size,
    unexpected,
    missing,
    by_item,
    qty_differences,
    clean: !missing.length && !unexpected.length && !qty_differences.length
  }
}
