# Book.bookSourceUuid 锚定 + 外审修复

**Status**: 🔄 In progress (start time: 2026-09-26)
**Owner**: Claude (Opus 5)

## 背景

按"来源决定下载方式"的诉求，给通过数据源导入的小说加 `bookSourceUuid`（legado meta.uuid）锚定具体书源，方便后续重抓章节内容时调书源特定方法。

外审（code review Round 1）verdict = `NEEDS_CHANGES`，2 个 P0 + 4 个 P1 + 4 个 P2，本任务修复 P0/P1，P2 留 follow-up。

## 问题分析

| # | 问题 | 等级 |
|---|---|---|
| P0-1 | `importByUrl` 静默降级：sourceName 显式给但 match 失败时不抛错 → 走 fallback → user 选的书源与 Book.bookSourceUuid 锚定不一致 | **必修** |
| P0-2 | `getByUuid` 用 `name` 兜底 → 破坏 `getByUuid('universal')` 不误命中的 invariant | **必修** |
| P1-1 | `'universal'` 魔法字符串散落多处 | 强烈建议 |
| P1-2 | `(a as { meta?: { uuid?: string } }).meta` 鸭子类型断言重复 4 次 | 强烈建议 |
| P1-3 | 缺 8 类关键测试（反向/边界/迁移） | 强烈建议 |
| P1-4 | `parsedBookSourceUuid` 生命周期注释缺失 | 强烈建议 |
| P2-1 | `findJsSourceAdapterByUrl` 每次遍历调 `match()`（性能隐患） | follow-up |
| P2-2 | `forTest` 用 `Object.create + as any` 绕过 DI | follow-up |
| P2-3 | `BookDoc` IndexedDB 迁移注释缺失 | follow-up |
| P2-4 | `totalChars: chapters.length * 2000` 估算粗糙 | follow-up |

## 修复任务

### 子任务 A：P0-1 importByUrl 静默降级 → 抛错
**文件**：`import-via-source.service.ts`

```ts
async importByUrl(url: string, sourceName?: string): Promise<ImportByUrlResult> {
  if (sourceName) {
    const adapter = this.registry.get(sourceName);
    if (!adapter) {
      throw new FetchError('unsupported-source', `书源 "${sourceName}" 不存在或未启用`);
    }
    if (!adapter.match(url)) {
      throw new FetchError('unsupported-source',
        `书源 "${sourceName}" 不支持该 URL：${url}`);
    }
    const fetcher = this.requireFetcher();
    const book = await adapter.fetchCatalog(url, fetcher);
    return { book, bookSourceUuid: extractMetaUuid(adapter) };
  }
  // 仅 sourceName 未指定时走万能搜索 fallback
  const book = await this.registry.fetchCatalog(url);
  return { book };
}
```

`ImportOnlineComponent.parse()` catch 后展示给用户（toast / alert）。

### 子任务 B：P0-2 getByUuid 移除 name 兜底
**文件**：`book-source.registry.ts`

```ts
getByUuid(uuid: string): BookSourceAdapter | undefined {
  if (!uuid || uuid === UNIVERSAL_BOOK_SOURCE_UUID) return undefined;
  return this.adapters.find((a) => extractMetaUuid(a) === uuid);
}
```

如确有"按 name 查"需求，另开 `getByName(name: string)` 方法（独立 API，语义清晰）。

### 子任务 C：P1-1 抽常量
**新文件**：`book-source.constants.ts`

```ts
/** 万能搜索 / 启发式兜底锚定标识（非具体书源） */
export const UNIVERSAL_BOOK_SOURCE_UUID = 'universal' as const;
export type BookSourceUuid = string;
```

各文件用 `import { UNIVERSAL_BOOK_SOURCE_UUID } from './book-source.constants';`，禁用裸字符串。

### 子任务 D：P1-2 抽类型守卫
**新文件**：`book-source.adapter.ts`（追加）或 `book-source.helpers.ts`（新文件）

```ts
import { BookSourceAdapter } from './book-source.adapter';

/** duck typing 提取 meta.uuid（JsSourceAdapter 持有，registry 不耦合 js-source 子模块） */
export function extractMetaUuid(adapter: BookSourceAdapter): string | undefined {
  const meta = (adapter as { meta?: { uuid?: unknown } }).meta;
  const uuid = meta?.uuid;
  return typeof uuid === 'string' && uuid ? uuid : undefined;
}

/** 类型守卫：adapter 是否持有有效 meta.uuid */
export function hasMetaUuid(adapter: BookSourceAdapter): boolean {
  return !!extractMetaUuid(adapter);
}
```

`getByUuid` / `findJsSourceAdapterByUrl` / `importByUrl` 全部复用。

### 子任务 E：P1-4 parsedBookSourceUuid 显式重置 + 注释
**文件**：`import-online.component.ts`

```ts
/**
 * 解析后缓存的 bookSourceUuid（JsSourceAdapter 来源 meta.uuid）
 * 生命周期：组件实例随 modal 每次 create 重建；parse() 入口显式重置，避免多次 parse 残留
 */
private parsedBookSourceUuid?: string;

async parse(): Promise<void> {
  this.parsedBookSourceUuid = undefined;  // 显式重置（已加，加注释）
  // ...
}
```

### 子任务 F：P1-3 补 8 类测试
**文件**：`import-via-source.service.spec.ts` + `book-source.spec.ts`

| # | 场景 | 文件 |
|---|---|---|
| 1 | `importByUrl(url, 'A')` match false 抛错（P0-1 回归） | import-via-source.spec |
| 2 | `importByUrl(url, '不存在的源')` 抛错 | import-via-source.spec |
| 3 | `getByUuid('universal')` 存在 name === 'universal' 的 adapter 返回 undefined（P0-2 回归） | book-source.spec |
| 4 | `importByUrl` 返回 `bookSourceUuid: ''` 归一化为 undefined | import-via-source.spec |
| 5 | `ImportOnlineComponent` 多次 parse 重置 parsedBookSourceUuid（构造级测试，optional） | import-online.spec（无则跳过） |
| 6 | `findJsSourceAdapterByUrl` 多个 adapter match 返回首个 | book-source.spec |
| 7 | 旧 BookDoc 无 bookSourceUuid 字段读出（db.service 迁移测试） | db.service.spec |
| 8 | bookSourceUuid === undefined 兜底走 universal 逻辑（ImportOnlineComponent 测试或注释） | 注释为主 |

## 预期效果

1. ✅ `importByUrl(url, 'A')` match 失败抛错 → 用户明确知道选了不合适的书源
2. ✅ `getByUuid('universal')` 永远返回 undefined（即使存在同名 adapter）
3. ✅ `'universal'` 常量化，散落处用 import 引用
4. ✅ 鸭子类型断言工具化，重复 4 处归 1 处
5. ✅ 测试覆盖完整（正向 + 反向 + 边界 + 迁移）

## 验收标准

- [ ] vitest 214+8=222+ 用例全绿
- [ ] tsc 0 错误
- [ ] 外审 Round 2 verdict = APPROVED
- [ ] 不破坏既有 MockAdapter 测试契约

## 风险评估

| 风险 | 缓解 |
|---|---|
| P0-1 抛错破坏既有依赖静默降级的调用方 | 仅 `ImportOnlineComponent.parse()` 一处调用方，catch 处理 toast |
| P0-2 移除 name 兜底影响未来需求 | 保留 `getByName()` 独立 API |
| P1-1 抽常量影响 string literal 比较 | `BookSourceUuid` 是字符串类型别名，不改变比较语义 |

## External Review Opinion

### Round 1（kind=code，verdict=NEEDS_CHANGES，2026-09-26）
外审列出 2 P0 + 4 P1 + 4 P2。

→ Round 2 待补：
