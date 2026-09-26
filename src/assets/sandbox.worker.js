"use strict";
(() => {
  // src/app/core/book-source/js-source/sandbox.worker.ts
  try {
    logToMain("info", "[sandbox.worker] \u25B6 \u9636\u6BB5 1/4: \u5220\u654F\u611F\u5168\u5C40(window/document/localStorage/parent/top)");
    delete self["window"];
    delete self["document"];
    delete self["localStorage"];
    delete self["parent"];
    delete self["top"];
    logToMain("info", "[sandbox.worker] \u2713 \u9636\u6BB5 1/4 \u5B8C\u6210");
  } catch (err) {
    replyInitError(err, "\u9636\u6BB5 1/4 \u5220\u654F\u611F\u5168\u5C40");
  }
  try {
    logToMain("info", "[sandbox.worker] \u25B6 \u9636\u6BB5 2/4: \u5C4F\u853D 10 \u4E2A\u7F51\u7EDC\u51FA\u53E3(fetch/XMLHttpRequest/WebSocket \u7B49)");
    const NETWORK_API_BLOCKLIST = [
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "importScripts",
      "Worker",
      "SharedWorker",
      "EventSource",
      "WebTransport",
      "RTCPeerConnection",
      "RTCDataChannel"
    ];
    for (const name of NETWORK_API_BLOCKLIST) {
      Object.defineProperty(self, name, {
        get: () => {
          throw new Error(`${name} is disabled in sandbox; use legado.http instead`);
        },
        set: () => {
          throw new Error(`${name} is read-only and disabled in sandbox`);
        },
        enumerable: false,
        configurable: false
      });
    }
    logToMain("info", "[sandbox.worker] \u2713 \u9636\u6BB5 2/4 \u5B8C\u6210");
  } catch (err) {
    replyInitError(err, "\u9636\u6BB5 2/4 \u5C4F\u853D\u7F51\u7EDC\u51FA\u53E3");
  }
  try {
    logToMain("info", "[sandbox.worker] \u25B6 \u9636\u6BB5 3/4: navigator Proxy + sendBeacon \u62E6\u622A");
    const originalNavigator = self["navigator"] ?? {};
    Object.defineProperty(self, "navigator", {
      value: new Proxy(originalNavigator, {
        get(target, prop) {
          if (prop === "sendBeacon") return () => {
            throw new Error("sendBeacon is disabled in sandbox");
          };
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
        has(target, prop) {
          if (prop === "sendBeacon") return true;
          return Reflect.has(target, prop);
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === "sendBeacon") return { configurable: false, enumerable: true, value: void 0 };
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        set(_, prop) {
          if (prop === "sendBeacon") throw new Error("sendBeacon is disabled in sandbox");
          throw new Error(`navigator is read-only in sandbox (attempted set: ${String(prop)})`);
        },
        defineProperty(_, prop) {
          throw new Error(`navigator is frozen in sandbox (attempted defineProperty: ${String(prop)})`);
        },
        deleteProperty(_, prop) {
          throw new Error(`navigator is frozen in sandbox (attempted delete: ${String(prop)})`);
        }
      }),
      writable: false,
      configurable: false
    });
    logToMain("info", "[sandbox.worker] \u2713 \u9636\u6BB5 3/4 \u5B8C\u6210");
  } catch (err) {
    replyInitError(err, "\u9636\u6BB5 3/4 navigator Proxy");
  }
  try {
    logToMain("info", "[sandbox.worker] \u25B6 \u9636\u6BB5 4/4: \u51BB\u7ED3 Object/Array/Function \u539F\u578B\u94FE");
    Object.freeze(Object.prototype);
    Object.freeze(Array.prototype);
    Object.freeze(Function.prototype);
    logToMain("info", "[sandbox.worker] \u2713 \u9636\u6BB5 4/4 \u5B8C\u6210");
  } catch (err) {
    replyInitError(err, "\u9636\u6BB5 4/4 \u51BB\u7ED3\u539F\u578B\u94FE");
  }
  function replyInitError(err, phase = "\u672A\u77E5\u9636\u6BB5") {
    logToMain("error", `[sandbox.worker] \u2717 ${phase}\u629B\u9519:`, err);
    const e = err;
    try {
      self.postMessage({
        type: "init-error",
        error: `${phase}\u5931\u8D25\uFF1A${String(e?.message ?? err)}`,
        stack: String(e?.stack ?? "")
      });
      logToMain("info", "[sandbox.worker] \u2192 init-error \u6D88\u606F\u5DF2\u53D1\u51FA");
    } catch {
      logToMain("error", "[sandbox.worker] \u2717 init-error postMessage \u5931\u8D25(Worker \u5DF2\u6B7B)");
    }
  }
  function logToMain(level, ...args) {
    const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    try {
      self.postMessage({ type: "worker-log", level, msg });
    } catch {
    }
    try {
      if (level === "error") console.error(...args);
      else if (level === "warn") console.warn(...args);
      else console.info(...args);
    } catch {
    }
  }
  function signalReady() {
    try {
      self.postMessage({ type: "worker-ready" });
      logToMain("info", "[sandbox.worker] \u2713 \u542F\u52A8\u5B8C\u6210,worker-ready \u5DF2\u53D1\u51FA");
    } catch {
      logToMain("error", "[sandbox.worker] \u2717 worker-ready postMessage \u5931\u8D25");
    }
  }
  var modules = /* @__PURE__ */ new Map();
  function compileModule(source) {
    const factory = new Function(
      "legado",
      `${source}
;return {
  search: typeof search === "function" ? search : undefined,
  bookInfo: typeof bookInfo === "function" ? bookInfo : undefined,
  toc: typeof toc === "function" ? toc : undefined,
  chapterList: typeof chapterList === "function" ? chapterList : undefined,
  content: typeof content === "function" ? content : undefined,
  chapterContent: typeof chapterContent === "function" ? chapterContent : undefined,
  explore: typeof explore === "function" ? explore : undefined
};`
    );
    return factory(buildShim());
  }
  function buildShim() {
    return {
      http: {
        get: (url, headers) => requestHttp({ url, method: "GET", headers: headers ?? {} }).then((r) => r.body),
        post: (url, body, headers) => requestHttp({
          url,
          method: "POST",
          body: body ?? null,
          headers: headers ?? {}
        }).then((r) => r.body),
        request: (request) => requestHttp(request)
      },
      /** CSS 选择器查询（主线程 DOMParser 执行；选择器非法/超限/被禁用时 reject） */
      query: (html, selector, baseUrl) => requestQuery(html, selector, baseUrl)
    };
  }
  var pendingHttp = /* @__PURE__ */ new Map();
  var pendingQueries = /* @__PURE__ */ new Map();
  function requestHttp(request) {
    return new Promise((resolve, reject) => {
      const reqId = `http-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      pendingHttp.set(reqId, { resolve, reject });
      reply({ type: "http", reqId, request });
    });
  }
  function requestQuery(html, selector, baseUrl) {
    return new Promise((resolve, reject) => {
      const reqId = `query-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      pendingQueries.set(reqId, { resolve, reject });
      reply({ type: "query", reqId, html, selector, baseUrl });
    });
  }
  function reply(msg) {
    self.postMessage(msg);
  }
  self.addEventListener("message", (e) => {
    const msg = e.data;
    try {
      if (!msg || typeof msg.type !== "string") {
        logToMain("error", "[sandbox.worker] \u2717 \u6536\u5230\u975E\u9884\u671F\u6D88\u606F:", msg);
        return;
      }
      if (msg.type === "load") {
        logToMain("info", `[sandbox.worker] \u25B6 \u6536\u5230 load \u6D88\u606F fileName=${msg.fileName} sourceLen=${msg.source.length}`);
        try {
          const mod = compileModule(msg.source);
          modules.set(msg.fileName, mod);
          const fns = Object.entries(mod).filter(([, v]) => typeof v === "function").map(([k]) => k);
          reply({ type: "loaded", fileName: msg.fileName, fns });
        } catch (err) {
          reply({
            type: "loaded",
            fileName: msg.fileName,
            fns: [],
            error: String(
              err?.message ?? err
            )
          });
        }
        return;
      }
      if (msg.type === "call") {
        const mod = modules.get(msg.fileName);
        if (!mod) {
          reply({ type: "result", reqId: msg.reqId, ok: false, error: "\u6A21\u5757\u672A\u52A0\u8F7D" });
          return;
        }
        const fn = mod[msg.fn];
        if (typeof fn !== "function") {
          reply({ type: "result", reqId: msg.reqId, ok: false, error: `\u51FD\u6570 ${msg.fn} \u672A\u5B9A\u4E49` });
          return;
        }
        Promise.resolve().then(() => fn.apply(mod, msg.args)).then(
          (value) => reply({
            type: "result",
            reqId: msg.reqId,
            ok: true,
            value: value === void 0 ? null : value
          }),
          (err) => reply({
            type: "result",
            reqId: msg.reqId,
            ok: false,
            errorName: err?.name ?? "Error",
            error: String(err?.stack ?? err?.message ?? err)
          })
        );
        return;
      }
      if (msg.type === "invalidate") {
        modules.delete(msg.fileName);
        return;
      }
      if (msg.type === "http-result") {
        const p = pendingHttp.get(msg.reqId);
        if (!p) return;
        pendingHttp.delete(msg.reqId);
        if (msg.status >= 200 && msg.status < 300) {
          p.resolve({ status: msg.status, headers: msg.headers, body: msg.body });
        } else {
          p.reject(new Error(`HTTP ${msg.status}`));
        }
        return;
      }
      if (msg.type === "query-result") {
        const p = pendingQueries.get(msg.reqId);
        if (!p) return;
        pendingQueries.delete(msg.reqId);
        if (msg.ok) {
          p.resolve(msg.items ?? []);
        } else {
          p.reject(new Error(msg.error ?? "\u9009\u62E9\u5668\u67E5\u8BE2\u5931\u8D25"));
        }
        return;
      }
    } catch (err) {
      const reqId = msg.reqId;
      if (reqId) {
        reply({
          type: "result",
          reqId,
          ok: false,
          errorName: err?.name ?? "Error",
          error: String(err?.stack ?? err?.message ?? err)
        });
      }
    }
  });
  signalReady();
})();
