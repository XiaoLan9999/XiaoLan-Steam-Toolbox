import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { I18nProvider, useI18n } from '../src/renderer/src/i18n'
import { ScreenshotImageQueue } from '../src/renderer/src/components/ScreenshotToolsPanel'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

vi.stubGlobal('React', React)
afterAll(() => vi.unstubAllGlobals())

function DynamicData({ value }: { value: string }): React.JSX.Element {
  const { t } = useI18n()
  return <output>{t(`数据：${value}`, `Data: ${value}`)}</output>
}

describe('fixed UI sentence punctuation boundaries', () => {
  it('keeps fixed translation copy free of terminal full stops without normalizing runtime values', () => {
    const root = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? files(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : [])
    const violations: string[] = []
    const terminal = (value: string): boolean => value.length > 1 && /[。.]$/.test(value) && !/\.{2,}$/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    for (const file of files(root)) {
      const source = readFileSync(file, 'utf8')
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const literal = (node: ts.StringLiteralLike | ts.TemplateLiteralToken): void => {
        if (terminal(node.text)) violations.push(`${relative(root, file)}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
      }
      const argument = (node: ts.Expression): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal(node)
        else if (ts.isTemplateExpression(node)) literal(node.templateSpans[node.templateSpans.length - 1]!.literal)
        else if (ts.isParenthesizedExpression(node)) argument(node.expression)
        else if (ts.isConditionalExpression(node)) { argument(node.whenTrue); argument(node.whenFalse) }
        else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) argument(node.right)
      }
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') node.arguments.forEach(argument)
        if (ts.isStringLiteral(node) && /(?:StatusCopyPanel|UpdatePanel)\.tsx$/.test(file)) {
          let ancestor: ts.Node | undefined = node.parent
          while (ancestor && !ts.isVariableDeclaration(ancestor)) ancestor = ancestor.parent
          if (ancestor && ts.isVariableDeclaration(ancestor) && ['errors', 'updateErrors'].includes(ancestor.name.getText(tree))) literal(node)
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    expect(violations).toEqual([])
  })

  it.each(['User.', 'Saved comment.', '草稿内容。', 'file.png.', 'https://example.invalid/path/file.png', '0.16.5'])('does not globally trim dynamic data %j', value => {
    const zh = renderToStaticMarkup(<I18nProvider language="zh-CN"><DynamicData value={value} /></I18nProvider>)
    const en = renderToStaticMarkup(<I18nProvider language="en"><DynamicData value={value} /></I18nProvider>)
    expect(zh).toContain(`数据：${value}</output>`)
    expect(en).toContain(`Data: ${value}</output>`)
  })

  it('keeps user-supplied file labels intact while fixed helper text loses its final period', () => {
    const html = renderToStaticMarkup(<I18nProvider language="en"><ScreenshotImageQueue images={[{
      id: 'synthetic-image', name: 'My artwork.png.', width: 640, height: 360, size: 100,
      previewUrl: '', resizeRequired: false
    }]} busy={false} onAdd={() => {}} onRemove={() => {}} onClear={() => {}} /></I18nProvider>)
    expect(html).toContain('title="My artwork.png."')
    expect(html).toContain('Remove My artwork.png.')
    expect(html).toContain('The source images are not modified</p>')
    expect(html).not.toContain('The source images are not modified.</p>')
  })
})
