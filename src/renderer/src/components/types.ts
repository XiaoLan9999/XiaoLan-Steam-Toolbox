export type RunAction = <T>(
  label: string,
  action: () => Promise<T>,
  successMessage?: string
) => Promise<T | null>
