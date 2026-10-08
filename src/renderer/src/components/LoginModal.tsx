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
  const loginIdRef = useRef<string | null>(null)

  const cancelCurrent = async (): Promise<void> => {
    const loginId = loginIdRef.current
    loginIdRef.current = null
    if (loginId) await window.steamCommenter.cancelLogin(loginId)
  }

  const startQr = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setStatus(t('正在向 Steam 请求二维码...', 'Requesting a Steam QR code...'))
    setQrImage(null)
    await cancelCurrent()
    try {
      const result = unwrap(await window.steamCommenter.startQrLogin())
      loginIdRef.current = result.loginId
      setAuth(result)
      setQrImage(await QRCode.toDataURL(result.qrChallengeUrl!, { width: 260, margin: 2 }))
      setStatus(t('打开 Steam 手机应用，扫描并确认登录', 'Scan and confirm with the Steam mobile app'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setMode('qr')
    setAuth(null)
    setError(null)
    setGuardCode('')
    void startQr()
    return () => {
      void cancelCurrent()
    }
    // The modal intentionally creates a fresh login attempt only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    return window.steamCommenter.onEvent((event: AppEvent) => {
      if ('loginId' in event && event.loginId !== loginIdRef.current) return
      if (event.type === 'authRemoteInteraction') {
        setStatus(t('已扫描，请在 Steam 手机应用中点“确认”', 'Scanned. Confirm in the Steam mobile app.'))
      }
      if (event.type === 'authFailed') {
        loginIdRef.current = null
        setBusy(false)
        setError(event.message)
        setStatus('')
      }
      if (event.type === 'authFinished') {
        loginIdRef.current = null
        setStatus(t('登录成功', 'Signed in'))
        void onSuccess().then(onClose)
      }
    })
  }, [onClose, onSuccess, open, t])

  const switchMode = async (nextMode: 'qr' | 'credentials'): Promise<void> => {
    if (nextMode === mode) return
    await cancelCurrent()
    setMode(nextMode)
    setAuth(null)
    setError(null)
    setStatus('')
    setQrImage(null)
    setGuardCode('')
    if (nextMode === 'qr') await startQr()
  }

  const submitCredentials = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setStatus(t('正在登录 Steam...', 'Signing in to Steam...'))
    try {
      const result = unwrap(
        await window.steamCommenter.startCredentialsLogin(accountName.trim(), password)
      )
      setPassword('')
      loginIdRef.current = result.loginId
      setAuth(result)
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
      setPassword('')
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const submitGuard = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!auth) return
    setBusy(true)
    setError(null)
    try {
      unwrap(await window.steamCommenter.submitSteamGuard(auth.loginId, guardCode))
      setGuardCode('')
      setStatus(t('验证码已提交，正在建立 Community 会话...', 'Code submitted. Establishing a Community session...'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    void cancelCurrent()
    setPassword('')
    setGuardCode('')
    onClose()
  }

  if (!open) return null
  const needsCode =
    auth?.guardTypes.includes('emailCode') || auth?.guardTypes.includes('deviceCode')

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
            <p>{status || t('二维码加载中...', 'Loading QR code...')}</p>
            <button className="ghost" disabled={busy} onClick={() => void startQr()}>
              {t('刷新二维码', 'Refresh QR code')}
            </button>
          </div>
        ) : (
          <div className="credential-login">
            {!auth ? (
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
                <small>{t('密码只用于本次 Steam 登录请求，不会写入磁盘。', 'Your password is used only for this sign-in and is never saved to disk.')}</small>
              </form>
            ) : needsCode ? (
              <form onSubmit={(event) => void submitGuard(event)}>
                <label>
                  {t('Steam Guard 验证码', 'Steam Guard code')}
                  <input
                    autoFocus
                    value={guardCode}
                    onChange={(event) => setGuardCode(event.target.value)}
                    placeholder={auth.guardDetail ? t(`已发送至 ${auth.guardDetail}`, `Sent to ${auth.guardDetail}`) : t('输入验证码', 'Enter code')}
                  />
                </label>
                <button className="primary wide" type="submit" disabled={busy}>
                  {t('提交验证码', 'Submit code')}
                </button>
              </form>
            ) : (
              <div className="confirmation-wait">
                <div className="phone-pulse">✓</div>
                <strong>{t('等待 Steam 确认', 'Waiting for Steam confirmation')}</strong>
                <p>{status}</p>
              </div>
            )}
          </div>
        )}
        {error && <div className="inline-error">{error}</div>}
      </div>
    </div>
  )
}
