/**
 * Electron HTMLWebViewElement 扩展方法
 *
 * DOM lib 中 HTMLWebViewElement 只声明部分方法；Electron guest 注入的运行时方法
 * （stop / setAudioMuted / getWebContentsId 等）需在此扩展。
 *
 * Universal search 等使用 webview 的组件不再 `as any`，通过此 declaration merging
 * 即可访问 Electron 专有 API。
 */
declare interface HTMLWebViewElement {
  /** 停止当前加载（Electron 专有，未在 DOM lib 中） */
  stop(): void;
  /** 设置 webview 音频静音 */
  setAudioMuted(muted: boolean): void;
}

/** will-navigate / new-window 事件对象的 detail 字段 */
declare interface WebviewNavigateEvent {
  url: string;
  preventDefault?: () => void;
}

declare interface HTMLElementEventMap {
  'will-navigate': WebviewNavigateEvent;
  'new-window': WebviewNavigateEvent;
}

/** will-navigate / new-window 事件对象的 detail 字段 */
declare interface WebviewNavigateEvent {
  url: string;
  preventDefault?: () => void;
}

declare interface HTMLElementEventMap {
  'will-navigate': WebviewNavigateEvent;
  'new-window': WebviewNavigateEvent;
}
