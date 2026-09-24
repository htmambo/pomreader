import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'bookshelf' },
  {
    path: 'bookshelf',
    loadComponent: () =>
      import('./pages/bookshelf/bookshelf.component').then((m) => m.BookshelfComponent),
  },
  {
    path: 'search',
    loadComponent: () =>
      import('./pages/universal-search/universal-search.component').then(
        (m) => m.UniversalSearchComponent
      ),
  },
  {
    path: 'disclaimer',
    loadComponent: () =>
      import('./pages/disclaimer/disclaimer.component').then(
        (m) => m.DisclaimerComponent
      ),
  },
  {
    path: 'reader/:bookId/:chapterId',
    loadComponent: () =>
      import('./pages/reader/reader.component').then((m) => m.ReaderComponent),
  },
  { path: '**', redirectTo: 'bookshelf' },
];