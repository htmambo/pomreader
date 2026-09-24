/**
 * Electron `<webview>` 标签的 TypeScript 类型声明
 * webview 是 Electron 专有元素，不在标准 lib.dom.d.ts 中
 */
interface HTMLWebViewElement extends HTMLElement {
  src: string;
  loadURL(url: string): void;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  getWebContentsId(): number;
  addEventListener(
    type: string,
    listener: (event: { url: string; preventDefault?: () => void }) => void
  ): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

interface HTMLElementTagNameMap {
  webview: HTMLWebViewElement;
}
