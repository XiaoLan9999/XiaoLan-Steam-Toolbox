export interface WindowUiState { maximized: boolean; focused: boolean; language?: 'zh-CN' | 'en' }
export interface WindowUiApi {
  state(): Promise<WindowUiState>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  onState(listener: (state: WindowUiState) => void): () => void
}
