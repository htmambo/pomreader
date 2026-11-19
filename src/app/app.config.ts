import {
  type ApplicationConfig,
  provideZonelessChangeDetection,
  ErrorHandler,
  APP_INITIALIZER,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideNzI18n, zh_CN } from 'ng-zorro-antd/i18n';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzContextMenuService } from 'ng-zorro-antd/dropdown';
import { registerLocaleData } from '@angular/common';
import zh from '@angular/common/locales/zh';
import { FormsModule } from '@angular/forms';
import { importProvidersFrom } from '@angular/core';
import { routes } from './app.routes';
import { GlobalErrorHandler } from './core/services/global-error-handler';
import { BookService } from './core/services/book.service';
import { BookSourceRegistry } from './core/book-source/book-source.registry';
import { RuleEngineService } from './core/book-source/json-rule/rule-engine.service';
import { CfPromptService } from './core/services/cf-prompt.service';
import { XbiqugeAdapter } from './core/book-source/adapters/xbiquge.adapter';
import { HeuristicAdapter } from './core/book-source/adapters/heuristic.adapter';

registerLocaleData(zh);

function initBooks(books: BookService) {
  // A4 非阻塞 bootstrap：PouchDB 全表扫描（bookAll）走 IPC 往返，
  // 串行阻塞在 APP_INITIALIZER 里会让首屏多等一个 IPC 往返 + 序列化。
  // 这里只「发起」加载，不 await —— 书架页用骨架屏占位（loadState）。
  // 需要「书已就绪」的调用方用 BookService.whenLoaded()。
  return () => {
    void books.load().catch((e) => console.error('[bootstrap] 书架加载失败', e));
  };
}

function initBookSources(
  registry: BookSourceRegistry,
  ruleEngine: RuleEngineService,
  _cfPrompt: CfPromptService,
) {
  // _cfPrompt 仅用于启动时实例化：引擎在 booksourceHttpProxy 返回 cfChallenge 时
  // 直接调 prompt()（方案 §3.2 配套 a；沙箱时代的 cfChallengeHook 静态钩子已随 P4 删除）
  //
  // A4：内置适配器注册是纯内存操作（同步完成，首屏即可用）；
  // 用户 JSON 规则书源要读磁盘（booksourceListJson + 逐个 JSON 解析）——放后台，
  // 不阻塞首屏。注册完成的适配器会即时生效（registry.register 幂等覆盖）。
  return () => {
    registry.register(new XbiqugeAdapter());
    registry.register(new HeuristicAdapter()); // 通用兜底（任意 URL 可试）
    // 加载用户安装的 JSON 规则书源 —— 否则跨书源聚合搜索永远找不到用户书源。
    // 显式传入 ruleEngine（不能由 loadAllRuleAdapters 内 inject —— await 后脱离
    // Angular 注入上下文，会抛 NG0203）
    void registry.loadAllRuleAdapters(ruleEngine).catch((e) => {
      console.warn('[bootstrap] JSON 书源加载失败', e);
    });
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), withHashLocation()),
    provideHttpClient(withXhr()),
    provideAnimations(),
    provideNzI18n(zh_CN),
    importProvidersFrom(FormsModule),
    NzModalService, // ng-zorro 18 NzModalService 不自动 providedIn:'root'，需显式提供
    NzContextMenuService, // ng-zorro 18 NzContextMenuService 同样非 root provider（BookCard 右键菜单依赖）
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    {
      provide: APP_INITIALIZER,
      useFactory: initBooks,
      deps: [BookService],
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: initBookSources,
      deps: [BookSourceRegistry, RuleEngineService, CfPromptService],
      multi: true,
    },
  ],
};
