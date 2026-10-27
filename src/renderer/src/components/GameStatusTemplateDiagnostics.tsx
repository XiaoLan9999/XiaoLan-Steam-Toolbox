import type { GameStatusAppInfo, GameStatusTemplateDiagnostics as Diagnostics } from '../../../shared/game-status'
import { useI18n } from '../i18n'
import { richPresenceContract } from '../../../shared/rich-presence-contract'

export function GameStatusTemplateDiagnostics({ info, onRetry, disabled }: { info: GameStatusAppInfo; onRetry?(): void; disabled: boolean }): React.JSX.Element | null {
  const { t } = useI18n()
  const diagnostic = info.templateDiagnostics
  if (!diagnostic) return null
  const reasons: Record<Diagnostics['reason'], string> = {
    available: t('已取得可用的官方模板。', 'Published templates are available.'),
    empty: t('Steam 返回的本次公开目录为空；没有据此生成自定义模板。', 'Steam returned an empty published catalog. No custom template was invented.'),
    'lookup-unavailable': t('模板读取尚未完成，不能据此判断游戏不支持子状态。', 'The catalog lookup did not complete; this does not prove that substatus is unsupported.'),
    'invalid-catalog': t('返回目录未通过格式或容量校验，未使用异常数据。', 'The returned catalog failed its format or size checks and was not used.'),
    'no-safe-templates': t('已取得目录，但没有可安全解析的模板，或模板依赖不完整。', 'A catalog was received, but no safe templates could be parsed or their dependencies are incomplete.')
  }
  const codes: Record<NonNullable<Diagnostics['lookupCode']>, string> = {
    unavailable: t('Steam 接口暂未返回有效目录', 'Steam did not return a usable catalog'),
    timeout: t('等待 Steam 模板响应超时', 'The Steam catalog request timed out'),
    'invalid-response': t('模板响应格式或容量不符合要求', 'The catalog response failed its format or size checks'),
    cancelled: t('本次模板读取已取消', 'The catalog lookup was cancelled'),
    'language-missing': t('响应缺少请求的语言目录', 'The requested language is missing from the response'),
    'app-mismatch': t('响应 AppID 与当前游戏不同', 'The response AppID does not match the selected game')
  }
  const source = diagnostic.sourceLanguage === 'mixed' ? t('简体中文 + 英文补齐', 'Simplified Chinese + English fallback')
    : diagnostic.sourceLanguage === 'schinese' ? t('简体中文', 'Simplified Chinese')
      : diagnostic.sourceLanguage === 'english' ? t('英文', 'English') : t('未确认', 'Unconfirmed')
  const reason = Object.hasOwn(reasons, diagnostic.reason) ? reasons[diagnostic.reason] : reasons['lookup-unavailable']
  const lookup = diagnostic.lookupCode && Object.hasOwn(codes, diagnostic.lookupCode) ? codes[diagnostic.lookupCode] : null
  const count = Number.isInteger(diagnostic.rawTokenCount) && diagnostic.rawTokenCount! >= 0 && diagnostic.rawTokenCount! <= richPresenceContract.catalog.tokenCount * 2 ? diagnostic.rawTokenCount : null
  const steamResult = Number.isInteger(diagnostic.steamResult) && diagnostic.steamResult! >= richPresenceContract.lookup.steamResultMin && diagnostic.steamResult! <= richPresenceContract.lookup.steamResultMax ? diagnostic.steamResult : null
  return <section className="game-status-notice info" role="status" aria-label={t('模板读取详情', 'Template lookup details')}>
    <strong>{reason}</strong>
    <p>{t('目录语言', 'Catalog language')}: {source}{count !== null ? ` · ${t('目录项', 'Catalog entries')}: ${count}` : ''} · {t('可用模板', 'Usable templates')}: {info.templates.length}</p>
    {diagnostic.usedEnglishFallback && <p>{t('已使用英文目录补齐缺失模板或依赖；并非把获取失败当成游戏不支持。', 'English catalog entries were used for missing templates or dependencies; lookup failure is not treated as lack of game support.')}</p>}
    {lookup && <p>{lookup}{steamResult !== null ? ` · Steam EResult ${steamResult}` : ''}</p>}
    {onRetry && <button className="ghost" disabled={disabled} onClick={() => { if (!disabled) onRetry() }}>{t('重试读取模板（不修改状态）', 'Retry templates (no status changes)')}</button>}
  </section>
}
