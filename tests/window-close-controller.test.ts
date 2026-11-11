import { describe, expect, it, vi } from 'vitest'
import { createWindowCloseController, type WindowCloseChoice } from '../src/main/window-close-controller'
import type { WindowCloseMode } from '../src/shared/window-lifecycle'

function fixture(mode: WindowCloseMode = 'ask') {
  let saved = mode, quitting = false
  const options = { mode: () => saved, save: vi.fn((value: WindowCloseMode) => { saved = value }),
    choose: vi.fn(async (): Promise<WindowCloseChoice> => ({ action: 'tray', remember: true })), ensureTray: vi.fn(() => true), hide: vi.fn(), quit: vi.fn(), unavailable: vi.fn(), isQuitting: () => quitting }
  return { controller: createWindowCloseController(options), options, saved: () => saved, quitting: () => { quitting = true } }
}
describe('close to tray is distinct from an actual exit', () => {
  it('asks on the first close and hides only after ensuring a working tray', async () => {
    const f = fixture(); await f.controller.request()
    expect(f.options.choose).toHaveBeenCalledOnce(); expect(f.saved()).toBe('tray')
    expect(f.options.ensureTray).toHaveBeenCalledOnce(); expect(f.options.hide).toHaveBeenCalledOnce(); expect(f.options.quit).not.toHaveBeenCalled()
    await f.controller.request(); expect(f.options.choose).toHaveBeenCalledOnce()
  })
  it('does not stop background tasks merely by hiding the window', async () => {
    const f = fixture('tray'); await f.controller.request()
    expect(f.options.hide).toHaveBeenCalledOnce(); expect(f.options.quit).not.toHaveBeenCalled()
  })
  it('requests the real application quit path rather than destroying a window directly', async () => {
    const f = fixture('quit'); await f.controller.request()
    expect(f.options.quit).toHaveBeenCalledOnce(); expect(f.options.hide).not.toHaveBeenCalled()
  })
  it('keeps the GUI available when a tray cannot be created', async () => {
    const f = fixture(); f.options.ensureTray.mockReturnValue(false); await f.controller.request()
    expect(f.options.hide).not.toHaveBeenCalled(); expect(f.options.quit).not.toHaveBeenCalled(); expect(f.options.save).not.toHaveBeenCalled()
    expect(f.options.unavailable).toHaveBeenCalledOnce()
  })
  it('cancels without changing the preference or any lifecycle', async () => {
    const f = fixture(); f.options.choose.mockResolvedValue({ action: 'cancel', remember: true }); await f.controller.request()
    expect(f.options.save).not.toHaveBeenCalled(); expect(f.options.hide).not.toHaveBeenCalled(); expect(f.options.quit).not.toHaveBeenCalled()
  })
  it('does not save a one-off choice when the checkbox is cleared', async () => {
    const f = fixture(); f.options.choose.mockResolvedValue({ action: 'quit', remember: false }); await f.controller.request()
    expect(f.options.save).not.toHaveBeenCalled(); expect(f.options.quit).toHaveBeenCalledOnce()
  })
  it('does not show duplicate first-close prompts or hide after a separate real quit begins', async () => {
    const f = fixture(); let done!: (value: WindowCloseChoice) => void
    f.options.choose.mockImplementation(() => new Promise(resolve => { done = resolve }))
    const first = f.controller.request(); await f.controller.request()
    expect(f.options.choose).toHaveBeenCalledOnce(); f.quitting(); done({ action: 'tray', remember: true }); await first
    expect(f.options.hide).not.toHaveBeenCalled(); expect(f.options.save).not.toHaveBeenCalled()
  })
})
