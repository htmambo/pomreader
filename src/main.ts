import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// ng build --watch 重建后旧 chunk 文件被清理，file:// 模式下懒加载会报
// "Failed to fetch dynamically imported module" —— 检测到后自动刷新一次加载新产物
// （10s 时间窗防止 chunk 真缺失时无限刷新）
window.addEventListener('unhandledrejection', (event) => {
  const msg = String(event.reason?.message ?? event.reason ?? '');
  if (!msg.includes('dynamically imported module')) return;
  const last = Number(sessionStorage.getItem('chunk-stale-reload-at') ?? 0);
  if (Date.now() - last < 10_000) return;
  sessionStorage.setItem('chunk-stale-reload-at', String(Date.now()));
  window.location.reload();
});

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
