import { richPresenceContract } from './rich-presence-contract'

export const GROUP_SIZE_KEY = 'steam_player_group_size'
export const MAX_GROUP_SIZE = richPresenceContract.presence.maxGroupSize

export function validGroupSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_GROUP_SIZE
}

export function readGroupSize(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value)) return null
  const size = Number(value)
  return validGroupSize(size) ? size : null
}
