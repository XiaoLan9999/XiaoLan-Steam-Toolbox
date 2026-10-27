import { isGameStatusPresenceParameter } from './game-status-presence'
import { isWellFormedPresenceText, richPresenceContract, richPresenceDisplayToken } from './rich-presence-contract'

const encoder = new TextEncoder()
const displayDirective = /\{#|%[A-Za-z0-9_:]+%/
const roomKey = new RegExp(richPresenceContract.fieldPolicy.experimentalSensitive, 'i')
const fail = (): never => { throw new Error('实验子状态必须使用有效的公开字段和 UTF-8 文字。') }

export function validateExperimentalPresence(value: unknown, reservedKeys = 0): Record<string, string> {
  if ((reservedKeys !== 0 && reservedKeys !== 2) || !value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) return fail()
  const entries = Object.entries(descriptors)
  if (!entries.length || entries.length > richPresenceContract.presence.maxKeys - reservedKeys) return fail()
  const result = Object.create(null) as Record<string, string>
  for (const [name, descriptor] of entries) {
    const key = name.toLowerCase()
    const segmentedName = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || Object.hasOwn(result, key) || (key !== 'steam_display' && (!isGameStatusPresenceParameter(key) || key !== 'matchgrouploc' && roomKey.test(segmentedName)))) return fail()
    const item = descriptor.value as unknown
    if (typeof item !== 'string' || !item.length || !isWellFormedPresenceText(item) || encoder.encode(item).length > richPresenceContract.presence.valueUtf8Bytes || (key === 'steam_display' ? !richPresenceDisplayToken.test(item) : displayDirective.test(item))) return fail()
    result[key] = item
  }
  return result
}
