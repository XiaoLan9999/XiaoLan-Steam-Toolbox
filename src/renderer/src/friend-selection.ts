export type RangeSelectionMode = 'replace' | 'add' | 'remove'

export function toggleFriendSelection(initial: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(initial)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function exceedsDragThreshold(startX: number, startY: number, clientX: number, clientY: number): boolean {
  return (clientX - startX) ** 2 + (clientY - startY) ** 2 > 25
}

export function selectFriendRange(
  orderedIds: readonly string[],
  initial: ReadonlySet<string>,
  anchor: number,
  end: number,
  mode: RangeSelectionMode
): Set<string> {
  if (anchor < 0 || end < 0 || anchor >= orderedIds.length || end >= orderedIds.length) {
    return new Set(initial)
  }
  const next = mode === 'replace' ? new Set<string>() : new Set(initial)
  for (let index = Math.min(anchor, end); index <= Math.max(anchor, end); index++) {
    const id = orderedIds[index]!
    if (mode === 'remove') next.delete(id)
    else next.add(id)
  }
  return next
}

export function invertFriendSelection(
  orderedIds: readonly string[],
  initial: ReadonlySet<string>
): Set<string> {
  const next = new Set(initial)
  for (const id of new Set(orderedIds)) {
    if (next.has(id)) next.delete(id)
    else next.add(id)
  }
  return next
}

export function selectionMode(
  additive: boolean,
  range: boolean,
  originSelected: boolean
): RangeSelectionMode {
  if (range) return 'add'
  if (!additive) return 'replace'
  return originSelected ? 'remove' : 'add'
}

export function rowIndexAtOffset(bottoms: readonly number[], offset: number): number {
  if (bottoms.length === 0) return -1
  let low = 0
  let high = bottoms.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offset < bottoms[middle]!) high = middle
    else low = middle + 1
  }
  return low
}
