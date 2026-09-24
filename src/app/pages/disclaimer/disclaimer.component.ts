import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzTypographyModule } from 'ng-zorro-antd/typography';

@Component({
  selector: 'app-disclaimer',
  standalone: true,
  imports: [CommonModule, NzTypographyModule],
  template: `
    <div class="disclaimer">
      <h2 nz-typography>免责声明</h2>
      <p nz-typography>
        本应用（pomreader-ui-clone）是一个仿写练习项目，
        仅用于学习和研究 Angular 18 standalone + signals + ng-zorro-antd 技术栈。
      </p>
      <h3 nz-typography>数据来源</h3>
      <p nz-typography>
        所有书籍元数据与章节内容均为 mock 数据，
        来源于公共领域古典名篇（《古文观止》《世说新语》《水浒传》《三国演义》片段）拼接。
      </p>
      <h3 nz-typography>不存储用户数据</h3>
      <p nz-typography>
        本应用使用浏览器 localStorage 仅存储主题偏好与阅读进度，
        不上传任何用户阅读历史或个人信息。
      </p>
      <h3 nz-typography>非商业用途</h3>
      <p nz-typography>
        本项目不进行任何形式的商业活动。如有版权问题请联系作者删除。
      </p>
      <p nz-typography nzType="secondary" style="margin-top: 32px;">
        — pomreader-ui-clone v1.0.6 · 2026-09-24
      </p>
    </div>
  `,
  styles: [
    `
      .disclaimer {
        max-width: 720px;
        margin: 24px auto;
        padding: 24px;
        background: var(--pom-card);
        border: 1px solid var(--pom-border);
        border-radius: 8px;
      }
      h2,
      h3 {
        color: var(--pom-text-muted);
      }
      p {
        color: var(--pom-text);
        line-height: 1.7;
      }
    `,
  ],
})
export class DisclaimerComponent {}
