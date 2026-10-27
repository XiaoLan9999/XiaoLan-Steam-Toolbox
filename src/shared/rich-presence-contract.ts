import contract from './rich-presence-contract.json'

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T
function freeze<T extends object>(value: T): Immutable<T> {
  for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item)
  return Object.freeze(value) as Immutable<T>
}
export const richPresenceContract = freeze(contract)
const parameter = new RegExp(`^[${contract.syntax.parameter}]{1,${contract.presence.keyAsciiLength}}(?![\\s\\S])`)
const sensitive = new RegExp(contract.fieldPolicy.sensitive, 'i')
const forbidden = new Set(contract.fieldPolicy.forbidden)
const exceptions = new Set(contract.fieldPolicy.exceptions)
export const richPresenceDisplayToken = new RegExp(`^#[${contract.syntax.displayToken}]{1,${contract.presence.displayTokenBodyLength}}(?![\\s\\S])`)

export function isRichPresenceParameter(key: string): boolean {
  const lower = key.toLowerCase()
  return parameter.test(key) && !forbidden.has(lower) && (exceptions.has(lower) || !sensitive.test(key))
}

export function isWellFormedPresenceText(text: string): boolean {
  if (/[\p{Cc}\u2028\u2029]/u.test(text)) return false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
