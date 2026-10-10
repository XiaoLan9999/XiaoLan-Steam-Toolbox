import { describe, expect, it, vi } from 'vitest'
import { savePausedScanDelay } from '../src/renderer/src/comment-scan-actions'

describe('paused check interval actions', () => {
  it('saves a fractional interval and does not automatically resume', async () => {
    const api = { updateCommentScanDelay: vi.fn(async () => ({ ok: true as const, data: undefined })), resumeCommentScan: vi.fn() }
    await savePausedScanDelay(api, 'job', 100, false)
    expect(api.updateCommentScanDelay).toHaveBeenCalledWith('job', 100)
    expect(api.resumeCommentScan).not.toHaveBeenCalled()
  })

  it('waits for persistence before resuming the same task', async () => {
    const order: string[] = []
    const api = {
      updateCommentScanDelay: vi.fn(async () => { order.push('save'); return { ok: true as const, data: undefined } }),
      resumeCommentScan: vi.fn(async () => { order.push('resume'); return { ok: true as const, data: undefined } })
    }
    await savePausedScanDelay(api, 'job', 300, true)
    expect(order).toEqual(['save', 'resume'])
  })

  it('never resumes if saving fails', async () => {
    const api = { updateCommentScanDelay: vi.fn(async () => ({ ok: false as const, error: { code: 'SCAN_NOT_PAUSED', message: 'Pause first' } })), resumeCommentScan: vi.fn() }
    await expect(savePausedScanDelay(api, 'job', 100, true)).rejects.toThrow('Pause first')
    expect(api.resumeCommentScan).not.toHaveBeenCalled()
  })

  it('does not resume stale account actions after saving completes', async () => {
    let current = true
    const api = { updateCommentScanDelay: vi.fn(async () => { current = false; return { ok: true as const, data: undefined } }), resumeCommentScan: vi.fn() }
    await savePausedScanDelay(api, 'job', 100, true, () => current)
    expect(api.resumeCommentScan).not.toHaveBeenCalled()
  })
})
