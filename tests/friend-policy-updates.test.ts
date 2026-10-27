import { describe, expect, it } from 'vitest'
import type { AppSnapshot, FriendPolicy } from '../src/shared/types'
import { applyFriendPolicy, applyFriendPolicyUpdates } from '../src/renderer/src/friend-policy-updates'

const accountId = '76561198000000001'
const steamId = '76561198000000002'
const policy: FriendPolicy = { accountId, steamId, blacklisted: true, commentStatus: 'blocked',
  commentReason: 'Explicit permission denial', commentCheckedAt: '2026-10-27T00:00:00.000Z' }
const snapshot = () => ({ activeAccountId: accountId, friends: [{ steamId, accountId }], friendPolicies: [] }) as unknown as AppSnapshot

describe('bounded friend policy UI updates', () => {
  it('patches only the policy without changing friends, groups or existing selection inputs', () => {
    const state = snapshot()
    const next = applyFriendPolicy(state, policy)
    expect(next).not.toBe(state)
    expect(next.friends).toBe(state.friends)
    expect(state.friendPolicies).toEqual([])
    expect(next.friendPolicies).toEqual([policy])
    expect(next.friendPolicies[0]).not.toBe(policy)
    expect(applyFriendPolicy(next, { ...policy })).toBe(next)
  })

  it('does not borrow a matching SteamID from another account or recreate removed friends', () => {
    const state = snapshot()
    expect(applyFriendPolicy(state, { ...policy, accountId: '76561198000000003' })).toBe(state)
    expect(applyFriendPolicy({ ...state, friends: [] }, policy).friendPolicies).toEqual([])
  })

  it('replaces the same friend in place without accumulating updates', () => {
    let state = snapshot()
    for (let index = 0; index < 1000; index++) state = applyFriendPolicy(state, { ...policy, commentReason: `Attempt ${index}` })
    expect(state.friendPolicies).toHaveLength(1)
    expect(state.friendPolicies[0]!.commentReason).toBe('Attempt 999')
  })

  it('keeps newer event revisions over an in-flight stale full snapshot', () => {
    const next = applyFriendPolicyUpdates(snapshot(), [
      { policy: { ...policy, commentStatus: 'unknown' }, revision: 4 },
      { policy, revision: 6 }
    ], 5)
    expect(next.friendPolicies).toEqual([policy])
    expect(applyFriendPolicyUpdates(snapshot(), [{ policy, revision: 6 }], 6).friendPolicies).toEqual([])
  })
})
