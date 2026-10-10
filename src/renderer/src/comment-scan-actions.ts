import type { SteamFriendCommenterApi } from '../../shared/types'
import { unwrap } from './ui'

export async function savePausedScanDelay(
  api: Pick<SteamFriendCommenterApi, 'updateCommentScanDelay' | 'resumeCommentScan'>,
  jobId: string,
  delayMs: number,
  resume: boolean,
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (!isCurrent()) return
  unwrap(await api.updateCommentScanDelay(jobId, delayMs))
  if (resume && isCurrent()) unwrap(await api.resumeCommentScan(jobId))
}
