import { useI18n } from '../i18n'
import type { SteamAuthenticatorEnrollmentApi } from '../../../shared/steam-authenticator-enrollment'
import { SteamAuthenticatorEnrollmentWizard } from './SteamAuthenticatorEnrollmentWizard'

export function SteamAuthenticatorSetupPanel({ api, visible = true }: { api?: SteamAuthenticatorEnrollmentApi; visible?: boolean } = {}): React.JSX.Element {
  return api ? <SteamAuthenticatorEnrollmentWizard api={api} visible={visible} /> : <SteamAuthenticatorSetupGuide />
}

export function SteamAuthenticatorSetupGuide(): React.JSX.Element {
  const { t } = useI18n()
  const steps = [
    { title: t('单独进行 MobileApp 认证并核对 SteamID', 'Authenticate separately as MobileApp and verify the SteamID'),
      description: t('绑定令牌需要可验证的独立手机端认证，不能把工具箱现有的 WebBrowser 登录令牌当作 MobileApp 令牌；必须先核对目标账号', 'Enrollment requires verified, separate mobile authentication. The current toolbox WebBrowser token cannot be treated as a MobileApp token, and the target account must be verified first') },
    { title: t('检查账号是否已经绑定验证器', 'Check whether an authenticator is already enrolled'),
      description: t('已有验证器时应导入原 maFile，或使用 Steam 官方迁移流程；不能为了新建而自动移除、重置原验证器', 'If an authenticator already exists, import its original maFile or use the official Steam transfer flow. Existing authenticators must not be removed or reset automatically to create another one') },
    { title: t('按 Steam 要求核对手机号、邮箱及短信', 'Verify phone, email and SMS requirements'),
      description: t('读取服务端状态，按提示完成手机号、邮箱或短信验证。验证码必须由你明确填写，工具箱不能猜测或跳过这些步骤', 'Read the server requirements and complete the requested phone, email or SMS verification. You must enter verification codes explicitly; these checks cannot be guessed or skipped') },
    { title: t('你确认后，只请求添加一次', 'Request enrollment once after your explicit confirmation'),
      description: t('Add 会改变 Steam 账号的安全状态，执行前必须明确确认目标。超时或返回状态不明时先核对，不反复请求添加，也不显示假成功', 'Add changes the security state of the Steam account and requires explicit confirmation of the target. Timeouts or unclear responses require verification rather than repeated enrollment requests or a false success message') },
    { title: t('立即加密保存待完成材料，再保存恢复码和备份', 'Encrypt pending material immediately, then save recovery codes and a backup'),
      description: t('收到临时令牌材料后，必须先在本机加密持久保存，不能只放在页面内存。你还需单独保存恢复码及敏感备份并明确确认；未完成保管前不能继续短信激活', 'Pending authenticator material must be encrypted and persisted locally immediately, not left only in page memory. Save recovery codes and a sensitive backup separately and confirm that you have them before SMS activation continues') },
    { title: t('填写短信，按已核实协议完成 Finalize', 'Enter the SMS code and finalize using a verified protocol'),
      description: t('只按服务端明确支持的步骤完成激活，遇到未知 confirm_type、手机号验证分支或响应含义时停止，不猜测完成状态', 'Complete activation only through server steps whose meaning is verified. Stop on an unknown confirm_type, phone-verification branch or response instead of guessing that enrollment completed') },
    { title: t('再次读取服务端状态核对完成', 'Read the server state again to confirm completion'),
      description: t('只有服务端明确确认已绑定且目标账号一致，才能标记完成。单纯生成五位验证码、保存文件或看到本机缓存，都不等于绑定成功', 'Mark enrollment complete only when the server explicitly confirms it for the same account. A five-character code, a saved file or a local cache is not proof of successful enrollment') }
  ]
  return <section className="game-status-card steam-authenticator-workflow" aria-label={t('新建手机令牌流程说明', 'Mobile authenticator enrollment guide')}>
    <div className="game-status-section-title"><div><h3>{t('从工具箱新建手机令牌：详细流程', 'Create a mobile authenticator from the toolbox: detailed flow')}</h3>
      <p>{t('这是流程说明，不是可执行的绑定向导', 'This is a process guide, not an executable enrollment wizard')}</p></div></div>
    <div className="game-status-notice info" role="status"><strong>{t('当前工具箱尚未开放直接绑定', 'Direct enrollment is not enabled in this toolbox version')}</strong>
      <p>{t('本页不会登录手机端，也不会调用 Add、Finalize 或 Remove；真正绑定需在后续经过协议实测和你明确授权后开放', 'This page does not sign in as mobile or call Add, Finalize or Remove. Direct enrollment requires later protocol verification and your explicit authorization')}</p></div>
    <ol className="steam-authenticator-steps">{steps.map((step, index) => <li key={index}><strong>{step.title}</strong><p>{step.description}</p></li>)}</ol>
    <p className="game-status-help">{t('已有账号的验证码导入、敏感备份导出以及交易与市场确认，与新建绑定是不同功能；支持前者不代表当前已经支持绑定', 'Importing existing authenticators, exporting sensitive backups, and handling trade or market confirmations are separate from enrollment. Support for those features does not mean direct enrollment is enabled')}</p>
  </section>
}
