export type FetchErrorCode =
  | 'invalid-url'
  | 'source-unavailable'
  | 'timeout'
  | 'parse-failed'
  | 'unsupported-source';

export class FetchError extends Error {
  constructor(public readonly code: FetchErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'FetchError';
  }
}

/** 错误码 → 用户可读文案 */
export const FETCH_ERROR_MESSAGES: Record<FetchErrorCode, string> = {
  'invalid-url': 'URL 格式无效。',
  'source-unavailable': '该书源暂时不可用，请稍后重试。',
  timeout: '请求超时，请稍后重试。',
  'parse-failed': '页面解析失败，该书源可能已改版。',
  'unsupported-source': 'URL 无效，请输入完整的 http/https 书页地址。',
};
