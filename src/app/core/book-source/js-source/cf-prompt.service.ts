import { Injectable, inject } from '@angular/core';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ToastService } from '../../services/toast.service';
import { SandboxService } from './sandbox.service';

/**
 * CF Tier 2 人工过盾引导（书源沙箱链路）
 *
 * 主进程代理（pom:booksource-http-proxy）Tier 1 自动过盾失败（交互式 Turnstile）时，
 * 响应带 cfChallenge 标记 → SandboxService.cfChallengeHook → 本服务弹窗引导。
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

  private prompt(url: string): void {
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
