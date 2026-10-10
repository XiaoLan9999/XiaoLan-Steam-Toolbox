import { DomainError } from '../shared/domain'

export class AccountTransition {
  private running = false

  get active(): boolean { return this.running }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running) throw new DomainError('ACCOUNT_SWITCH_BUSY', '账号正在切换，请稍候')
    this.running = true
    try { return await operation() }
    finally { this.running = false }
  }
}
