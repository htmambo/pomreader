/**
 * 差分测试离线打桩（方案 §7.1 / F17）：sandbox.worker 协议的纯本地实现，零网络。
 *
 * 用法：`SandboxService.forTest(new FixtureWorker() as unknown as Worker)`。
 * 打桩边界刻意画在「Worker 执行环境」这一层：
 *  - 本类负责的部分逐字镜像 sandbox.worker.ts：模块编译（compileModule :257-263）、
 *    legado shim（buildShim :266-295）、http-result 的 2xx-only 契约（:401-410）、
 *    query-result 回执（:412-421）、call 的 error=stack 回传（:382-393）。
 *  - 出站 `type:'http'` 消息由**真实** SandboxService.proxyHttp 处理（sandbox.service.ts:614-663），
 *    其 `window.pomAPI.booksourceHttpProxy` 在 spec 里被 mock 成 URL → 本地 HTML fixture 映射。
 *  - 出站 `type:'query'` 消息由**真实** SandboxService.proxyQuery 处理（sandbox.service.ts:673-731），
 *    即主线程 DOMParser 真实实现 + `pom.cssRules=0` 门禁 —— 不在这里复制该逻辑，
 *    否则等于拿移植副本测引擎（方案 §7.1 明确禁止）；JS 侧的 query 链路保持生产代码原样。
 *
 * 消息时序：全部走 queueMicrotask（与 sandbox.spec.ts 的 MockWorker 同款），
 * SandboxService 内部全部基于 Promise 等待，微任务延迟不影响协议正确性。
 */

/** legado.query 契约（与 sandbox.worker.ts:191-203 / sandbox.service.ts:64-76 同源声明） */
interface QueryLink {
  href: string;
  text: string;
}
interface QueryItem {
  tag: string;
  text: string;
  html: string;
  href: string;
  links: QueryLink[];
  attrs?: Record<string, string>;
}

interface HttpProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

interface HttpProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type InboundMessage = Record<string, unknown> & { type: string; reqId?: string };
type OutboundMessage = Record<string, unknown>;

type Module = Record<string, ((...args: unknown[]) => unknown) | undefined>;

/** 模块导出表后缀（逐字镜像 sandbox.worker.ts:260 的 return 表） */
const RETURN_TABLE =
  `\n;return {\n  search: typeof search === "function" ? search : undefined,\n` +
  `  bookInfo: typeof bookInfo === "function" ? bookInfo : undefined,\n` +
  `  toc: typeof toc === "function" ? toc : undefined,\n` +
  `  chapterList: typeof chapterList === "function" ? chapterList : undefined,\n` +
  `  content: typeof content === "function" ? content : undefined,\n` +
  `  chapterContent: typeof chapterContent === "function" ? chapterContent : undefined,\n` +
  `  explore: typeof explore === "function" ? explore : undefined\n};`;

export class FixtureWorker {
  onmessage: ((e: { data: OutboundMessage }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = false;

  private readonly modules = new Map<string, Module>();
  private readonly pendingHttp = new Map<
    string,
    { resolve: (v: HttpProxyResponse) => void; reject: (e: Error) => void }
  >();
  private readonly pendingQueries = new Map<
    string,
    { resolve: (v: QueryItem[]) => void; reject: (e: Error) => void }
  >();

  constructor() {
    // worker-ready 必须在 listener 注册后到达（sandbox.worker.ts:440-441 同款约束）：
    // SandboxService.forTest 同步 attach（设置 onmessage），queueMicrotask 保证时序。
    queueMicrotask(() => this.emit({ type: 'worker-ready' }));
  }

  /** 主线程 → Worker 入站消息（SandboxService.postMessage 调这里） */
  postMessage(data: InboundMessage): void {
    queueMicrotask(() => {
      if (!this.terminated) this.handle(data);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Worker → 主线程出站消息（经 SandboxService.attach 设置的 onmessage 回流） */
  private emit(data: OutboundMessage): void {
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data });
    });
  }

  private handle(msg: InboundMessage): void {
    if (msg.type === 'load') {
      // 镜像 sandbox.worker.ts:337-359：编译失败显式回 error，不吞错
      const fileName = msg['fileName'] as string;
      try {
        const mod = this.compileModule(msg['source'] as string);
        this.modules.set(fileName, mod);
        const fns = Object.entries(mod)
          .filter(([, v]) => typeof v === 'function')
          .map(([k]) => k);
        this.emit({ type: 'loaded', fileName, fns });
      } catch (err) {
        this.emit({
          type: 'loaded',
          fileName,
          fns: [],
          error: String((err as { message?: string })?.message ?? err),
        });
      }
      return;
    }
    if (msg.type === 'call') {
      // 镜像 sandbox.worker.ts:361-395：error 字段回传 err.stack 全文（不是 message）——
      // 差分断言 flag=0 文案时用 toContain 而非 toBe 的原因就在这一层
      const mod = this.modules.get(msg['fileName'] as string);
      if (!mod) {
        this.emit({ type: 'result', reqId: msg.reqId, ok: false, error: '模块未加载' });
        return;
      }
      const fn = mod[msg['fn'] as string];
      if (typeof fn !== 'function') {
        this.emit({
          type: 'result',
          reqId: msg.reqId,
          ok: false,
          error: `函数 ${msg['fn'] as string} 未定义`,
        });
        return;
      }
      Promise.resolve()
        .then(() => fn.apply(mod, msg['args'] as unknown[]))
        .then(
          (value) =>
            this.emit({
              type: 'result',
              reqId: msg.reqId,
              ok: true,
              value: value === undefined ? null : value,
            }),
          (err: unknown) =>
            this.emit({
              type: 'result',
              reqId: msg.reqId,
              ok: false,
              errorName: (err as { name?: string })?.name ?? 'Error',
              error: String(
                (err as { stack?: string; message?: string })?.stack ??
                  (err as { message?: string })?.message ??
                  err,
              ),
            }),
        );
      return;
    }
    if (msg.type === 'invalidate') {
      this.modules.delete(msg['fileName'] as string);
      return;
    }
    if (msg.type === 'http-result') {
      // 镜像 sandbox.worker.ts:401-410：仅 [200,300) resolve，其余 reject Error(`HTTP ${status}`)
      const p = this.pendingHttp.get(msg.reqId as string);
      if (!p) return;
      this.pendingHttp.delete(msg.reqId as string);
      const status = msg['status'] as number;
      if (status >= 200 && status < 300) {
        p.resolve({
          status,
          headers: (msg['headers'] as Record<string, string>) ?? {},
          body: (msg['body'] as string) ?? '',
        });
      } else {
        p.reject(new Error(`HTTP ${status}`));
      }
      return;
    }
    if (msg.type === 'query-result') {
      // 镜像 sandbox.worker.ts:412-421
      const p = this.pendingQueries.get(msg.reqId as string);
      if (!p) return;
      this.pendingQueries.delete(msg.reqId as string);
      if (msg['ok']) {
        p.resolve((msg['items'] as QueryItem[]) ?? []);
      } else {
        p.reject(new Error((msg['error'] as string) ?? '选择器查询失败'));
      }
      return;
    }
  }

  /** 镜像 sandbox.worker.ts:257-263 compileModule：new Function('legado', source + return 表) */
  private compileModule(source: string): Module {
    const factory = new Function('legado', `${source}${RETURN_TABLE}`);
    return factory(this.buildShim()) as Module;
  }

  /** 镜像 sandbox.worker.ts:266-295 buildShim：http.{get,post,request} + query 全部桥回主线程 */
  private buildShim(): {
    http: {
      get: (url: string, headers?: Record<string, string>) => Promise<string>;
      post: (url: string, body?: string, headers?: Record<string, string>) => Promise<string>;
      request: (req: HttpProxyRequest) => Promise<HttpProxyResponse>;
    };
    query: (html: string, selector: string, baseUrl: string) => Promise<QueryItem[]>;
  } {
    return {
      http: {
        get: (url, headers) =>
          this.requestHttp({ url, method: 'GET', headers: headers ?? {} }).then((r) => r.body),
        post: (url, body, headers) =>
          this.requestHttp({
            url,
            method: 'POST',
            body: body ?? null,
            headers: headers ?? {},
          }).then((r) => r.body),
        request: (request) => this.requestHttp(request),
      },
      query: (html, selector, baseUrl) => this.requestQuery(html, selector, baseUrl),
    };
  }

  /** 镜像 sandbox.worker.ts:307-313 */
  private requestHttp(request: HttpProxyRequest): Promise<HttpProxyResponse> {
    return new Promise((resolve, reject) => {
      const reqId = `http-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      this.pendingHttp.set(reqId, { resolve, reject });
      this.emit({ type: 'http', reqId, request });
    });
  }

  /** 镜像 sandbox.worker.ts:315-321 */
  private requestQuery(html: string, selector: string, baseUrl: string): Promise<QueryItem[]> {
    return new Promise((resolve, reject) => {
      const reqId = `query-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      this.pendingQueries.set(reqId, { resolve, reject });
      this.emit({ type: 'query', reqId, html, selector, baseUrl });
    });
  }
}
