import { useEffect, useState } from 'react'
import { DEFAULT_BATCH_FAILURE_POLICY, type BatchFailurePolicy } from '../../../shared/batch-failure-policy'
import type { BatchSummary } from '../../../shared/types'
import { useI18n, type Translate } from '../i18n'
import { unwrap } from '../ui'
import type { RunAction } from './types'
import { batchVerificationActive } from './BatchVerificationPanel'
import './batch-failure-policy.css'

export function failurePolicySummary(value: BatchFailurePolicy, t: Translate): string {
  const definite = value.definiteFailure === 'pause' ? t('普通失败暂停', 'Pause on definite failures') : t('普通失败跳过', 'Skip definite failures')
  const uncertain = value.uncertainResult === 'skip' ? t('待核对直接跳过', 'Skip uncertain results without checking')
    : value.uncertainResult === 'verify_then_pause' ? t('自动核对，未确认则暂停', 'Verify; pause if still uncertain')
      : t('自动核对，未确认则跳过', 'Verify; skip if still uncertain')
  return `${definite} / ${uncertain}`
}

export function BatchFailurePolicyFields({ value, onChange, disabled = false }: {
  value: BatchFailurePolicy; onChange(value: BatchFailurePolicy): void; disabled?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  return <fieldset className="batch-failure-fields" disabled={disabled}>
    <legend>{t('失败处理策略', 'Failure handling')}</legend>
    <label>{t('发送失败 / 发送前评论区不可读', 'Recipient failure / unreadable pre-send comments')}
      <select value={value.definiteFailure} onChange={event => onChange({ ...value, definiteFailure: event.target.value as BatchFailurePolicy['definiteFailure'] })}>
        <option value="skip">{t('记录失败，跳过并继续下一位', 'Record failure, skip and continue')}</option>
        <option value="pause">{t('记录失败，暂停任务供我处理', 'Record failure and pause for review')}</option>
      </select>
    </label>
    <label>{t('发送结果不确定 / 待核对', 'Uncertain delivery result')}
      <select value={value.uncertainResult} onChange={event => onChange({ ...value, uncertainResult: event.target.value as BatchFailurePolicy['uncertainResult'] })}>
        <option value="verify_then_skip">{t('自动核对，仍未确认则跳过继续', 'Verify, then skip if still uncertain')}</option>
        <option value="skip">{t('不自动核对，保留待核对并直接跳过', 'Keep uncertain and skip without checking')}</option>
        <option value="verify_then_pause">{t('自动核对，仍未确认则暂停', 'Verify, then pause if still uncertain')}</option>
      </select>
    </label>
    <p>{t('网络或服务请求失败、Steam 明确提示无法留言时，直接跳过并记录原因，不因这些错误暂停。跳过不代表成功；未提交的记为未发送，提交结果不明的保留待核对且不重发。网络失败不归为对方禁止留言；明确无权限的好友自动归入“无法留言”。其他评论区读取问题遵循上方策略。登录失效、Steam 限流和有效冷却仍需等待恢复。',
      'Network/service request failures and explicit comment-permission denials are always recorded and skipped without pausing. Skipping does not mean success. Unsubmitted comments stay not sent; uncertain submissions stay for review and are never resent. Network failures do not imply the recipient forbids comments. Explicit denials move the friend to Comments unavailable. Other unreadable-comment cases follow the policy above. Expired sign-in, Steam rate limits and active cooldown still require recovery.')}</p>
  </fieldset>
}

export function BatchFailurePolicyPanel({ batch, runAction, disabled = false }: {
  batch: BatchSummary; runAction: RunAction; disabled?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const saved = batch.failurePolicy ?? DEFAULT_BATCH_FAILURE_POLICY
  const savedKey = `${saved.definiteFailure}:${saved.uncertainResult}`
  const [value, setValue] = useState<BatchFailurePolicy>({ ...saved })
  const [saving, setSaving] = useState(false)
  useEffect(() => { setValue({ ...saved }) }, [batch.id, savedKey])
  const editable = batch.status === 'paused' && batch.sending === 0 && !batchVerificationActive(batch)
  const dirty = value.definiteFailure !== saved.definiteFailure || value.uncertainResult !== saved.uncertainResult
  return <details className="batch-failure-panel"><summary>{t('此任务的失败处理', 'Failure handling for this task')}</summary>
    <BatchFailurePolicyFields value={value} onChange={setValue} disabled={disabled || saving || !editable} />
    <p>{editable ? t('仅修改此任务的后续处理方式；保存不会恢复发送或改写已有投递结果。',
      'Changes affect only subsequent handling in this task. Saving does not resume sending or rewrite existing results.')
      : t('策略已随任务保存。请先暂停任务，并等待在途发送或核对结束后再修改。',
        'The policy is saved with the task. Pause and wait for in-flight sending or verification before editing.')}</p>
    {editable && <button disabled={disabled || saving || !dirty} onClick={() => {
      if (saving || !dirty) return
      setSaving(true)
      void runAction(t('正在保存处理策略', 'Saving failure policy'), async () => {
        unwrap(await window.steamCommenter.setBatchFailurePolicy(batch.id, value))
      }, t('已保存策略，任务仍保持暂停', 'Policy saved; the task remains paused')).finally(() => setSaving(false))
    }}>{t('保存到此任务（不恢复发送）', 'Save to task (do not resume)')}</button>}
  </details>
}
