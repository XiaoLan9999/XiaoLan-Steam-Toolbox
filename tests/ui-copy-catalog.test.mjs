import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCatalog } from '../scripts/ui-copy-catalog.mjs'

const roots = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(source, main = '') {
  const root = await mkdtemp(join(tmpdir(), 'toolbox-copy-test-')); roots.push(root)
  for (const path of ['src/renderer/src', 'src/main', 'src/shared']) await mkdir(join(root, path), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.18.1' }))
  await writeFile(join(root, 'src/renderer/src/Example.tsx'), source)
  await writeFile(join(root, 'src/main/example.ts'), main)
  return root
}

describe('source-only UI copy catalog', () => {
  it('extracts bilingual templates with stable numbered parameters and all source locations', async () => {
    const root = await fixture('const a = t(`完成 ${count} / ${total}`, `Done ${count} / ${total}`); const b = t(`完成 ${count} / ${total}`, `Done ${count} / ${total}`)')
    const first = await buildCatalog(root), second = await buildCatalog(root)
    expect(first.catalogId).toBe(second.catalogId)
    expect(first.rows).toHaveLength(1)
    expect(first.rows[0]).toMatchObject({ zh: '完成 {p1} / {p2}', en: 'Done {p1} / {p2}', parameters: '{p1}、{p2}' })
    expect(first.rows[0].sites).toHaveLength(4)
    expect(first.files).toHaveLength(2)
  })
  it('lists visible labels and accessibility text but excludes paths, classes and scripts', async () => {
    const root = await fixture('const view = <div className="中文类名" title="Title"><span>LOCAL PROJECT</span><input placeholder="输入文字" />{\'SteamID64\'}</div>', 'const script = `param(\n [string]$path\n # 安全脚本，不是界面文案\n)`')
    const catalog = await buildCatalog(root), text = catalog.rows.map(row => row.zh + row.en).join('\n')
    expect(text).toContain('LOCAL PROJECT'); expect(text).toContain('SteamID64'); expect(text).toContain('输入文字'); expect(text).toContain('Title')
    expect(text).not.toContain('中文类名'); expect(text).not.toContain('安全脚本')
  })
  it('flags lookup messages for linked review and preserves intentional literal whitespace', async () => {
    const root = await fixture('const x = t(" 空格 ", " Space ")', 'const map = [["操作失败", "Operation failed"]]; throw new Error("只读检查失败")')
    const catalog = await buildCatalog(root)
    expect(catalog.rows.find(row => row.zh === ' 空格 ')?.en).toBe(' Space ')
    expect(catalog.rows.find(row => row.zh === '操作失败')?.review).toBe('linked-review')
    expect(catalog.rows.find(row => row.zh === '只读检查失败')?.review).toBe('linked-review')
    expect(catalog.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
  })
  it('does not read arbitrary runtime or credential files outside the source roots', async () => {
    const root = await fixture('const x = t("示例", "Example")')
    await writeFile(join(root, 'account.maFile'), '{"shared_secret":"do-not-read"}')
    const catalog = await buildCatalog(root)
    expect(JSON.stringify(catalog)).not.toContain('do-not-read')
    expect(catalog.rows[0].id).toMatch(/^TXT-[A-F0-9]{12}$/)
  })
})
