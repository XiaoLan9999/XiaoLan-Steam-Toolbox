import { describe, expect, it } from 'vitest'
import { localizeMessage } from '../src/shared/localization'

describe('localizeMessage', () => {
  it('returns Chinese-mode messages unchanged, including whitespace and external errors', () => {
    for (const message of ['页面明确提示当前账号被目标屏蔽', '已同步 1005 位好友及资料', '  HTTP 429\n', '']) {
      expect(localizeMessage(message, 'zh-CN')).toBe(message)
    }
  })

  it.each([
    '目标 SteamID 无效，无法检查',
    '未找到唯一的目标评论区；资料可能私密或页面结构已变化',
    '目标评论区当前不可见，无法确定留言权限',
    '页面当前提供留言入口；不保证实际发送成功',
    '未找到启用的留言输入框和提交入口，暂无法确定权限',
    '页面明确提示已关闭或禁用评论',
    '页面明确提示当前仅允许好友评论',
    '页面明确提示当前账号被目标屏蔽',
    '页面明确提示当前账号没有留言权限',
    '资料页面请求失败，暂时无法确定留言权限',
    '资料页面请求失败，检查已暂停，请稍后重试',
    '页面权限提示与留言入口不一致，暂无法确认'
  ])('translates the complete eligibility reason: %s', (message) => {
    const translated = localizeMessage(message, 'en')
    expect(translated).not.toBe(message)
    expect(translated).not.toMatch(/\p{Script=Han}/u)
  })

  it('preserves the eligibility caveat and unknown outcomes', () => {
    expect(localizeMessage('页面当前提供留言入口；不保证实际发送成功', 'en')).toContain('does not guarantee')
    expect(localizeMessage('未找到启用的留言输入框和提交入口，暂无法确定权限', 'en')).toContain('could not be determined')
    expect(localizeMessage('页面明确提示当前仅允许好友评论', 'en')).toContain('only friends')
  })

  it.each([
    ['检查任务不存在', 'The eligibility check task was not found.'],
    ['检查间隔无效', 'The checking interval is invalid.'],
    ['账号不存在', 'The account was not found.'],
    ['分组不存在', 'The group was not found.'],
    ['用户取消', 'Cancelled by the user.'],
    ['正在恢复 Steam 会话', 'Restoring the Steam session'],
    ['已自动登录', 'Signed in automatically'],
    ['当前 Steam 账号尚未登录', 'The current Steam account is not signed in.'],
    ['数据导出正在进行中', 'A data export is already in progress.'],
    ['黑名单状态无效', 'The blacklist state is invalid.']
  ])('translates an exact application message: %s', (message, expected) => {
    expect(localizeMessage(message, 'en')).toBe(expected)
  })

  it('translates scan interruption and restart status without losing the manual-resume requirement', () => {
    expect(localizeMessage('账号切换或会话中断，检查已暂停，请手动继续', 'en')).toContain('resume it manually')
    expect(localizeMessage('应用已重启，请手动继续检查', 'en')).toContain('Resume the check manually')
    expect(localizeMessage('留言权限检查遇到会话、网络或请求错误，已标记为未知并暂停；请稍后手动继续', 'en')).toContain('marked unknown')
  })

  it('translates blacklist protection and export errors', () => {
    expect(localizeMessage('该好友在当前账号黑名单中，已阻止留言', 'en')).toContain('comment was blocked')
    expect(localizeMessage('已跳过：好友已加入当前账号黑名单，未发送留言', 'en')).toContain('No comment was sent')
    expect(localizeMessage('请选择数据目录之外的位置，不能覆盖当前数据库', 'en')).toContain('cannot be overwritten')
  })

  it('keeps dynamic nicknames verbatim even when they contain translatable phrases', () => {
    const name = '用户取消 / Account 76561198000000001 😺 生成的留言超过 42 个字符'
    expect(localizeMessage(`为 ${name} 生成的留言超过 1000 个字符`, 'en'))
      .toBe(`The comment generated for ${name} exceeds 1000 characters.`)
  })

  it('keeps multiline nicknames intact', () => {
    const name = '好友\nXiaoLan9999'
    expect(localizeMessage(`为 ${name} 生成的留言超过 1000 个字符`, 'en'))
      .toBe(`The comment generated for ${name} exceeds 1000 characters.`)
  })

  it.each([
    ['留言最多 1000 个字符', 'Comments can contain at most 1000 characters.'],
    ['单次最多选择 30 位好友，请拆分批次', 'Select at most 30 friends per batch. Split the selection into smaller batches.'],
    ['单次最多处理 5000 位好友', 'At most 5000 friends can be processed at a time.'],
    ['分组名称最多 40 个字符', 'Group names can contain at most 40 characters.'],
    ['已同步 1005 位好友及资料', 'Synced 1005 friends and their profile details.']
  ])('translates numeric templates: %s', (message, expected) => {
    expect(localizeMessage(message, 'en')).toBe(expected)
  })

  it('translates partial sync without altering the original external error', () => {
    const reason = 'Steam 原始错误: HTTP 429 (76561198000000001) / 王小明\nTrace: econnreset'
    const message = `好友列表已更新（1005 位），但 12 位资料暂未刷新，已保留缓存或 SteamID。原因：${reason}`
    expect(localizeMessage(message, 'en')).toBe(
      `Updated the friends list (1005 friends), but 12 profiles could not be refreshed. Cached details or SteamIDs were retained. Reason: ${reason}`
    )
  })

  it('translates known nested application reasons and passes unknown reasons through', () => {
    expect(localizeMessage('好友同步失败：Steam Community 会话已失效', 'en'))
      .toBe('Friend sync failed: The Steam Community session has expired.')
    expect(localizeMessage('表情同步失败：原始 Steam 错误 / invalid parameter', 'en'))
      .toBe('Emoticon sync failed: 原始 Steam 错误 / invalid parameter')
    expect(localizeMessage('好友列表已更新（1005 位），但 12 位资料暂未刷新，已保留缓存或 SteamID。原因：Steam 未返回完整好友资料', 'en'))
      .toContain('Reason: Steam did not return complete friend profile details.')
  })

  it('translates persistent interrupted-delivery errors', () => {
    expect(localizeMessage('队列异常中断，发送结果待核对；不会自动重发', 'en'))
      .toBe('The queue was interrupted unexpectedly. Verify the delivery result; it will not be retried automatically.')
  })

  it('translates batch completion counts and queue shutdown reasons', () => {
    expect(localizeMessage('留言批次已结束：成功 29，失败或待核对 1', 'en'))
      .toBe('Comment batch finished: 29 succeeded, 1 failed or need verification.')
    expect(localizeMessage('留言队列已停止：Steam Community 会话已失效', 'en'))
      .toBe('The comment queue stopped: The Steam Community session has expired.')
    expect(localizeMessage('留言队列已停止：原始错误: SQL_BUSY\n76561198000000001', 'en'))
      .toBe('The comment queue stopped: 原始错误: SQL_BUSY\n76561198000000001')
  })

  it.each([
    '用户取消',
    '中文：好友: XiaoLan9999：Steam😺',
    '名字：留言失败。也是名字',
    '名字：发送结果待核对，不会自动重发。还是名字',
    '第一行\n第二行：第三段',
    ''
  ])('keeps the complete nickname when translating delivery toasts: %s', (nickname) => {
    const error = 'Steam 原始错误: HTTP 403\n76561198000000001'
    expect(localizeMessage(`${nickname}：留言失败。${error}`, 'en'))
      .toBe(`${nickname}: Comment failed. ${error}`)
    expect(localizeMessage(`${nickname}：发送结果待核对，不会自动重发。${error}`, 'en'))
      .toBe(`${nickname}: Verify the delivery result; it will not be retried automatically. ${error}`)
  })

  it('translates a known delivery error without translating the nickname', () => {
    expect(localizeMessage('用户取消：留言失败。Steam Community 会话已失效', 'en'))
      .toBe('用户取消: Comment failed. The Steam Community session has expired.')
    const message = '朋友：发送结果待核对，不会自动重发。fetch failed'
    expect(localizeMessage(message, 'zh-CN')).toBe(message)
  })

  it.each([
    'Unknown Steam error: Access Denied',
    'Steam 原始返回：目前无法处理请求 (76561198000000001)',
    '昵称：用户取消',
    '前缀页面明确提示当前账号被目标屏蔽后缀',
    '  HTTP error 429\n',
    '页面明确提示当前账号被目标屏蔽\n额外服务器文本',
    ''
  ])('leaves non-application text unchanged: %s', (message) => {
    expect(localizeMessage(message, 'en')).toBe(message)
  })
})
