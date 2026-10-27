import React, { type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '../src/shared/types'

const state = vi.hoisted(() => ({ view: 'normal' }))
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useState: (initial: unknown) => initial === 'normal' ? [state.view, (value: string) => { state.view = value }]
      : [typeof initial === 'function' ? initial() : initial, () => undefined],
    useEffect: () => undefined, useMemo: (calculate: () => unknown) => calculate(),
    useCallback: (callback: unknown) => callback, useRef: (current: unknown) => ({ current })
  }
})
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ language: 'en', t: (_zh: string, en: string) => en }) }))
import { FriendsPanel } from '../src/renderer/src/components/FriendsPanel'

const accountId = '76561198000000001'
const at = '2026-10-27T01:00:00.000Z'
const id = (n: number) => String(76561198000000100n + BigInt(n))
const data = { accounts: [{ id: accountId, sessionState: 'authenticated' }], activeAccountId: accountId,
  friends: [1, 2, 3, 4].map(n => ({ accountId, steamId: id(n), displayName: `Friend ${n}`, groupIds: [], syncedAt: at, onlineState: 'offline' })),
  friendPolicies: [1, 2, 3, 4].map(n => ({ accountId, steamId: id(n), blacklisted: n === 2,
    commentStatus: n <= 2 ? 'blocked' : n === 3 ? 'unknown' : 'allowed', commentReason: null, commentCheckedAt: at })),
  friendRemovals: [], friendNameChanges: [], groups: [], commentScan: null } as unknown as AppSnapshot
const nodes = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? [] : Array.isArray(value)
  ? value.flatMap(nodes) : [value as ReactElement<any>, ...nodes((value as ReactElement<any>).props?.children)]
const text = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ReactElement<any>).props?.children) : ''
function panel(selected: Set<string>, onSelectedChange = vi.fn()) {
  const root = FriendsPanel({ snapshot: data, selected, onSelectedChange, onCompose: () => undefined, runAction: async () => null })
  const button = (label: string) => {
    const value = nodes(root).find(node => node.type === 'button' && text(node.props.children).startsWith(label))
    if (!value) throw new Error(`Missing ${label}`)
    return value.props
  }
  return { button, changed: onSelectedChange }
}

afterEach(() => { state.view = 'normal'; vi.unstubAllGlobals() })

describe('selection across automatic availability categories', () => {
  it('does not discard existing selections when switching categories', () => {
    vi.stubGlobal('React', React)
    const selected = new Set([id(1), id(3)])
    const f = panel(selected)
    f.button('Comments unavailable').onClick()
    expect(state.view).toBe('unavailable')
    expect(f.changed).not.toHaveBeenCalled()
    expect([...selected]).toEqual([id(1), id(3)])
  })

  it('adds only the current view when selecting all, preserving selections from other views', () => {
    vi.stubGlobal('React', React)
    const selected = new Set([id(1)])
    const regular = panel(selected)
    regular.button('Select filtered').onClick()
    expect([...regular.changed.mock.calls[0]![0]].sort()).toEqual([id(1), id(3), id(4)])
    state.view = 'unavailable'
    const unavailable = panel(new Set([id(3)]))
    unavailable.button('Select filtered').onClick()
    expect([...unavailable.changed.mock.calls[0]![0]].sort()).toEqual([id(1), id(2), id(3)])
  })
})
