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
import { SandboxService } from './core/book-source/js-source/sandbox.service';
import { RuleEngineService } from './core/book-source/json-rule/rule-engine.service';
import { CfPromptService } from './core/services/cf-prompt.service';
import { XbiqugeAdapter } from './core/book-source/adapters/xbiquge.adapter';
import { HeuristicAdapter } from './core/book-source/adapters/heuristic.adapter';

registerLocaleData(zh);

function initBooks(books: BookService) {
  return () => books.load();
}

function initBookSources(
  registry: BookSourceRegistry,
  sandbox: SandboxService,
  ruleEngine: RuleEngineService,
  _cfPrompt: CfPromptService,
) {
  // _cfPrompt 仅用于启动时实例化：
  //  - JS 沙箱链路：构造函数向 SandboxService 注册 cfChallengeHook（P4 删沙箱时消亡）
  //  - JSON 规则链路：引擎在 booksourceHttpProxy 返回 cfChallenge 时直接调 prompt()
  //  （过渡期两条链路共存，方案 §3.2 配套 a/b）
  return async () => {
    registry.register(new XbiqugeAdapter());
    registry.register(new HeuristicAdapter()); // 通用兜底（任意 URL 可试）
    // 加载用户安装的 JS 书源（legado 风格）—— 否则跨书源聚合搜索永远找不到 JS 书源。
    // 显式传入 sandbox（不能由 loadAllJsAdapters 内 inject —— APP_INITIALIZER 的 async
    // 函数 await 后脱离 Angular 注入上下文，会抛 NG0203）
    await registry.loadAllJsAdapters(sandbox);
    // JSON 规则书源（方案 §3.3）：与 JS 链路并列，各自受运行时开关门控（内部已早返回）
    await registry.loadAllRuleAdapters(ruleEngine);
    return registry.supportedSources();
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
      deps: [BookSourceRegistry, SandboxService, RuleEngineService, CfPromptService],
      multi: true,
    },
  ],
};
