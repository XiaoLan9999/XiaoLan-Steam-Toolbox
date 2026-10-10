import { describe, expect, it } from 'vitest'
import { exceedsDragThreshold, invertFriendSelection, rowIndexAtOffset, selectFriendRange, selectionMode, toggleFriendSelection } from '../src/renderer/src/friend-selection'

describe('friend range selection', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']

  it('adds a clicked friend without clearing 1000 existing selections', () => {
    const initial = new Set(Array.from({ length: 1000 }, (_, index) => String(index)))
    const next = toggleFriendSelection(initial, '1000')
    expect(next.size).toBe(1001)
    expect([...initial].every((id) => next.has(id))).toBe(true)
    expect(initial.size).toBe(1000)
  })

  it('removes only the clicked friend and preserves hidden selections', () => {
    expect([...toggleFriendSelection(new Set(['a', 'b', 'hidden']), 'a')]).toEqual(['b', 'hidden'])
  })

  it('requires movement beyond five pixels, including diagonal movement', () => {
    expect(exceedsDragThreshold(20, 30, 20, 30)).toBe(false)
    expect(exceedsDragThreshold(20, 30, 23, 34)).toBe(false)
    expect(exceedsDragThreshold(20, 30, 25, 30)).toBe(false)
    expect(exceedsDragThreshold(20, 30, 24, 34)).toBe(true)
    expect(exceedsDragThreshold(20, 30, 14, 30)).toBe(true)
  })

  it('replaces selection with an inclusive dragged range', () => {
    expect([...selectFriendRange(ids, new Set(['e']), 1, 3, 'replace')]).toEqual(['b', 'c', 'd'])
  })

  it('supports upward dragging', () => {
    expect([...selectFriendRange(ids, new Set(), 4, 2, 'replace')]).toEqual(['c', 'd', 'e'])
  })

  it('adds a range without clearing hidden selections', () => {
    expect([...selectFriendRange(ids, new Set(['hidden']), 0, 2, 'add')]).toEqual(['hidden', 'a', 'b', 'c'])
  })

  it('subtracts a range and preserves selected items outside it', () => {
    expect([...selectFriendRange(ids, new Set([...ids, 'hidden']), 1, 3, 'remove')]).toEqual(['a', 'e', 'hidden'])
  })

  it('shrinks the dragged range against the initial selection, not the last frame', () => {
    const initial = new Set(['e'])
    selectFriendRange(ids, initial, 0, 3, 'add')
    expect([...selectFriendRange(ids, initial, 0, 1, 'add')]).toEqual(['e', 'a', 'b'])
    expect([...initial]).toEqual(['e'])
  })

  it('ignores stale or missing range anchors', () => {
    expect([...selectFriendRange(ids, new Set(['a']), -1, 4, 'replace')]).toEqual(['a'])
    expect([...selectFriendRange(ids, new Set(['a']), 0, 5, 'replace')]).toEqual(['a'])
  })

  it('handles a 1005-person range without a batch-sized limit', () => {
    const large = Array.from({ length: 1005 }, (_, index) => String(index))
    expect(selectFriendRange(large, new Set(), 0, 1004, 'replace').size).toBe(1005)
  })

  it('inverts only filtered IDs and treats duplicates once', () => {
    expect([...invertFriendSelection(['a', 'b', 'b'], new Set(['a', 'hidden']))]).toEqual(['hidden', 'b'])
  })

  it('adds an unmodified dragged range whether its origin is already selected or not', () => {
    expect(selectionMode(false, false, false)).toBe('add')
    expect(selectionMode(false, false, true)).toBe('add')
    for (const originSelected of [false, true]) {
      const initial = new Set(['e', 'hidden', ...(originSelected ? ['b'] : [])])
      const next = selectFriendRange(ids, initial, 1, 3, selectionMode(false, false, originSelected))
      expect([...initial].every((id) => next.has(id))).toBe(true)
      expect(next).toEqual(new Set(['b', 'c', 'd', 'e', 'hidden']))
    }
  })

  it('uses modifier and origin state to choose additive or subtractive dragging', () => {
    expect(selectionMode(true, false, false)).toBe('add')
    expect(selectionMode(true, false, true)).toBe('remove')
    expect(selectionMode(false, true, true)).toBe('add')
    expect(selectionMode(true, true, true)).toBe('add')
  })

  it('locates variable-height rows and clamps beyond either edge', () => {
    const bottoms = [40, 100, 180]
    expect(rowIndexAtOffset(bottoms, -20)).toBe(0)
    expect(rowIndexAtOffset(bottoms, 39)).toBe(0)
    expect(rowIndexAtOffset(bottoms, 40)).toBe(1)
    expect(rowIndexAtOffset(bottoms, 101)).toBe(2)
    expect(rowIndexAtOffset(bottoms, 500)).toBe(2)
    expect(rowIndexAtOffset([], 0)).toBe(-1)
  })
})
