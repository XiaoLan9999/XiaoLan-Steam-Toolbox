import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { exceedsDragThreshold, rowIndexAtOffset, selectFriendRange, selectionMode, toggleFriendSelection } from './friend-selection'
import type { RangeSelectionMode } from './friend-selection'

interface DragSelection {
  pointerId: number
  accountId: string
  ids: readonly string[]
  initial: Set<string>
  origin: number
  anchor: number
  end: number
  mode: RangeSelectionMode
  shift: boolean
  started: boolean
  startX: number
  startY: number
  clientY: number
  bottoms: number[]
}

export function useFriendSelection(
  accountId: string,
  ids: readonly string[],
  selected: Set<string>,
  onChange: (value: Set<string>) => void
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ accountId, ids, selected, onChange })
  latest.current = { accountId, ids, selected, onChange }
  const anchorId = useRef<string | null>(null)
  const drag = useRef<DragSelection | null>(null)
  const frame = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const stopDrag = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const current = drag.current
    drag.current = null
    const container = containerRef.current
    if (current && container?.hasPointerCapture(current.pointerId)) {
      container.releasePointerCapture(current.pointerId)
    }
    setDragging(false)
  }, [])

  useEffect(() => {
    anchorId.current = null
    stopDrag()
  }, [accountId, ids, stopDrag])

  useEffect(() => {
    window.addEventListener('blur', stopDrag)
    return () => {
      window.removeEventListener('blur', stopDrag)
      stopDrag()
    }
  }, [stopDrag])

  const toggle = useCallback((id: string, shift = false): void => {
    const current = latest.current
    const index = current.ids.indexOf(id)
    const anchor = anchorId.current ? current.ids.indexOf(anchorId.current) : -1
    let next: Set<string>
    if (shift && anchor >= 0 && index >= 0) {
      next = selectFriendRange(current.ids, current.selected, anchor, index, 'add')
    } else {
      next = toggleFriendSelection(current.selected, id)
      anchorId.current = id
    }
    latest.current.selected = next
    current.onChange(next)
  }, [])

  const publishRange = useCallback((active: DragSelection, force = false): void => {
    const container = containerRef.current
    if (!container) return
    const end = rowIndexAtOffset(active.bottoms, active.clientY - container.getBoundingClientRect().top + container.scrollTop)
    if (end < 0 || (!force && end === active.end)) return
    active.end = end
    const next = selectFriendRange(active.ids, active.initial, active.anchor, end, active.mode)
    latest.current.selected = next
    latest.current.onChange(next)
  }, [])

  const scrollDrag = useCallback(function tick(): void {
    const active = drag.current
    const container = containerRef.current
    if (!active?.started || !container) return
    if (active.accountId !== latest.current.accountId || active.ids !== latest.current.ids) {
      stopDrag()
      return
    }
    const bounds = container.getBoundingClientRect()
    const edge = 44
    const upper = Math.max(bounds.top, 0)
    const lower = Math.min(bounds.bottom, window.innerHeight)
    let velocity = 0
    if (active.clientY < upper + edge) velocity = -Math.min(18, (upper + edge - active.clientY) / 3)
    else if (active.clientY > lower - edge) velocity = Math.min(18, (active.clientY - lower + edge) / 3)
    if (velocity) container.scrollTop += velocity
    publishRange(active)
    frame.current = requestAnimationFrame(tick)
  }, [publishRange, stopDrag])

  const updateDragPosition = useCallback((clientX: number, clientY: number): void => {
    const active = drag.current
    if (!active) return
    if (active.accountId !== latest.current.accountId || active.ids !== latest.current.ids) {
      stopDrag()
      return
    }
    active.clientY = clientY
    if (!active.started) {
      if (!exceedsDragThreshold(active.startX, active.startY, clientX, clientY)) return
      active.started = true
      anchorId.current = active.ids[active.anchor]!
      setDragging(true)
      publishRange(active, true)
      frame.current = requestAnimationFrame(scrollDrag)
    } else {
      publishRange(active)
    }
  }, [publishRange, scrollDrag, stopDrag])

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.pointerType !== 'mouse') return
    const target = event.target as HTMLElement
    if (target.closest('a, button, input, select, textarea, [role="button"]')) return
    const row = target.closest<HTMLTableRowElement>('tr[data-friend-id]')
    const container = containerRef.current
    if (!row || !container || !container.contains(row)) return
    const current = latest.current
    const origin = current.ids.indexOf(row.dataset.friendId!)
    if (origin < 0) return
    event.preventDefault()
    stopDrag()
    const previousAnchor = anchorId.current ? current.ids.indexOf(anchorId.current) : -1
    const anchor = event.shiftKey && previousAnchor >= 0 ? previousAnchor : origin
    const mode = selectionMode(event.ctrlKey || event.metaKey, event.shiftKey, current.selected.has(current.ids[origin]!))
    const rect = container.getBoundingClientRect()
    // Cache geometry once; pointer movement only publishes when the range changes.
    const bottoms = Array.from(container.querySelectorAll<HTMLTableRowElement>('tr[data-friend-id]'))
      .map((item) => item.getBoundingClientRect().bottom - rect.top + container.scrollTop)
    const state: DragSelection = {
      pointerId: event.pointerId,
      accountId: current.accountId,
      ids: current.ids,
      initial: new Set(current.selected),
      origin,
      anchor,
      end: origin,
      mode,
      shift: event.shiftKey,
      started: false,
      startX: event.clientX,
      startY: event.clientY,
      clientY: event.clientY,
      bottoms
    }
    drag.current = state
    container.setPointerCapture(event.pointerId)
  }, [stopDrag])

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId === event.pointerId) updateDragPosition(event.clientX, event.clientY)
  }, [updateDragPosition])

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    // A fast drag can reach pointerup without any intermediate pointermove event.
    updateDragPosition(event.clientX, event.clientY)
    const clicked = drag.current === active && !active.started
    stopDrag()
    if (clicked) toggle(active.ids[active.origin]!, active.shift)
  }, [stopDrag, toggle, updateDragPosition])

  return { containerRef, dragging, beginDrag, moveDrag, finishDrag, stopDrag, toggle }
}
