import { DomainError } from './domain'

export interface BatchFailurePolicy {
  definiteFailure: 'skip' | 'pause'
  uncertainResult: 'verify_then_skip' | 'skip' | 'verify_then_pause'
}

export const DEFAULT_BATCH_FAILURE_POLICY: Readonly<BatchFailurePolicy> = Object.freeze({
  definiteFailure: 'skip', uncertainResult: 'verify_then_skip'
})

export function validateBatchFailurePolicy(value: unknown = DEFAULT_BATCH_FAILURE_POLICY): BatchFailurePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['definiteFailure', 'uncertainResult'].includes(key))) {
    throw new DomainError('INVALID_BATCH_FAILURE_POLICY', '留言失败处理策略无效')
  }
  const policy = value as Record<string, unknown>
  if (typeof policy.definiteFailure !== 'string' || !['skip', 'pause'].includes(policy.definiteFailure) ||
    typeof policy.uncertainResult !== 'string' || !['verify_then_skip', 'skip', 'verify_then_pause'].includes(policy.uncertainResult)) {
    throw new DomainError('INVALID_BATCH_FAILURE_POLICY', '请选择有效的失败及待核对处理方式')
  }
  return { definiteFailure: policy.definiteFailure as BatchFailurePolicy['definiteFailure'],
    uncertainResult: policy.uncertainResult as BatchFailurePolicy['uncertainResult'] }
}
