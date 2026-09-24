import { ApplicationConfig, provideZoneChangeDetection, ErrorHandler, APP_INITIALIZER, inject } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideNzI18n, zh_CN } from 'ng-zorro-antd/i18n';
import { NzModalService } from 'ng-zorro-antd/modal';
import { registerLocaleData } from '@angular/common';
import zh from '@angular/common/locales/zh';
import { FormsModule } from '@angular/forms';
import { importProvidersFrom } from '@angular/core';
import { routes } from './app.routes';
import { GlobalErrorHandler } from './core/services/global-error-handler';
import { BookService } from './core/services/book.service';
import { BookSourceRegistry } from './core/book-source/book-source.registry';
import { XbiqugeAdapter } from './core/book-source/adapters/xbiquge.adapter';
import { Dushu369Adapter } from './core/book-source/adapters/dushu369.adapter';
import { Guoxue123Adapter } from './core/book-source/adapters/guoxue123.adapter';
import { Readers365Adapter } from './core/book-source/adapters/readers365.adapter';
import { KehuanAdapter } from './core/book-source/adapters/kehuan.adapter';
import { HeuristicAdapter } from './core/book-source/adapters/heuristic.adapter';

registerLocaleData(zh);

function initBooks(books: BookService) {
  return () => books.load();
}

function initBookSources(registry: BookSourceRegistry) {
  return () => {
    registry.register(new XbiqugeAdapter());
    registry.register(new Dushu369Adapter());
    registry.register(new Guoxue123Adapter());
    registry.register(new Readers365Adapter());
    registry.register(new KehuanAdapter());
    registry.register(new HeuristicAdapter()); // 通用兜底（任意 URL 可试）
    return registry.supportedSources();
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding(), withHashLocation()),
    provideHttpClient(),
    provideAnimations(),
    provideNzI18n(zh_CN),
    importProvidersFrom(FormsModule),
    NzModalService, // ng-zorro 18 NzModalService 不自动 providedIn:'root'，需显式提供
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
      deps: [BookSourceRegistry],
      multi: true,
    },
  ],
};