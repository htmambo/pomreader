import { Injectable, inject } from '@angular/core';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ToastService } from './toast.service';
import { SandboxService } from '../book-source/js-source/sandbox.service';

/**
 * CF Tier 2 人工过盾引导（书源链路）
 *
 * **位置**（P3.3）：原在 `book-source/js-source/`，迁到 `core/services/` ——
 * 它服务的是**两条**书源链路（JSON 规则引擎 + 旧沙箱），留在 `js-source/` 里会让
 * 新引擎反向依赖一个 P4 要整个删掉的目录。构造函数里注册沙箱钩子那行在 P4 随沙箱一起删。
 *
 * 主进程代理（pom:booksource-http-proxy）Tier 1 自动过盾失败（交互式 Turnstile）时，
 * 响应带 cfChallenge 标记 → 调用方直接调 `prompt(url)` 弹窗引导。
 *
 * 两条消费路径（书源 JSON 规则化过渡期并存，P4 删掉沙箱那条）：
 * - 旧：`SandboxService.proxyHttp` → 构造函数注册的静态 `cfChallengeHook`（`sandbox.service.ts:623` 触发）
 * - 新：`RuleEngineService` 的 HTTP 包装在收到 `cfChallenge` 时直接调本方法
 *
 * 静置场景友好设计：
 * - fire-and-forget，不阻塞抓取回执（本次请求仍以 403 失败，章节保持未加载待重试）；
 * - 每个 host 每次会话最多弹一次，避免批量更新时弹窗轰炸；
 * - 验证成功后 cf_clearance 落入共享 session（persist:fetch），后续抓取自动恢复。
 */
@Injectable({ providedIn: 'root' })
export class CfPromptService {
  private readonly modal = inject(NzModalService);
  private readonly toast = inject(ToastService);
  /** 已提示过的 host（验证成功后移除，cookie 过期时允许再次提醒） */
  private readonly promptedHosts = new Set<string>();

  constructor() {
    SandboxService.cfChallengeHook = (url) => this.prompt(url);
  }

  /**
   * 提示用户人工过盾（public：规则引擎在 HTTP 返回 `cfChallenge` 时直接调用，见方案 §3.2 配套改动 a）
   *
   * 刻意**不返回 Promise**：语义与旧钩子一致 —— fire-and-forget，不阻塞本次抓取回执。
   * 每 host 去重由内部 `promptedHosts` 负责，调用方不需要（也不该）自己再判一次。
   */
  prompt(url: string): void {
    const cfManual = window.pomAPI?.cfPassManual;
    if (!cfManual) return;
    let host: string;
    let origin: string;
    try {
      const u = new URL(url);
      host = u.host;
      origin = u.origin;
    } catch {
      return;
    }
    if (this.promptedHosts.has(host)) return;
    this.promptedHosts.add(host);
    this.modal.confirm({
      nzTitle: '需要人工验证',
      nzContent: `站点 ${host} 启用了 Cloudflare 人机验证，自动过盾未通过。是否打开验证窗口？完成后该站点的导入/章节更新将自动恢复（本次会话不再重复提醒）。`,
      nzOkText: '打开验证窗口',
      nzCancelText: '暂不',
      nzOnOk: async () => {
        try {
          // 验证窗口提取的 HTML 用于本次请求；cf_clearance 已落 session，后续自动恢复
          const html = await cfManual(origin);
          if (html) {
            this.promptedHosts.delete(host);
            this.toast.success(`${host} 验证完成`);
          } else {
            this.toast.warn('未完成验证，该站点内容暂无法抓取');
          }
        } catch {
          /* 验证窗口异常关闭等，静默 */
        }
      },
    });
  }
}
