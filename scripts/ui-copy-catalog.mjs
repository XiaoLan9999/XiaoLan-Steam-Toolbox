import ts from 'typescript'
import { createHash } from 'node:crypto'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const han = /[\u3400-\u9fff]/u
const digest = value => createHash('sha256').update(value).digest('hex')
const sourceRoots = ['src/renderer/src', 'src/main', 'src/shared']
const visibleAttributes = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label'])
const ignoredAttributes = new Set(['className', 'id', 'key', 'href', 'src', 'type', 'name', 'value', 'role', 'htmlFor'])

async function sourceFiles(root) {
  const result = []
  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, item.name)
      if (item.isDirectory()) await walk(full)
      else if (/\.tsx?$/.test(item.name) && !/\.(?:test|spec|d)\.tsx?$/.test(item.name)) result.push(full)
    }
  }
  for (const path of sourceRoots) await walk(resolve(root, path))
  return result.sort()
}

function literalParts(node, file, constants, visited = new Set()) {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { parts: [node.text], expressions: [] }
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text], expressions = []
    for (const span of node.templateSpans) { expressions.push(span.expression.getText(file)); parts.push(span.literal.text) }
    return { parts, expressions }
  }
  if (ts.isIdentifier(node) && constants.has(node.text) && !visited.has(node.text)) {
    const entry = constants.get(node.text)
    return literalParts(entry.node, entry.file, constants, new Set([...visited, node.text]))
  }
  return null
}

function plain(parts) { return parts?.parts.join('') ?? '' }
function hasChinese(node, file, constants) { return han.test(plain(literalParts(node, file, constants))) }
function formatParts(value, expressions) {
  if (!value) return ''
  return value.parts.map((part, index) => part + (index < value.expressions.length ? `{p${expressions.indexOf(value.expressions[index]) + 1}}` : '')).join('')
}
function uiText(value) { return value.replace(/\r\n/g, '\n') }

export async function buildCatalog(root) {
  root = resolve(root)
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const parsed = []
  for (const path of await sourceFiles(root)) {
    const text = await readFile(path, 'utf8')
    parsed.push({ path: relative(root, path).replaceAll('\\', '/'), text, file: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) })
  }
  const constants = new Map(), ambiguous = new Set()
  for (const entry of parsed) {
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && /^APP_|^AUTHOR_|^COMPANY_/.test(node.name.text)) {
        if (constants.has(node.name.text)) ambiguous.add(node.name.text)
        else constants.set(node.name.text, { node: node.initializer, file: entry.file })
      }
      ts.forEachChild(node, visit)
    }
    visit(entry.file)
  }
  for (const key of ambiguous) constants.delete(key)
  const rows = [], rowsByKey = new Map()
  for (const entry of parsed) {
    const consumed = []
    const location = node => {
      const lc = entry.file.getLineAndCharacterOfPosition(node.getStart(entry.file))
      return `${entry.path}:${lc.line + 1}:${lc.character + 1}`
    }
    function add(zhNode, enNode, category, review = 'direct', supplied) {
      if ([zhNode, enNode].some(node => node && ts.isIdentifier(node))) review = 'branding-review'
      const zhParts = supplied?.zh !== undefined ? { parts: [supplied.zh], expressions: [] } : literalParts(zhNode, entry.file, constants)
      const enParts = supplied?.en !== undefined ? { parts: [supplied.en], expressions: [] } : literalParts(enNode, entry.file, constants)
      if (!zhParts && !enParts) return
      const expressions = [...new Set([...(zhParts?.expressions ?? []), ...(enParts?.expressions ?? [])])]
      const zh = uiText(formatParts(zhParts, expressions)), en = uiText(formatParts(enParts, expressions))
      if (!(zh.trim() || en.trim()) || !/[a-zA-Z\u3400-\u9fff]/u.test(zh + en)) return
      const signature = JSON.stringify([zh, en, expressions.length, review])
      let row = rowsByKey.get(signature)
      if (!row) {
        row = { id: `TXT-${digest(signature).slice(0, 12).toUpperCase()}`, module: `${entry.path.startsWith('src/renderer/') ? '界面' : entry.path.startsWith('src/main/') ? '主进程 / 系统提示' : '公共消息'} / ${basename(entry.path).replace(/\.tsx?$/, '')}`, zh, en,
          parameters: expressions.map((_, index) => `{p${index + 1}}`).join('、'), category, review, location: '', sites: [] }
        rowsByKey.set(signature, row); rows.push(row)
      }
      const nodes = [zhNode, enNode].filter(Boolean)
      for (const node of nodes) {
        const site = { file: entry.path, start: node.getStart(entry.file), end: node.end, source: node.getText(entry.file),
          language: node === zhNode ? 'zh' : 'en', expressions, location: location(node) }
        if (!row.sites.some(old => old.file === site.file && old.start === site.start && old.end === site.end)) row.sites.push(site)
        consumed.push([site.start, site.end])
      }
      row.location = [...new Set(row.sites.map(site => site.location))].join('\n')
    }
    function pair(a, b, category, review) {
      const left = literalParts(a, entry.file, constants), right = literalParts(b, entry.file, constants)
      if (!left || !right) return false
      if (han.test(plain(left)) && !han.test(plain(right))) { add(a, b, category, review); return true }
      if (han.test(plain(right)) && !han.test(plain(left))) { add(b, a, category, review); return true }
      return false
    }
    function pairs(node) {
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && node.expression.text === 't' || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't') && node.arguments.length >= 2) {
        add(node.arguments[0], node.arguments[1], '界面中英文', 'direct')
      } else if (ts.isConditionalExpression(node)) {
        if (pair(node.whenTrue, node.whenFalse, '条件显示文案', entry.path.includes('localization') ? 'linked-review' : 'direct')) return
        if (ts.isArrayLiteralExpression(node.whenTrue) && ts.isArrayLiteralExpression(node.whenFalse) && node.whenTrue.elements.length === node.whenFalse.elements.length) {
          node.whenTrue.elements.forEach((item, index) => pair(item, node.whenFalse.elements[index], '系统对话框按钮', 'linked-review'))
        }
      } else if (ts.isArrayLiteralExpression(node) && node.elements.length === 2) {
        pair(node.elements[0], node.elements[1], '消息翻译 / 对照', 'linked-review')
      }
      ts.forEachChild(node, pairs)
    }
    pairs(entry.file)
    function extra(node) {
      if (consumed.some(([start, end]) => node.getStart(entry.file) >= start && node.end <= end)) return
      if (ts.isJsxText(node)) {
        const text = uiText(node.text.replace(/\s+/g, ' ')).trim()
        if (han.test(text)) add(node, null, '界面固定文字', 'direct', { zh: text })
        else if (/[a-zA-Z]/.test(text)) add(null, node, '界面固定文字', 'direct', { en: text })
        return
      }
      const value = literalParts(node, entry.file, constants)
      if (value && !ts.isIdentifier(node)) {
        const text = plain(value), parent = node.parent
        if (/^\s*(?:param\s*\(|<!(?:doctype|DOCTYPE)|<html\b|\(\(\)\s*=>|function\b)/.test(text) && text.includes('\n')) return
        const attr = ts.isJsxAttribute(parent) ? parent.name.getText(entry.file) : undefined
        if (attr && ignoredAttributes.has(attr) || ts.isPropertyAssignment(parent) && parent.name === node || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return
        if (attr && visibleAttributes.has(attr) && /[a-zA-Z\u3400-\u9fff]/u.test(text)) {
          add(han.test(text) ? node : null, han.test(text) ? null : node, '输入提示 / 无障碍文字')
          return
        }
        if (entry.path.startsWith('src/renderer/') && !han.test(text) && /[a-zA-Z]/.test(text) &&
          (ts.isJsxExpression(parent) || ts.isPropertyAssignment(parent) && /^(?:label|title|text|description|caption|placeholder|name)$/.test(parent.name.getText(entry.file)))) {
          add(null, node, '界面英文固定文字', 'linked-review'); return
        }
        if (entry.path.endsWith('/branding.ts') && /[a-zA-Z]/.test(text) && !/https?:|\//.test(text)) {
          add(null, node, '品牌文字（仅改显示须复核）', 'branding-review'); return
        }
        if (entry.path.endsWith('/localization.ts') && /[a-zA-Z]{3}/.test(text) && (/\s/.test(text) || value.expressions.length > 0)) {
          add(null, node, '动态错误翻译（联动复核）', 'linked-review'); return
        }
        if (han.test(text)) {
          const branding = entry.path.endsWith('/branding.ts')
          const linked = entry.path.includes('localization') || !entry.path.startsWith('src/renderer/')
          add(node, null, branding ? '品牌文字（仅改显示须复核）' : linked ? '错误 / 提示（联动复核）' : '界面固定文字 / 提示', branding ? 'branding-review' : linked ? 'linked-review' : 'direct')
          return
        }
        if ((ts.isNewExpression(parent) || ts.isCallExpression(parent)) && /(?:Error|setError|setMessage|setNotice|setStatus)$/.test(parent.expression.getText(entry.file)) && /[a-zA-Z]{3}/.test(text) && !/^[A-Z0-9_:.\/-]+$/.test(text)) {
          add(null, node, '英文错误 / 提示', 'linked-review'); return
        }
      }
      ts.forEachChild(node, extra)
    }
    extra(entry.file)
  }
  rows.sort((a, b) => a.location.localeCompare(b.location, 'en'))
  const files = parsed.map(entry => ({ path: entry.path, sha256: digest(entry.text) }))
  return { schema: 1, catalogId: digest(JSON.stringify({ files, rows })).slice(0, 24), version: packageJson.version, files, rows,
    scope: '本工具箱源代码内的界面、系统对话框及错误提示；不含用户数据、Steam服务端动态内容或第三方网页',
    instructions: ['仅修改D列中文修改、F列英文修改；其他列请勿修改', '修改列已预填原文，空白视为保持原文；需要删除请填写[[DELETE]]并备注说明', '保留{p1}等动态参数，允许调整参数顺序，不可增删或重命名', '联动复核、安全和品牌类文字返回后会人工审阅，不会盲目全局替换', '不要在工作簿填写密码、令牌、验证码、Cookie、急救码或个人留言'] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '.')
  const output = resolve(root, process.argv[3] ?? 'out/ui-copy-catalog/catalog.json')
  const catalog = await buildCatalog(root)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(catalog, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ output, catalogId: catalog.catalogId, rows: catalog.rows.length, files: catalog.files.length }))
}
