const messages = new Map<string, string>([
  ['更新设置无效，请使用不含账号密码或参数的 HTTPS 代理前缀（最多 5 条）', 'Invalid update settings. Use up to 5 HTTPS proxy prefixes without credentials or query parameters.'],
  ['无法打开未知工具来源', 'Cannot open an unknown tool source.'],
  ['好友同步数据无效，已保留原列表', 'The friend snapshot is invalid. The previous list has been preserved.'],
  ['同步账号不存在', 'The account being synced was not found.'],
  ['已跳过：该用户已不在当前好友列表中，未发送留言', 'Skipped: this user is no longer in the current friends list. No comment was sent.'],
  ['留言内容不能为空', 'Enter a comment before continuing.'],
  ['发送间隔无效', 'The sending interval is invalid.'],
  ['请至少选择一位好友', 'Select at least one friend.'],
  ['检查任务不存在', 'The eligibility check task was not found.'],
  ['账号切换或会话中断，检查已暂停，请手动继续', 'The account changed or the session was interrupted. The check is paused; resume it manually.'],
  ['检查过程中账号切换或会话中断，无法确认留言权限', 'The account changed or the session was interrupted during the check. Comment eligibility could not be confirmed.'],
  ['应用正在退出', 'The application is shutting down.'],
  ['请先切换到要检查的账号', 'Switch to the account you want to check first.'],
  ['检查前必须登录对应 Steam 账号', 'Sign in to the corresponding Steam account before checking.'],
  ['该用户已不在当前同步的好友列表中', 'This user is no longer in the current synced friends list.'],
  ['留言权限检查遇到会话、网络或请求错误，已标记为未知并暂停；请稍后手动继续', 'The eligibility check encountered a session, network, or request error. The result is marked unknown and the task is paused; resume it manually later.'],
  ['目标 SteamID 无效，无法检查', 'The target SteamID is invalid and cannot be checked.'],
  ['未找到唯一的目标评论区；资料可能私密或页面结构已变化', 'A unique comment section for the target was not found. The profile may be private or the page structure may have changed.'],
  ['目标评论区当前不可见，无法确定留言权限', 'The target comment section is currently hidden. Comment eligibility could not be determined.'],
  ['页面当前提供留言入口；不保证实际发送成功', 'The page currently offers a comment form. This does not guarantee that a comment will be sent successfully.'],
  ['未找到启用的留言输入框和提交入口，暂无法确定权限', 'An enabled comment field and submit control were not found. Eligibility could not be determined.'],
  ['页面明确提示已关闭或禁用评论', 'The page explicitly states that comments are closed or disabled.'],
  ['页面明确提示当前仅允许好友评论', 'The page explicitly states that only friends can currently comment.'],
  ['页面明确提示当前账号被目标屏蔽', 'The page explicitly states that the target has blocked the current account.'],
  ['页面明确提示当前账号没有留言权限', 'The page explicitly states that the current account is not permitted to comment.'],
  ['不支持的界面语言', 'This interface language is not supported.'],
  ['账号不存在', 'The account was not found.'],
  ['已保存的登录令牌无法由当前 Windows 用户解密，请重新登录', 'The saved login token cannot be decrypted by the current Windows user. Sign in again.'],
  ['黑名单状态无效', 'The blacklist state is invalid.'],
  ['检查间隔无效', 'The checking interval is invalid.'],
  ['当前账号已有未完成检查，请先继续或取消', 'This account already has an unfinished check. Resume or cancel it first.'],
  ['这个检查任务不能继续', 'This check task cannot be resumed.'],
  ['检查结果无效', 'The check result is invalid.'],
  ['这个账号下已经有同名分组', 'A group with this name already exists for this account.'],
  ['分组不存在', 'The group was not found.'],
  ['只能给当前账号已同步的好友分组', 'Only synced friends of the current account can be assigned to groups.'],
  ['分组不属于当前账号', 'The group does not belong to the current account.'],
  ['这个批次不能继续执行', 'This batch cannot be resumed.'],
  ['这个批次不能暂停', 'This batch cannot be paused.'],
  ['用户取消', 'Cancelled by the user.'],
  ['发送任务不存在', 'The delivery task was not found.'],
  ['系统安全存储当前不可用，无法保存自动登录令牌', 'System secure storage is unavailable. An automatic sign-in token cannot be saved.'],
  ['好友 Steam ID 无效', 'The friend Steam ID is invalid.'],
  ['只能处理当前账号已同步的好友', 'Only synced friends of the current account can be processed.'],
  ['应用已重启，请手动继续检查', 'The application restarted. Resume the check manually.'],
  ['批次不存在', 'The batch was not found.'],
  ['应用在请求过程中退出；为避免重复留言，未自动重发', 'The application exited during the request. It was not retried automatically to avoid duplicate comments.'],
  ['分组名称不能为空', 'Enter a group name.'],
  ['数据正在导出，请完成后再退出。', 'Please wait for the data export to finish before closing.'],
  ['请先取消这个账号的未完成批次', 'Cancel this account\'s unfinished batch first.'],
  ['无法打开数据目录，请根据界面路径手动打开', 'The data folder could not be opened. Open it manually using the path shown in the interface.'],
  ['数据导出正在进行中', 'A data export is already in progress.'],
  ['导出数据（不含登录令牌）', 'Export data (no login tokens)'],
  ['请选择数据目录之外的位置，不能覆盖当前数据库', 'Choose a location outside the data folder. The current database cannot be overwritten.'],
  ['拒绝未知页面的请求', 'The request from an unknown page was rejected.'],
  ['发生未知错误', 'An unexpected error occurred.'],
  ['Steam 未返回完整的 Community 会话 Cookie', 'Steam did not return the complete Community session cookies.'],
  ['Steam Community 会话已失效', 'The Steam Community session has expired.'],
  ['Steam 好友资料接口返回了无法识别的数据', 'The Steam friend profile endpoint returned unrecognized data.'],
  ['目标 SteamID 无效', 'The target SteamID is invalid.'],
  ['资料页面请求失败，暂时无法确定留言权限', 'The profile page request failed. Comment eligibility could not be determined.'],
  ['资料页面请求失败，检查已暂停，请稍后重试', 'The profile page request failed. The check is paused; try again later.'],
  ['页面权限提示与留言入口不一致，暂无法确认', 'The page permission notice conflicts with the comment form. Eligibility could not be confirmed.'],
  ['Steam 好友页面重定向到了不受信任的地址', 'The Steam friends page redirected to an untrusted address.'],
  ['Steam 请求触发频率限制（HTTP 429），请稍后再试', 'Steam rate-limited the request (HTTP 429). Try again later.'],
  ['发送前必须登录对应 Steam 账号', 'Sign in to the corresponding Steam account before sending.'],
  ['当前账号已有未完成批次，请先完成或取消', 'This account already has an unfinished batch. Complete or cancel it first.'],
  ['收件人必须是当前账号已同步的好友', 'Recipients must be synced friends of the current account.'],
  ['收件人中包含当前账号黑名单好友，请先移除', 'The recipients include blacklisted friends of this account. Remove them from the selection first.'],
  ['恢复批次前必须登录对应 Steam 账号', 'Sign in to the corresponding Steam account before resuming the batch.'],
  ['Steam 会话失效，留言批次已暂停', 'The Steam session expired. The comment batch is paused.'],
  ['已跳过：好友已加入当前账号黑名单，未发送留言', 'Skipped: the friend was added to this account\'s blacklist. No comment was sent.'],
  ['检测到会话、网络或频率问题，批次已暂停', 'A session, network, or rate-limit issue was detected. The batch is paused.'],
  ['队列异常中断，发送结果待核对；不会自动重发', 'The queue was interrupted unexpectedly. Verify the delivery result; it will not be retried automatically.'],
  ['正在恢复 Steam 会话', 'Restoring the Steam session'],
  ['没有可用的自动登录令牌，请重新登录', 'No automatic sign-in token is available. Sign in again.'],
  ['已自动登录', 'Signed in automatically'],
  ['自动登录失败，请重新登录', 'Automatic sign-in failed. Sign in again.'],
  ['Steam 未返回二维码登录地址', 'Steam did not return a QR sign-in URL.'],
  ['请输入 Steam 登录名和密码', 'Enter your Steam account name and password.'],
  ['登录请求已失效，请重新开始', 'The sign-in request has expired. Start again.'],
  ['请输入 Steam Guard 验证码', 'Enter your Steam Guard code.'],
  ['Steam 未返回完整好友资料', 'Steam did not return complete friend profile details.'],
  ['账号或登录会话已变更，本次好友同步已取消', 'The account or sign-in session changed. This friend sync was cancelled.'],
  ['该好友在当前账号黑名单中，已阻止留言', 'This friend is on the current account\'s blacklist. The comment was blocked.'],
  ['该用户不在当前账号已同步的好友列表中', 'This user is not in the current account\'s synced friends list.'],
  ['账号、会话或好友关系已变更，本次检查结果已取消', 'The account, session, or friend relationship changed. This check result was discarded.'],
  ['Steam 登录确认超时，请重新生成二维码', 'Steam sign-in confirmation timed out. Generate a new QR code.'],
  ['Windows 安全存储不可用，本次会话不会自动登录', 'Windows secure storage is unavailable. This session will not be restored automatically.'],
  ['Steam 会话已过期，请重新登录', 'The Steam session has expired. Sign in again.'],
  ['请先切换到这个 Steam 账号', 'Switch to this Steam account first.'],
  ['当前 Steam 账号尚未登录', 'The current Steam account is not signed in.']
])

export function localizeMessage(message: string, language: 'zh-CN' | 'en'): string {
  if (language === 'zh-CN') return message
  const translated = messages.get(message)
  if (translated !== undefined) return translated

  let match = /^留言最多 (\d+) 个字符$/.exec(message)
  if (match) return `Comments can contain at most ${match[1]} characters.`
  match = /^为 ([\s\S]*) 生成的留言超过 (\d+) 个字符$/.exec(message)
  if (match) return `The comment generated for ${match[1]} exceeds ${match[2]} characters.`
  match = /^单次最多选择 (\d+) 位好友，请拆分批次$/.exec(message)
  if (match) return `Select at most ${match[1]} friends per batch. Split the selection into smaller batches.`
  match = /^单次最多处理 (\d+) 位好友$/.exec(message)
  if (match) return `At most ${match[1]} friends can be processed at a time.`
  match = /^分组名称最多 (\d+) 个字符$/.exec(message)
  if (match) return `Group names can contain at most ${match[1]} characters.`
  match = /^已同步 (\d+) 位好友及资料$/.exec(message)
  if (match) return `Synced ${match[1]} friends and their profile details.`
  match = /^好友列表已更新（(\d+) 位），但 (\d+) 位资料暂未刷新，已保留缓存或 SteamID。原因：([\s\S]*)$/.exec(message)
  if (match) {
    return `Updated the friends list (${match[1]} friends), but ${match[2]} profiles could not be refreshed. Cached details or SteamIDs were retained. Reason: ${localizeMessage(match[3]!, language)}`
  }
  match = /^好友同步失败：([\s\S]*)$/.exec(message)
  if (match) return `Friend sync failed: ${localizeMessage(match[1]!, language)}`
  match = /^表情同步失败：([\s\S]*)$/.exec(message)
  if (match) return `Emoticon sync failed: ${localizeMessage(match[1]!, language)}`
  match = /^留言批次已结束：成功 (\d+)，失败或待核对 (\d+)$/.exec(message)
  if (match) return `Comment batch finished: ${match[1]} succeeded, ${match[2]} failed or need verification.`
  match = /^留言队列已停止：([\s\S]*)$/.exec(message)
  if (match) return `The comment queue stopped: ${localizeMessage(match[1]!, language)}`
  match = /^([\s\S]*)：(发送结果待核对，不会自动重发|留言失败)。([\s\S]*)$/.exec(message)
  if (match) {
    const result = match[2] === '留言失败'
      ? 'Comment failed.' : 'Verify the delivery result; it will not be retried automatically.'
    return `${match[1]}: ${result} ${localizeMessage(match[3]!, language)}`
  }

  return message
}
