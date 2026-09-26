/**
 * 阅读(Legado) 书源 JSON 类型（与 legado 3.x 兼容）
 *
 * 参考：https://github.com/gedoor/legado
 * legado 单源 JSON 字段（节选与本计划相关）：
 *  - 元数据：bookSourceName / bookSourceUrl / bookSourceType / bookSourceGroup /
 *           bookSourceComment / customOrder / enabled / enabledExplore /
 *           enabledCookieJar / eventListener / weight / respondTime /
 *           lastUpdateTime / updateUrl
 *  - 抓取：bookUrlPattern / searchUrl / exploreUrl / loginUrl / loginUi / header / jsLib
 *  - 解析规则：ruleSearch / ruleExplore / ruleBookInfo / ruleToc / ruleContent
 *
 * Level 1+2 范围：CSS / regex / JSONPath / `<js>` / `{{...}}` 模板。
 * 含 java.* / source.* / book.* / cookie.* / Packages. / jsLib / loginUrl / loginUi
 * 的源会被 translator 拒绝（请走智能添加手写）。
 */

export type LegadoSourceType = 0 | 1 | 2 | 3 | 4 | number;
/** legado sourceType：0=小说 1=听书 2=视频 3=漫画 4=文件；其他容错为 novel */
export const LEGADO_SOURCE_TYPE_MAP: Record<number, 'novel' | 'comic' | 'video' | 'music' | 'webpage'> = {
  0: 'novel',
  1: 'music',
  2: 'video',
  3: 'comic',
  4: 'webpage',
};

/** legado rule* 字段：字段名 → 规则字符串（CSS / regex / JSONPath / <js> / {{template}}） */
export interface LegadoRules {
  [field: string]: string | undefined;
}

export interface LegadoSource {
  bookSourceName: string;
  bookSourceUrl: string;
  bookSourceType: LegadoSourceType;
  bookSourceGroup?: string;
  bookSourceComment?: string;
  customOrder?: number;
  enabled?: boolean;
  enabledExplore?: boolean;
  enabledCookieJar?: boolean;
  eventListener?: boolean;
  bookUrlPattern?: string;
  searchUrl?: string;
  exploreUrl?: string;
  loginUrl?: string;
  loginUi?: string;
  /** HTTP 请求头，JSON 字符串（legado 习惯） */
  header?: string;
  /** 共享 JS 库（在沙箱其它 JS 之前注入） */
  jsLib?: string;
  ruleSearch?: LegadoRules;
  ruleExplore?: LegadoRules;
  ruleBookInfo?: LegadoRules;
  ruleToc?: LegadoRules;
  ruleContent?: LegadoRules;
  lastUpdateTime?: number;
  /** 单次 HTTP 超时（毫秒）；pomreader 沙箱目前固定 15s，仅用作元信息 */
  respondTime?: number;
  /** 排序权重 */
  weight?: number;
  /** 在线更新 URL（升级用） */
  updateUrl?: string;
}

/** 单源或订阅列表的导入结果（UI 直接消费） */
export interface LegadoImportItem {
  /** 文件名（slug(bookSourceName) + .js；冲突时 UI 给"覆盖/跳过"） */
  fileName: string;
  /** 派生 uuid（用 bookSourceName 哈希；写盘到 JS 头部 @uuid） */
  uuid: string;
  source: LegadoSource;
  /** 翻译结果：成功=可执行 JS；失败=骨架 JS（嵌入原始 JSON + 空 stub） */
  translatedJs: string;
  /** 是否为骨架（true = 不可执行，需手写） */
  isSkeleton: boolean;
  /** 翻译失败原因（仅 isSkeleton=true 时有值；UI 红字提示） */
  translateError: string | null;
  /** 文件名是否已存在于 booksources 目录（UI 给覆盖/跳过选项） */
  overwritesExisting: boolean;
}
