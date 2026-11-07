export const RENDERER_DIAGNOSTIC_STAGES = [
  'render-error', 'startup-error', 'bridge-unavailable', 'window-error', 'unhandled-rejection',
  'preload-error', 'load-failed', 'document-loaded', 'unresponsive', 'responsive',
  'window-minimized', 'window-restored', 'window-hidden', 'window-shown'
] as const

export type RendererDiagnosticStage = typeof RENDERER_DIAGNOSTIC_STAGES[number]
export interface RendererDiagnosticEvent {
  stage: RendererDiagnosticStage
  errorCode?: number
}

export function sanitizeRendererDiagnostic(value: unknown): RendererDiagnosticEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const input = value as Record<string, unknown>
    if (!RENDERER_DIAGNOSTIC_STAGES.includes(input.stage as RendererDiagnosticStage)) return null
    return { stage: input.stage as RendererDiagnosticStage,
      ...(input.stage === 'load-failed' && Number.isSafeInteger(input.errorCode) &&
        (input.errorCode as number) >= -65536 && (input.errorCode as number) <= 0 ? { errorCode: input.errorCode as number } : {}) }
  } catch { return null }
}
