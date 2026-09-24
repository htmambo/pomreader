import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzGridModule } from 'ng-zorro-antd/grid';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { BookService } from '../../core/services/book.service';
import { BookCardComponent } from '../../shared/components/book-card/book-card.component';

@Component({
  selector: 'app-bookshelf',
  standalone: true,
  imports: [CommonModule, NzGridModule, NzEmptyModule, BookCardComponent],
  template: `
    <h2>书架</h2>
    @if (books().length > 0) {
      <div nz-row [nzGutter]="[16, 16]">
        @for (book of books(); track book.id) {
          <div nz-col nzXs="12" nzSm="8" nzMd="6" nzLg="4" nzXl="3">
            <app-book-card [book]="book"></app-book-card>
          </div>
        }
      </div>
    } @else {
      <nz-empty nzNotFoundContent="书架暂无书籍"></nz-empty>
    }
  `,
})
export class BookshelfComponent implements OnInit {
  private readonly bookService = inject(BookService);
  readonly books = this.bookService.books;

  ngOnInit(): void {
    if (this.books().length === 0) {
      this.bookService.load();
    }
  }
}