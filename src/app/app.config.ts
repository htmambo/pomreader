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
import { BookSourceMigrateService } from './core/services/book-source-migrate.service';
import { BookSourceRegistry } from './core/book-source/book-source.registry';
import { SandboxService } from './core/book-source/js-source/sandbox.service';
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
  _cfPrompt: CfPromptService,
  migrate: BookSourceMigrateService,
) {
  // _cfPrompt 仅用于启动时实例化：旧链路靠构造函数向 SandboxService 注册 cfChallengeHook；
  // 规则引擎链路（RuleEngineService）在 HTTP 返回 cfChallenge 时直接调 `CfPromptService.prompt`。
  // 两条并存到 P4（沙箱删除时钩子一并消失，彼时只剩引擎这条）。
  return async () => {
    // ⚠️ 迁移与规则源装载必须**在本函数内串行 await**，不能另挂 APP_INITIALIZER：
    // Angular 的 `runInitializers` 是 `Promise.all`（同步按序调用、并发 await），
    // 单独一个 initializer 与下面的 `loadAllJsAdapters` 之间**没有执行顺序保证** ——
    // 那样 registry 可能装上迁移前的源，症状是"首启搜不到某些书源、重启就好"。
    // 失败只告警不阻断启动：迁移失败 = 旧 `.js` 原样继续可用。
    await migrate.migrate();
    registry.register(new XbiqugeAdapter());
    registry.register(new HeuristicAdapter()); // 通用兜底（任意 URL 可试）
    // 迁移**之后**装载 JSON 规则源：`loadAllJsAdapters` 见到同 uuid 的 `.json` 已在册
    // 时会跳过同 uuid 的 JS 适配器（方案 §3.3 的优先级 JSON > JS > 内置）。
    // 顺序反了的话这里什么也装不上 —— 迁移产出的 `.json` 没人读，症状是
    // "迁移报告说成功了，但搜不到那个书源"。
    await registry.loadAllRuleAdapters();
    // 加载用户安装的 JS 书源（legado 风格）—— 否则跨书源聚合搜索永远找不到 JS 书源。
    // 显式传入 sandbox（不能由 loadAllJsAdapters 内 inject —— APP_INITIALIZER 的 async
    // 函数 await 后脱离 Angular 注入上下文，会抛 NG0203）
    await registry.loadAllJsAdapters(sandbox);
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
      deps: [BookSourceRegistry, SandboxService, CfPromptService, BookSourceMigrateService],
      multi: true,
    },
  ],
};
