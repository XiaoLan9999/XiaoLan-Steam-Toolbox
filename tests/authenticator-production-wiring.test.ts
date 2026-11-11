import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
describe('security-sensitive authenticator production boundaries', () => {
  it('cancels confirmation leases on true hiding, never merely on native-dialog focus loss', () => {
    expect(source).toContain("artworkWindow.on('hide', invalidateConfirmationView)")
    expect(source).toContain("artworkWindow.on('minimize', invalidateConfirmationView)")
    expect(source).not.toContain("artworkWindow.on('blur', invalidateConfirmationView)")
    expect(source).toContain('confirmationVisibility.signal')
    expect(source).toContain('SteamAuthenticatorConfirmationSafetyJournal')
  })
  it('blocks ordinary exit when newly issued secrets exist only in memory', () => {
    expect(source).toContain('hasUnpersistedIssuedMaterial()')
    expect(source).toContain('unsafeAuthenticatorExitApproved')
    expect(source).toContain('choice.response === 1 && choice.checkboxChecked')
    expect(source).toContain('await authenticatorEnrollment?.shutdown()')
  })
  it('keeps secret exports and recovery views in main-only native dialogs', () => {
    expect(source).toContain("handle('authenticator:export'")
    expect(source).toContain('authenticator!.exportTo(entry.id, selected.filePath)')
    expect(source).toContain('authenticatorEnrollment!.exportPendingBackup(input.id, selected.filePath)')
    expect(source).toContain('state.hasRescueMaterials')
    const shared = readFileSync(new URL('../src/shared/steam-authenticator-enrollment.ts', import.meta.url), 'utf8')
    const dto = shared.slice(shared.indexOf('export interface SteamAuthenticatorEnrollmentSnapshot'), shared.indexOf('export interface SteamAuthenticatorEnrollmentAction'))
    expect(dto).not.toMatch(/(?:sharedSecret|identitySecret|revocationCode|accessToken|refreshToken|password)/)
  })
})
