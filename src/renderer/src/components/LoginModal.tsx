import { FormEvent, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { AppEvent, AuthStartResult } from '../../../shared/types'
import { unwrap } from '../ui'
import { useI18n } from '../i18n'

interface LoginModalProps {
  open: boolean
  onClose(): void
  onSuccess(): Promise<void>
}

export function LoginModal({ open, onClose, onSuccess }: LoginModalProps): React.JSX.Element | null {
  const { t } = useI18n()
  const [mode, setMode] = useState<'qr' | 'credentials'>('qr')
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [accountName, setAccountName] = useState('')
  const [password, setPassword] = useState('')
  const [guardCode, setGuardCode] = useState('')
  const [auth, setAuth] = useState<AuthStartResult | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [exportingLogs, setExportingLogs] = useState(false)
  const [logExport, setLogExport] = useState<{ path: string; records: number } | null>(null)
  const [logExportError, setLogExportError] = useState<string | null>(null)
  const loginIdRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const openRef = useRef(false)
  const modeRef = useRef(mode)
  const logExportRef = useRef(false)
  const completingRef = useRef(false)
  const startingGenerationRef = useRef<number | null>(null)
  const earlyEventsRef = useRef<Extract<AppEvent, { loginId: string }>[]>([])
  const guardSubmissionRef = useRef<object | null>(null)

  const resetAttempt = (): void => {
    startingGenerationRef.current = null
    earlyEventsRef.current = []
    completingRef.current = false
    setCompleting(false)
    setCompleted(false)
    guardSubmissionRef.current = null
  }

  const cancelLogin = async (loginId: string | null): Promise<void> => {
    if (loginId) {
      try { await window.steamCommenter.cancelLogin(loginId) } catch { /* A stale attempt must not block closing or switching modes. */ }
    }
  }

  const cancelCurrent = (): Promise<void> => {
    generationRef.current++
    const loginId = loginIdRef.current
    loginIdRef.current = null
    resetAttempt()
    return cancelLogin(loginId)
  }

  const handleAuthEvent = (event: Extract<AppEvent, { loginId: string }>): void => {
    if (event.loginId !== loginIdRef.current) return
    if (event.type === 'authRemoteInteraction' && !completingRef.current) {
      setStatus(t('已扫描，请在 Steam 手机应用中点“确认”', 'Scanned. Confirm in the Steam mobile app'))
    }
    if (event.type === 'authCompleting') {
      completingRef.current = true
      setCompleting(true)
      setPassword('')
      setGuardCode('')
      setQrImage(null)
      setError(null)
      setStatus(t('Steam 授权已完成，正在建立 Community 会话，请勿重复提交验证码', 'Steam authorization is complete. Establishing a Community session; do not submit another code'))
    }
    if (event.type === 'authFailed') {
      generationRef.current++
      loginIdRef.current = null
      resetAttempt()
      setAuth(null)
      setQrImage(null)
      setGuardCode('')
      setBusy(false)
      setError(event.message)
      setStatus(modeRef.current === 'qr'
        ? t('旧二维码已失效，请刷新二维码后重新扫码', 'The previous QR code is no longer valid; refresh before scanning again') : '')
    }
    if (event.type === 'authFinished') {
      generationRef.current++
      loginIdRef.current = null
      resetAttempt()
      completingRef.current = true
      setCompleting(true)
      setCompleted(true)
      setQrImage(null)
      setGuardCode('')
      setError(null)
      setBusy(false)
      setStatus(t('登录成功', 'Signed in'))
      const generation = generationRef.current
      void onSuccess().then(() => { if (openRef.current && generationRef.current === generation) onClose() })
    }
  }

  const acceptAttempt = (result: AuthStartResult): void => {
    loginIdRef.current = result.loginId
    setAuth(result)
    startingGenerationRef.current = null
    const events = earlyEventsRef.current
    earlyEventsRef.current = []
    for (const event of events) handleAuthEvent(event)
  }

  const startQr = async (): Promise<void> => {
    if (!openRef.current || modeRef.current !== 'qr' || completingRef.current) return
    const cancellation = cancelCurrent()
    const generation = generationRef.current
    startingGenerationRef.current = generation
    const current = (): boolean => openRef.current && modeRef.current === 'qr' && generationRef.current === generation
    setBusy(true)
    setError(null)
    setStatus(t('正在向 Steam 请求二维码...', 'Requesting a Steam QR code...'))
    setQrImage(null)
    setAuth(null)
    try {
      await cancellation
      if (!current()) return
      const result = unwrap(await window.steamCommenter.startQrLogin())
      if (!current()) { await cancelLogin(result.loginId); return }
      acceptAttempt(result)
      if (!current() || completingRef.current) return
      const image = await QRCode.toDataURL(result.qrChallengeUrl!, { width: 260, margin: 2 })
      if (!current() || completingRef.current) return
      setQrImage(image)
      setStatus(t('打开 Steam 手机应用，扫描并确认登录', 'Scan and confirm with the Steam mobile app'))
    } catch (caught) {
      if (!current() || completingRef.current) return
      void cancelCurrent()
      setAuth(null)
      setQrImage(null)
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus(t('二维码未生成或已失效，请刷新二维码', 'The QR code is unavailable or expired; refresh to continue'))
      setBusy(false)
    } finally {
      if (current()) setBusy(false)
    }
  }

  useEffect(() => {
    if (!open) return
    openRef.current = true
    modeRef.current = 'qr'
    setMode('qr')
    setAuth(null)
    setError(null)
    setGuardCode('')
    setLogExport(null)
    setLogExportError(null)
    void startQr()
    return () => {
      openRef.current = false
      void cancelCurrent()
    }
    // The modal intentionally creates a fresh login attempt only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    return window.steamCommenter.onEvent((event: AppEvent) => {
      if (!openRef.current || !('loginId' in event)) return
      // Main-process authentication can complete before its start IPC response arrives.
      if (!loginIdRef.current && startingGenerationRef.current === generationRef.current) {
        earlyEventsRef.current = [...earlyEventsRef.current.slice(-31), event]
        return
      }
      handleAuthEvent(event)
    })
  }, [onClose, onSuccess, open, t])

  const switchMode = async (nextMode: 'qr' | 'credentials'): Promise<void> => {
    if (!openRef.current || nextMode === modeRef.current) return
    void cancelCurrent()
    modeRef.current = nextMode
    setMode(nextMode)
    setBusy(false)
    setAuth(null)
    setError(null)
    setStatus('')
    setQrImage(null)
    setGuardCode('')
    if (nextMode === 'qr') await startQr()
  }

  const submitCredentials = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!openRef.current || modeRef.current !== 'credentials' || busy) return
    const generation = ++generationRef.current
    resetAttempt()
    startingGenerationRef.current = generation
    const current = (): boolean => openRef.current && modeRef.current === 'credentials' && generationRef.current === generation
    setBusy(true)
    setError(null)
    setStatus(t('正在登录 Steam...', 'Signing in to Steam...'))
    try {
      const result = unwrap(
        await window.steamCommenter.startCredentialsLogin(accountName.trim(), password)
      )
      if (!current()) { await cancelLogin(result.loginId); return }
      setPassword('')
      acceptAttempt(result)
      if (!current() || completingRef.current) return
      if (!result.actionRequired) {
        setStatus(t('凭据已验证，正在建立 Community 会话...', 'Credentials verified. Establishing a Community session...'))
      } else if (
        result.guardTypes.includes('deviceConfirmation') ||
        result.guardTypes.includes('emailConfirmation')
      ) {
        setStatus(t('请在 Steam 手机应用或邮件中确认本次登录', 'Confirm this sign-in in the Steam mobile app or email'))
      } else {
        setStatus(t('请输入 Steam Guard 验证码', 'Enter your Steam Guard code'))
      }
    } catch (caught) {
      if (!current()) return
      resetAttempt()
      setPassword('')
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus('')
    } finally {
      if (current()) setBusy(false)
    }
  }

  const submitGuard = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!auth || busy || completingRef.current || guardSubmissionRef.current || !openRef.current || modeRef.current !== 'credentials') return
    const generation = generationRef.current
    const current = (): boolean => openRef.current && modeRef.current === 'credentials' && generationRef.current === generation
    const submission = {}
    guardSubmissionRef.current = submission
    setBusy(true)
    setError(null)
    try {
      unwrap(await window.steamCommenter.submitSteamGuard(auth.loginId, guardCode))
      if (!current() || completingRef.current) return
      setGuardCode('')
      setStatus(t('验证码已提交，正在建立 Community 会话...', 'Code submitted. Establishing a Community session...'))
    } catch (caught) {
      if (!current() || completingRef.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (guardSubmissionRef.current === submission) guardSubmissionRef.current = null
      if (current()) setBusy(false)
    }
  }

  const exportLogs = async (): Promise<void> => {
    if (logExportRef.current) return
    logExportRef.current = true
    setExportingLogs(true)
    setLogExportError(null)
    try {
      const result = unwrap(await window.steamCommenter.exportDiagnosticLogs())
      if (openRef.current && result) setLogExport(result)
    } catch (caught) {
      if (openRef.current) setLogExportError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      logExportRef.current = false
      setExportingLogs(false)
    }
  }

  const close = (): void => {
    openRef.current = false
    void cancelCurrent()
    setPassword('')
    setGuardCode('')
    onClose()
  }

  if (!open) return null
  const needsCode =
    !completing && (auth?.guardTypes.includes('emailCode') || auth?.guardTypes.includes('deviceCode'))

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <div className="modal login-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={close} aria-label={t('关闭', 'Close')}>
          ×
        </button>
        <p className="eyebrow">ADD STEAM ACCOUNT</p>
        <h2>{t('连接 Steam 账号', 'Connect a Steam account')}</h2>
        <div className="segmented">
          <button className={mode === 'qr' ? 'active' : ''} onClick={() => void switchMode('qr')}>
            {t('手机扫码', 'Scan QR code')}
          </button>
          <button
            className={mode === 'credentials' ? 'active' : ''}
            onClick={() => void switchMode('credentials')}
          >
            {t('账号密码', 'Account & password')}
          </button>
        </div>

        {mode === 'qr' ? (
          <div className="qr-login">
            <div className="qr-frame">
              {qrImage ? <img src={qrImage} alt={t('Steam 登录二维码', 'Steam sign-in QR code')} /> : <div className="qr-placeholder" />}
            </div>
            <p>{status || t('二维码尚未生成，请刷新二维码', 'No QR code is active; refresh to continue')}</p>
            <button className="ghost" disabled={busy || completing} onClick={() => void startQr()}>
              {t('刷新二维码', 'Refresh QR code')}
            </button>
          </div>
        ) : (
          <div className="credential-login">
            {!auth && !completing ? (
              <form onSubmit={(event) => void submitCredentials(event)}>
                <label>
                  {t('Steam 登录名', 'Steam account name')}
                  <input
                    autoComplete="username"
                    value={accountName}
                    onChange={(event) => setAccountName(event.target.value)}
                    placeholder={t('不是个人资料昵称', 'Not your profile display name')}
                  />
                </label>
                <label>
                  {t('密码', 'Password')}
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <button className="primary wide" type="submit" disabled={busy}>
                  {busy ? t('正在验证...', 'Verifying...') : t('继续', 'Continue')}
                </button>
                <small>{t('密码只用于本次 Steam 登录请求，不会写入磁盘', 'Your password is used only for this sign-in and is never saved to disk')}</small>
              </form>
            ) : needsCode ? (
              <form onSubmit={(event) => void submitGuard(event)}>
                <label>
                  {t('Steam Guard 验证码', 'Steam Guard code')}
                  <input
                    autoFocus
                    value={guardCode}
                    onChange={(event) => setGuardCode(event.target.value)}
                    placeholder={auth?.guardDetail ? t(`已发送至 ${auth.guardDetail}`, `Sent to ${auth.guardDetail}`) : t('输入验证码', 'Enter code')}
                  />
                </label>
                <button className="primary wide" type="submit" disabled={busy}>
                  {t('提交验证码', 'Submit code')}
                </button>
              </form>
            ) : (
              <div className="confirmation-wait">
                <div className="phone-pulse">✓</div>
                <strong>{completed ? t('登录成功', 'Signed in') : completing ? t('正在建立 Community 会话', 'Establishing a Community session') : t('等待 Steam 确认', 'Waiting for Steam confirmation')}</strong>
                <p>{status}</p>
              </div>
            )}
          </div>
        )}
        {error && <div className="login-error-details">
          <div className="inline-error" role="alert">{error}</div>
          <button className="ghost" disabled={exportingLogs} onClick={() => void exportLogs()}>
            {exportingLogs ? t('正在导出诊断日志…', 'Exporting diagnostic logs…') : t('导出诊断日志', 'Export diagnostic logs')}
          </button>
          <small>{t('仅导出本地脱敏 JSON，不会自动上传；可手动提交给排查人员', 'Exports local sanitized JSON only, with no automatic upload; you can submit it manually for troubleshooting')}</small>
        </div>}
        {logExport && <p className="diagnostic-export-result" role="status">{t(`已导出 ${logExport.records} 条诊断记录至：`, `Exported ${logExport.records} diagnostic records to: `)}<code>{logExport.path}</code></p>}
        {logExportError && <p className="diagnostic-export-error" role="alert">{t('诊断日志导出失败：', 'Diagnostic log export failed: ')}{logExportError}</p>}
      </div>
    </div>
  )
}
