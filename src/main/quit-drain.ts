interface QuitDrainOptions {
  prepare: ReadonlyArray<() => void>
  drain(): void | Promise<void>
  onSettled(): void
}

export class QuitDrain {
  private flight: Promise<void> | null = null
  private completed = false
  constructor(private readonly options: QuitDrainOptions) {}
  get settled(): boolean { return this.completed }

  begin(): Promise<void> {
    if (this.flight) return this.flight
    this.flight = Promise.resolve().then(async () => {
      for (const prepare of this.options.prepare) {
        try { prepare() } catch { /* One failed subsystem must not skip the native drain. */ }
      }
      try { await this.options.drain() } catch { /* A bounded retirement failure is not confirmed cleanup. */ }
      this.completed = true
      this.options.onSettled()
    })
    return this.flight
  }
}
