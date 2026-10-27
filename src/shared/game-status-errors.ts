type Translate = (zh: string, en: string) => string

export const GAME_STATUS_ERROR_MESSAGES = {
  GAME_STATUS_PERSONAL_CM_DISABLED: ['独立 CM 模拟已经停用，请使用本机 AppID 模拟；不会再创建个人聊天登录。', 'Independent CM simulation is disabled. Use local AppID simulation; no personal chat sign-in will be created.'],
  GAME_STATUS_LOCAL_CONNECTION_PAUSED: ['真实游戏状态连接已暂停：实测发现仅建立连接也可能使原生子状态消失。修复并验证前不会创建辅助连接或尝试锁定；请保留游戏原生状态。', 'Live game-status connections are paused: testing showed that connecting alone can hide the native substatus. No helper connection or lock will be started until a fix is verified. Keep the game\'s native presence active.'],
  GAME_STATUS_LOCAL_CONNECTION_REQUIRED: ['真实游戏状态需要连接本机 Steam；当前是独立模拟会话。请使用“连接本机 Steam”，不会自动新建账号连接。', 'Live game status requires the local Steam connection. This is an independent simulation session. Select Connect local Steam; no extra account connection is created automatically.'],
  GAME_STATUS_LOCAL_TEMPLATE_UNAVAILABLE: ['本机接口未提供可安全恢复的原始显示令牌。请直接编辑已读取的 desc 等公开参数；不会猜测令牌或自动重新登录。', 'The local interface did not provide a raw display token that can be safely restored. Edit observed public parameters such as desc instead. No token is guessed and no extra sign-in is attempted.'],
  GAME_STATUS_NATIVE_LOCK_UNREADABLE: ['所选模板包含本机接口不能安全回读的字段，不能持续锁定；尚未提交修改。请使用已读取的公开字段，或改为单次尝试并核对效果。', 'The selected template includes fields that the local interface cannot safely read back, so continuous locking is unavailable. No edit was submitted. Use observed public fields, or attempt a single submission and verify its effect.'],
  GAME_STATUS_NOT_CONNECTED: ['游戏状态会话尚未连接。编辑真实游戏请先点击“连接本机 Steam（不重新登录）”；自定义模拟请在对应页面连接独立会话。这不代表工具箱登录已失效。', 'The game status session is not connected. To edit a real game, select “Connect local Steam (no new sign-in)”. For simulation, connect its separate session on the simulation page. This does not mean toolbox sign-in has expired.'],
  GAME_STATUS_NO_LIVE_GAME: ['尚未识别到当前账号的真实游戏会话。请确认游戏已通过 Steam 启动，稍后重新读取；未修改游戏状态。', 'No live game session has been identified for this account. Confirm the game was started through Steam, then read again shortly. No game status was changed.'],
  GAME_STATUS_RP_READ_FAILED: ['未能读取 Steam 游戏详细状态。请检查连接后重新读取；不能据此判断登录已失效。', 'Steam game rich presence could not be read. Check the connection and read again. This alone does not establish that sign-in expired.'],
  GAME_STATUS_RP_EMPTY: ['Steam 暂未返回当前游戏的详细状态。游戏可能尚未发布状态，请稍后重新读取；不能仅据此确定子状态内容。', 'Steam has not returned rich presence for the current game. The game may not have published it yet. Read again shortly; the substatus cannot be determined from this response.'],
  GAME_STATUS_RP_PROTOCOL_MISMATCH: ['Steam 已返回游戏状态，但当前解析器未能识别新版响应。请更新工具箱；不需要因此重新登录或重启游戏。', 'Steam returned game presence, but the current decoder did not recognize the newer response format. Update the toolbox; this alone does not require signing in again or restarting the game.'],
  GAME_STATUS_RP_INVALID: ['Steam 返回的游戏详细状态格式不符合要求。为避免误改，未继续处理；请重新读取。', 'Steam returned game rich presence in an unsupported format. Processing stopped to avoid an incorrect edit. Read again.'],
  GAME_STATUS_CONTEXT_CHANGED: ['账号、游戏或会话已变化，旧操作已停止，未继续覆盖。请刷新并重新读取。', 'The account, game or session changed. The old operation stopped without further overwrites. Refresh and read again.'],
  GAME_STATUS_BUSY: ['上一个游戏状态操作尚未结束，请等待完成后重试。', 'The previous game status operation is still running. Wait for it to finish before retrying.'],
  GAME_STATUS_PLAYING_STATE_UNCONFIRMED: ['Steam 尚未确认这个模拟会话是否可运行游戏，请等待状态确认后再应用；未发送模拟状态。', 'Steam has not confirmed whether this simulation session may play games. Wait for confirmation before applying; no simulation was submitted.'],
  GAME_STATUS_SIMULATION_CONTEXT_UNAVAILABLE: ['暂时无法核实本机账号与空闲游戏状态，未发送模拟状态。请检查本机 Steam 后重试。', 'The local account and idle-game context could not be verified. No simulation was submitted. Check local Steam and retry.'],
  GAME_STATUS_SIMULATION_GAME_ACTIVE: ['当前账号正在运行游戏，未发送模拟状态。请先正常退出游戏，或使用真实游戏状态编辑。', 'This account is currently playing a game. No simulation was submitted. Exit the game normally, or use live-game status editing.'],
  GAME_STATUS_CM_RETIRE_FAILED: ['旧的状态连接尚未确认退出，已阻止创建新连接。请稍后重试；不会同时建立两个状态会话。', 'The previous status connection has not confirmed shutdown. A new connection was blocked. Retry shortly; two status sessions will not be started together.'],
  GAME_STATUS_SIMULATION_SWITCH_REQUIRES_RESTORE: ['当前仍有真实游戏锁定或恢复记录，请先解除锁定并恢复，再连接模拟。也可明确断开当前连接以放弃该记录。', 'A live-game lock or restore record is still active. Unlock and restore before connecting simulation, or explicitly disconnect to discard the record.'],
  GAME_STATUS_APP_LOOKUP_TIMEOUT: ['读取游戏名称、图标或官方子状态模板超时。请重新读取，不必仅因此重新登录。', 'Reading the game name, icon or published substatus templates timed out. Read again; this alone does not require signing in again.'],
  GAME_STATUS_UPLOAD_FAILED: ['游戏状态提交未完成。请先重新读取并核对是否生效，再决定是否重试。', 'The game status submission did not complete. Read the current status and verify whether it took effect before deciding to retry.'],
  GAME_STATUS_RESTORE_EXPIRED: ['安全恢复记录已过期（超过 10 分钟），未覆盖当前游戏状态。请重新读取建立基线，再编辑或锁定。', 'The safe-restore record is over 10 minutes old. The current game status was not overwritten. Read again to establish a new baseline before editing or locking.'],
  GAME_STATUS_NATIVE_UNAVAILABLE: ['未找到当前游戏正在使用的 Steamworks 接口，无法安全修改真实游戏状态。请确认本机 Steam 和游戏正在运行；没有改用无效的独立连接重复提交。', 'The running game\'s Steamworks interface was not found. The live game cannot be safely edited. Confirm the local Steam client and game are running; no ineffective independent-session fallback was used.'],
  GAME_STATUS_NATIVE_IDENTITY: ['本机 Steam 账号与工具箱当前账号不一致，已停止写入。请在工具箱选择与本机 Steam 相同的账号。', 'The local Steam identity differs from the selected toolbox account. Writing stopped. Select the same account as the local Steam client.'],
  GAME_STATUS_NATIVE_CONTEXT: ['本机游戏状态连接已结束或上下文已变化，已停止旧写入和锁定。请重新读取当前游戏核对。', 'The local presence connection ended or its context changed. Old writes and locking stopped. Read the current game again to verify.'],
  GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE: ['暂时无法核实本机 Steam 和游戏，已停止自动维持并保留恢复记录。请手动重新读取核对；这不代表账号或游戏已经变化。', 'The local Steam and game context could not be verified. Automatic maintenance stopped and the restore record was retained. Read again manually to verify; this does not establish that the account or game changed.'],
  GAME_STATUS_NATIVE_WRITE_FAILED: ['本机 Steam 未完成状态修改。可能已写入部分字段，请先重新读取核对；不会将本地接受视为显示成功。', 'Local Steam did not complete the edit. Some fields may have changed. Read back before retrying; local acceptance is not display confirmation.'],
  GAME_STATUS_NATIVE_PROTOCOL: ['本机游戏状态辅助进程响应异常，已停止提交。请重新读取核对后重试。', 'The local presence helper returned an invalid response. Submission stopped. Read back before retrying.'],
  GAME_STATUS_NATIVE_TIMEOUT: ['等待本机 Steam 状态接口超时，已停止辅助进程。结果尚未确认，请先重新读取。', 'The local Steam presence interface timed out and its helper stopped. The result is unconfirmed. Read the current status first.'],
  GAME_STATUS_CM_CONNECT_FAILED: ['Steam 游戏状态连接失败或已断开。请检查网络后重新连接；尚不能确定是登录失效。', 'The Steam game status connection failed or disconnected. Check the network and reconnect. Expired sign-in has not been established.'],
  GAME_STATUS_WEB_SESSION_FAILED: ['未能准备工具箱现有的 Steam 网页会话。请先在当前账号页面检查登录和网络，再重试连接。', 'The existing toolbox Steam web session could not be prepared. Check sign-in and the network on the current account page, then reconnect.'],
  GAME_STATUS_IDENTITY_MISMATCH: ['登录身份与当前工具箱账号不匹配，已停止状态操作。请重新选中账号并连接。', 'The signed-in identity does not match the current toolbox account. Status operations stopped. Select the account again and reconnect.'],
  GAME_STATUS_GUARD_REQUIRED: ['Steam 要求安全验证。请回到工具箱当前账号页面完成验证，再重试连接。', 'Steam requires security verification. Complete verification on the current toolbox account page, then reconnect.']
} as const

export type GameStatusFailureCode = keyof typeof GAME_STATUS_ERROR_MESSAGES
export type GameStatusFailureStage = 'session' | 'toolbox_login' | 'web_session' | 'cm_connect' | 'identity' | 'playing_state' | 'app_info' | 'read_presence' | 'upload' | 'readback' | 'context' | 'operation'
export interface GameStatusFailure {
  code: GameStatusFailureCode
  stage: GameStatusFailureStage
  at: string
  appId?: number
  submitted: 'no' | 'yes' | 'unknown'
}

const stageMessages: Record<GameStatusFailureStage, readonly [string, string]> = {
  session: ['检查游戏状态连接', 'Checking the game status session'],
  toolbox_login: ['获取工具箱登录授权', 'Acquiring toolbox sign-in authorization'],
  web_session: ['准备 Steam 网页会话', 'Preparing the Steam web session'],
  cm_connect: ['连接 Steam 游戏状态服务', 'Connecting to Steam game status'],
  identity: ['核对账号身份', 'Verifying account identity'],
  playing_state: ['识别正在运行的游戏', 'Identifying the running game'],
  app_info: ['读取游戏信息与模板', 'Reading game information and templates'],
  read_presence: ['读取游戏详细状态', 'Reading game rich presence'],
  upload: ['提交游戏状态', 'Submitting game status'],
  readback: ['回读核对游戏状态', 'Verifying game status by readback'],
  context: ['核对账号、游戏及会话', 'Checking the account, game and session'],
  operation: ['处理游戏状态操作', 'Processing a game status operation']
}

export function isGameStatusFailureCode(value: unknown): value is GameStatusFailureCode {
  return typeof value === 'string' && Object.hasOwn(GAME_STATUS_ERROR_MESSAGES, value)
}

export function gameStatusFailureMessage(value: unknown, t: Translate): string {
  // Only known codes select text. SDK messages can contain sign-in or joining data.
  const code = value === 'GAME_STATUS_SESSION_CHANGED' ? 'GAME_STATUS_CONTEXT_CHANGED' : value
  if (!isGameStatusFailureCode(code)) return t('本次游戏状态操作未完成，具体原因尚未确认。请刷新状态后重试；不会仅据此判断登录失效。', 'The game status operation did not complete and its cause is not confirmed. Refresh the status and retry; this alone does not establish that sign-in expired.')
  const message = GAME_STATUS_ERROR_MESSAGES[code]
  return t(message[0], message[1])
}

export function gameStatusFailureStageMessage(value: unknown, t: Translate): string {
  return typeof value === 'string' && Object.hasOwn(stageMessages, value)
    ? t(...stageMessages[value as GameStatusFailureStage])
    : t('阶段尚未确定', 'Stage not established')
}
