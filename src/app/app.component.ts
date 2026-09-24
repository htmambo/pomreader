import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NzLayoutModule } from 'ng-zorro-antd/layout';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule, NZ_ICONS, provideNzIconsPatch } from 'ng-zorro-antd/icon';
import {
  BookOutline, SearchOutline, FileTextOutline, MoonOutline, SunOutline,
  ArrowLeftOutline, MenuOutline, SettingOutline, CloseOutline,
} from '@ant-design/icons-angular/icons';
import { ThemeService } from './core/services/theme.service';
import { PageHeaderComponent } from './shared/components/page-header/page-header.component';
import { SidebarComponent } from './shared/components/sidebar/sidebar.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    NzLayoutModule,
    NzMenuModule,
    NzButtonModule,
    NzIconModule,
    PageHeaderComponent,
    SidebarComponent,
  ],
  providers: [
    provideNzIconsPatch([
      BookOutline, SearchOutline, FileTextOutline, MoonOutline, SunOutline,
      ArrowLeftOutline, MenuOutline, SettingOutline, CloseOutline,
    ]),
  ],
  template: `
    <nz-layout class="app-layout">
      <nz-sider nzWidth="200px">
        <app-sidebar></app-sidebar>
      </nz-sider>
      <nz-layout>
        <nz-header>
          <app-page-header></app-page-header>
        </nz-header>
        <nz-content>
          <router-outlet></router-outlet>
        </nz-content>
      </nz-layout>
    </nz-layout>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100vh;
      }
      .app-layout {
        height: 100vh;
      }
      nz-sider {
        background: var(--pom-fg);
      }
      nz-header {
        padding: 0 16px;
        line-height: 64px;
      }
      nz-content {
        padding: 16px;
        overflow: auto;
      }
    `,
  ],
})
export class AppComponent implements OnInit {
  private readonly theme = inject(ThemeService);

  ngOnInit(): void {
    this.theme.applyToHtml();
  }
}