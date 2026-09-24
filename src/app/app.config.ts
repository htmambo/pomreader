import { ApplicationConfig, provideZoneChangeDetection, ErrorHandler, APP_INITIALIZER, inject } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideNzI18n, zh_CN } from 'ng-zorro-antd/i18n';
import { registerLocaleData } from '@angular/common';
import zh from '@angular/common/locales/zh';
import { FormsModule } from '@angular/forms';
import { importProvidersFrom } from '@angular/core';
import { routes } from './app.routes';
import { GlobalErrorHandler } from './core/services/global-error-handler';
import { ThemeService } from './core/services/theme.service';
import { BookService } from './core/services/book.service';

registerLocaleData(zh);

function initTheme(theme: ThemeService) {
  return () => {
    theme.applyToHtml();
  };
}

function initBooks(books: BookService) {
  return () => books.load();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(),
    provideAnimations(),
    provideNzI18n(zh_CN),
    importProvidersFrom(FormsModule),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    {
      provide: APP_INITIALIZER,
      useFactory: initTheme,
      deps: [ThemeService],
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: initBooks,
      deps: [BookService],
      multi: true,
    },
  ],
};