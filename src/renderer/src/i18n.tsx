import { createContext, useContext, useMemo, type ReactNode } from 'react'

export type Language = 'zh-CN' | 'en'
export type Translate = (zh: string, en: string) => string

const I18nContext = createContext<{ language: Language; t: Translate }>({
  language: 'zh-CN', t: (zh) => zh
})

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }): React.JSX.Element {
  const value = useMemo(() => ({ language, t: (zh: string, en: string) => language === 'en' ? en : zh }), [language])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): { language: Language; t: Translate } {
  return useContext(I18nContext)
}
