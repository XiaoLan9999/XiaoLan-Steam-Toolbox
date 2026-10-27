import type { AppSnapshot, FriendPolicy } from '../../shared/types'

export interface FriendPolicyUpdate { policy: FriendPolicy; revision: number }

export function applyFriendPolicy(snapshot: AppSnapshot, policy: FriendPolicy): AppSnapshot {
  if (snapshot.activeAccountId !== policy.accountId || !snapshot.friends.some(friend => friend.steamId === policy.steamId && friend.accountId === policy.accountId)) return snapshot
  const index = snapshot.friendPolicies.findIndex(item => item.steamId === policy.steamId && item.accountId === policy.accountId)
  const previous = snapshot.friendPolicies[index]
  if (previous && previous.blacklisted === policy.blacklisted && previous.commentStatus === policy.commentStatus &&
    previous.commentReason === policy.commentReason && previous.commentCheckedAt === policy.commentCheckedAt) return snapshot
  const policies = [...snapshot.friendPolicies]
  if (index < 0) policies.push({ ...policy })
  else policies[index] = { ...policy }
  return { ...snapshot, friendPolicies: policies }
}

export function applyFriendPolicyUpdates(snapshot: AppSnapshot, updates: Iterable<FriendPolicyUpdate>, afterRevision: number): AppSnapshot {
  let current = snapshot
  for (const update of updates) if (update.revision > afterRevision) current = applyFriendPolicy(current, update.policy)
  return current
}
