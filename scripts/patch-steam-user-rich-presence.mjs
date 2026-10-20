import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const protoBefore = `message CMsgClientRichPresenceInfo {
	message RichPresence {
		optional fixed64 steamid_user = 1;
		optional bytes rich_presence_kv = 2;
	}

	repeated .CMsgClientRichPresenceInfo.RichPresence rich_presence = 1;
}`
const protoAfter = `message CMsgClientRichPresenceInfo {
	message KV {
		optional string key = 1;
		optional string value = 2;
	}

	message RichPresence {
		optional fixed64 steamid_user = 1;
		optional bytes rich_presence_kv = 2;
		repeated .CMsgClientRichPresenceInfo.KV rich_presense = 3;
	}

	repeated .CMsgClientRichPresenceInfo.RichPresence rich_presence = 1;
}`

const jsonBefore = `      "nested": {
        "RichPresence": {
          "fields": {
            "steamid_user": {
              "type": "fixed64",
              "id": 1
            },
            "rich_presence_kv": {
              "type": "bytes",
              "id": 2
            }
          }
        }
      }
    },
    "CMsgClientCheckFileSignature": {`
const jsonAfter = `      "nested": {
        "KV": {
          "fields": {
            "key": {
              "type": "string",
              "id": 1
            },
            "value": {
              "type": "string",
              "id": 2
            }
          }
        },
        "RichPresence": {
          "fields": {
            "steamid_user": {
              "type": "fixed64",
              "id": 1
            },
            "rich_presence_kv": {
              "type": "bytes",
              "id": 2
            },
            "rich_presense": {
              "rule": "repeated",
              "type": ".CMsgClientRichPresenceInfo.KV",
              "id": 3
            }
          }
        }
      }
    },
    "CMsgClientCheckFileSignature": {`

const requestBefore = `				// Response
				let response = {};
				body.rich_presence = body.rich_presence || [];
				for (let rp of body.rich_presence) {
					let kv = rp.rich_presence_kv;
					if (!kv || !rp.steamid_user) {
						continue;
					}

					try {
						let kvObj = BinaryKVParser.parse(kv); // This will throw in the event of there being no RP data (e.g. user not in game)
						if (kvObj && kvObj.RP) {
							response[rp.steamid_user] = {
								richPresence: kvObj.RP,
								localizedString: null,
							};
							// Do this separately as it will reject if it cannot localize
							response[rp.steamid_user].localizedString = await this._getRPLocalizedString(appid, kvObj.RP, language);
						}
					} catch (e) {
						// don't care, there's nothing here
					}
				}

				resolve({users: response});`

const requestAfter = String.raw`				// Steam changed response tag 2 (binary KV) to tag 3 (KV pairs).
				// Keep both formats; uploads still use the original binary format.
				let response = {};
				if (!body || typeof body !== 'object' || Array.isArray(body) || (body.rich_presence != null && !Array.isArray(body.rich_presence))) {
					return reject(new Error('Invalid rich presence response'));
				}
				let seenUsers = new Set();
				for (let rp of body.rich_presence || []) {
					let steamid;
					try {
						if (!rp || !rp.steamid_user) {
							continue;
						}
						steamid = Helpers.steamID(rp.steamid_user).getSteamID64();
						if (seenUsers.has(steamid)) {
							delete response[steamid];
							continue;
						}
						seenUsers.add(steamid);
						let modern = rp.rich_presense;
						if (modern != null && (!Array.isArray(modern) || modern.length > 20)) {
							throw new Error('Invalid rich presence pairs');
						}
						let pairs = modern && modern.length ? modern : null;
						let binary = rp.rich_presence_kv;
						let legacy = null;
						if (binary && binary.length) {
							legacy = readBinaryPresence(binary);
							validatePresence(legacy);
						}
						if (!pairs && !legacy) {
							continue;
						}
						let values = legacy;
						if (pairs) {
							values = {};
							for (let pair of pairs) {
								if (!pair || typeof pair.key !== 'string' || typeof pair.value !== 'string' || Object.hasOwnProperty.call(values, pair.key)) {
									throw new Error('Invalid rich presence pair');
								}
								Object.defineProperty(values, pair.key, {value: pair.value, enumerable: true, configurable: true, writable: true});
							}
							validatePresence(values);
							if (legacy && (Object.keys(values).length !== Object.keys(legacy).length || Object.keys(values).some(key => !Object.hasOwnProperty.call(legacy, key) || legacy[key] !== values[key]))) {
								throw new Error('Conflicting rich presence formats');
							}
						}
						response[steamid] = {richPresence: values, localizedString: null};
						try {
							response[steamid].localizedString = await this._getRPLocalizedString(appid, values, language);
						} catch (e) {
							// Missing localization does not invalidate decoded presence.
						}
					} catch (e) {
						// Never turn malformed data into an empty, apparently valid user.
						if (steamid) {
							delete response[steamid];
						}
					}
				}

				function readBinaryPresence(binary) {
					if (!Buffer.isBuffer(binary) || binary.length > 8192) {
						throw new Error('Invalid binary rich presence');
					}
					let offset = 0;
					function string() {
						let end = binary.indexOf(0, offset);
						if (end < 0) {
							throw new Error('Truncated binary rich presence');
						}
						let bytes = binary.subarray(offset, end);
						let value = bytes.toString('utf8');
						if (!Buffer.from(value, 'utf8').equals(bytes)) {
							throw new Error('Invalid binary rich presence text');
						}
						offset = end + 1;
						return value;
					}
					if (binary[offset++] !== 0 || string() !== 'RP') {
						throw new Error('Invalid binary rich presence root');
					}
					let values = {};
					while (offset < binary.length && binary[offset] !== 8) {
						if (binary[offset++] !== 1 || Object.keys(values).length >= 20) {
							throw new Error('Invalid binary rich presence field');
						}
						let key = string();
						let value = string();
						if (Object.hasOwnProperty.call(values, key)) {
							throw new Error('Duplicate binary rich presence key');
						}
						Object.defineProperty(values, key, {value, enumerable: true, configurable: true, writable: true});
					}
					if (binary[offset++] !== 8 || binary[offset++] !== 8 || offset !== binary.length) {
						throw new Error('Invalid binary rich presence ending');
					}
					return values;
				}

				function validatePresence(values) {
					if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 20) {
						throw new Error('Invalid rich presence values');
					}
					for (let [key, value] of Object.entries(values)) {
						if (!key || Buffer.byteLength(key) > 63 || typeof value !== 'string' || Buffer.byteLength(value) > 255 || /[\x00-\x1f\x7f]/.test(key) || /[\x00-\x1f\x7f]/.test(value)) {
							throw new Error('Invalid rich presence field');
						}
					}
				}

				resolve({users: response});`

// Hashes are the exact published steam-user@5.3.0 npm files, not local runtime data.
export const STEAM_USER_RP_PATCHES = Object.freeze([
  { file: 'protobufs/steammessages_clientserver_2.proto', sha256: 'fc1aeb9b04241ca22cb72b31b4f2bff845149fe83404ee4f6426131a4262eaa5', before: protoBefore, after: protoAfter },
  { file: 'protobufs/generated/steammessages_clientserver_2.json', sha256: '733f692bfdcc30ab70206aab7a519fc7b275329eda5423a41ed6e0dc5f16b7f0', before: jsonBefore, after: jsonAfter },
  { file: 'components/friends.js', sha256: '95b62cc8eb5ad8a2a23b41f084ffe302a1197105f177a7fe0e7dcb9cd74df015', before: requestBefore, after: requestAfter }
].map(patch => Object.freeze(patch)))

const hash = value => createHash('sha256').update(value).digest('hex')
function replaceOnce(source, before, after, file) {
  const offset = source.indexOf(before)
  if (offset === -1 || source.indexOf(before, offset + before.length) !== -1) throw new Error(`Unsupported steam-user rich-presence source: ${file}`)
  return source.slice(0, offset) + after + source.slice(offset + before.length)
}
function readRegular(path) {
  if (!lstatSync(path).isFile()) throw new Error('Expected a regular steam-user dependency file')
  return readFileSync(path, 'utf8')
}

function removeTemporary(path) {
  try { unlinkSync(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
}
function stageFile(path, content) {
  const temporary = `${path}.xiaolan-rp-${randomBytes(12).toString('hex')}.tmp`
  let descriptor
  let created = false
  try {
    descriptor = openSync(temporary, 'wx', lstatSync(path).mode & 0o777)
    created = true
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor); descriptor = undefined
    return temporary
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (created) removeTemporary(temporary)
    throw error
  }
}

export function patchSteamUserRichPresence(packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'steam-user'), fileOperations = { rename: renameSync }) {
  const root = resolve(packageDirectory)
  const metadata = JSON.parse(readRegular(resolve(root, 'package.json')))
  if (metadata.name !== 'steam-user' || metadata.version !== '5.3.0') throw new Error('Rich-presence compatibility requires exactly steam-user@5.3.0')

  // Validate the whole plan before changing any file. Unknown edits fail closed.
  const plan = STEAM_USER_RP_PATCHES.map(patch => {
    const path = resolve(root, patch.file)
    const source = readRegular(path)
    if (hash(source) === patch.sha256) return { file: patch.file, path, source, output: replaceOnce(source, patch.before, patch.after, patch.file) }
    const original = replaceOnce(source, patch.after, patch.before, patch.file)
    if (hash(original) !== patch.sha256) throw new Error(`Unrecognized steam-user@5.3.0 file: ${patch.file}`)
    return { file: patch.file, path, source, output: source }
  })
  const changed = plan.filter(item => item.source !== item.output)
  const staged = []
  const committed = []
  try {
    for (const item of changed) staged.push({ ...item, temporary: stageFile(item.path, item.output) })
    for (const item of staged) {
      if (readRegular(item.path) !== item.source) throw new Error(`Dependency changed during patch: ${item.file}`)
      fileOperations.rename(item.temporary, item.path)
      committed.push(item)
    }
  } catch (error) {
    const failures = []
    for (const item of committed.reverse()) {
      let temporary
      try {
        if (readRegular(item.path) !== item.output) throw new Error(`Dependency changed during rollback: ${item.file}`)
        temporary = stageFile(item.path, item.source)
        fileOperations.rename(temporary, item.path)
      } catch (rollbackError) { failures.push(rollbackError) }
      finally { if (temporary) removeTemporary(temporary) }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Dependency patch failed; rollback incomplete. Reinstall dependencies with npm ci before building.')
    throw error
  } finally {
    for (const item of staged) removeTemporary(item.temporary)
  }
  return { version: '5.3.0', changedFiles: changed.map(item => item.file), unchangedFiles: plan.filter(item => item.source === item.output).map(item => item.file) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length > 2) throw new Error('This dependency patch does not accept command-line arguments')
  const result = patchSteamUserRichPresence()
  console.log(`steam-user@${result.version} rich-presence compatibility: ${result.changedFiles.length ? 'patched' : 'already applied'}`)
}
