let active = false
const subscribers = new Set<(active: boolean) => void>()

export const isEnergySavingActive = (): boolean => active

export function subscribeEnergySaving(listener: (active: boolean) => void): () => void {
  subscribers.add(listener)
  return () => { subscribers.delete(listener) }
}

function publish(value: boolean): void {
  if (active === value) return
  active = value
  for (const listener of [...subscribers]) {
    try { listener(value) } catch { /* A visual observer cannot affect background tasks. */ }
  }
}

export interface RendererEnergySaver {
  update(enabled: boolean, background: boolean): void
  dispose(): void
}

export function createRendererEnergySaver(options: {
  document?: Document
  onChange?(active: boolean): void
} = {}): RendererEnergySaver {
  const page = options.document ?? (typeof document === 'undefined' ? undefined : document)
  let enabled = true
  let background = false
  let stopped = false
  let saving = false
  let oldAttribute: string | null = null
  let observer: MutationObserver | undefined
  const animations = new Set<Animation>()
  const media = new Map<HTMLMediaElement, { source: string; stream: HTMLMediaElement['srcObject'] }>()
  const source = (element: HTMLMediaElement): string => JSON.stringify([element.getAttribute('src'),
    [...element.querySelectorAll('source')].map(child => [child.getAttribute('src'), child.getAttribute('type'), child.getAttribute('media')])])

  const pauseMedia = (element: HTMLMediaElement): void => {
    if (!element.paused && !element.ended) {
      if (!media.has(element)) media.set(element, { source: source(element), stream: element.srcObject })
      try { element.pause() } catch { media.delete(element) }
    }
  }
  const scan = (): void => {
    if (!page || !saving || stopped) return
    for (const element of media.keys()) if (!element.isConnected) media.delete(element)
    for (const element of page.querySelectorAll<HTMLMediaElement>('video,audio')) pauseMedia(element)
    for (const animation of page.getAnimations?.() ?? []) {
      if (animation.playState !== 'running') continue
      try { animation.pause(); animations.add(animation) } catch { /* Detached effects may already be cancelled. */ }
    }
    for (const animation of animations) {
      const target = (animation.effect as KeyframeEffect | null)?.target
      if (animation.playState === 'idle' || target && !target.isConnected) animations.delete(animation)
    }
  }
  const onPlay = (event: Event): void => {
    const target = event.target
    if (saving && target && 'tagName' in target && ['VIDEO', 'AUDIO'].includes(String(target.tagName))) {
      pauseMedia(target as HTMLMediaElement)
    }
  }
  const apply = (): void => {
    const next = !!page && enabled && (background || page.visibilityState === 'hidden')
    if (stopped || next === saving) return
    saving = next
    if (saving) {
      oldAttribute = page!.documentElement.getAttribute('data-energy-saving')
      scan()
      page!.documentElement.setAttribute('data-energy-saving', 'active')
      page!.addEventListener('play', onPlay, true)
      const Observer = page!.defaultView?.MutationObserver
      if (Observer) {
        observer = new Observer(scan)
        observer.observe(page!.documentElement, { childList: true, subtree: true, attributes: true,
          attributeFilter: ['class', 'style', 'src', 'autoplay'] })
      }
    } else {
      observer?.disconnect()
      observer = undefined
      page!.removeEventListener('play', onPlay, true)
      if (oldAttribute === null) page!.documentElement.removeAttribute('data-energy-saving')
      else page!.documentElement.setAttribute('data-energy-saving', oldAttribute)
      for (const animation of animations) {
        const target = (animation.effect as KeyframeEffect | null)?.target
        if (animation.playState !== 'paused' || target && !target.isConnected) continue
        try { animation.play() } catch { /* A changed or removed effect is not restarted. */ }
      }
      animations.clear()
      const paused = [...media]
      media.clear()
      for (const [element, previous] of paused) {
        if (!element.isConnected || !element.paused || element.ended || source(element) !== previous.source || element.srcObject !== previous.stream) continue
        try { void element.play()?.catch(() => undefined) } catch { /* Autoplay restrictions must not cause a retry loop. */ }
      }
    }
    publish(saving)
    try { options.onChange?.(saving) } catch { /* The media lifecycle must remain reversible. */ }
  }
  page?.addEventListener('visibilitychange', apply)
  apply()
  return {
    update(nextEnabled, nextBackground): void {
      if (stopped) return
      enabled = nextEnabled
      background = nextBackground
      apply()
    },
    dispose(): void {
      if (stopped) return
      enabled = false
      apply()
      stopped = true
      observer?.disconnect()
      page?.removeEventListener('visibilitychange', apply)
    }
  }
}
