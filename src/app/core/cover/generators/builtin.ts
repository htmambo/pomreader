/**
 * 内置封面生成器（迁移自 legado src/utils/coverGenerators/，共 20 款）
 * 与原 legado 实现差异：
 * - ShelfBook → CoverBookInput（title/author/kind 三字段；pomreader 无 kind 时各模板用自己 fallback 文案）
 * - book.name → book.title
 */
import type { BuiltinCoverGeneratorDefinition, CoverBookInput } from './types';
import {
  bookAuthor,
  bookKind,
  buildDataUrl,
  paletteFromBook,
  textSpans,
  verticalTextSpans,
  wrapText,
} from './shared';

function generateModernLiteratureCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 7, 4), { x: 74, lineHeight: 108 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <rect width="600" height="840" fill="#f2efe8" />
  <rect x="0" y="0" width="600" height="840" fill="#111827" opacity="0.035" />
  <path d="M0 528C126 482 178 544 290 506C418 462 480 360 600 392V840H0Z" fill="#d45c3f" />
  <path d="M0 648C146 584 248 676 390 596C486 542 532 516 600 526V840H0Z" fill="#263a5e" opacity="0.96" />
  <text x="74" y="168" fill="#202124" font-size="116" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="74" y="470" fill="#59606b" font-size="44">${bookKind(book, '现代文学')}</text>
  <text x="74" y="718" fill="#ffffff" font-size="62" font-weight="800">${bookAuthor(book)}</text>
  <rect x="74" y="742" width="150" height="7" rx="3.5" fill="#ffffff" opacity="0.68" />
</svg>`);
}

function generateMinimalLiteraryCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 8, 4), { x: 72, lineHeight: 108 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <rect width="600" height="840" fill="#fafafa" />
  <rect x="0" y="0" width="600" height="840" fill="#111827" opacity="0.025" />
  <rect x="72" y="100" width="12" height="420" fill="#111827" />
  <circle cx="450" cy="610" r="96" fill="#111827" opacity="0.08" />
  <circle cx="498" cy="560" r="46" fill="#b91c1c" opacity="0.84" />
  <text x="112" y="184" fill="#111827" font-size="104" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="112" y="590" fill="#52525b" font-size="46">${bookKind(book, '文学精选')}</text>
  <text x="112" y="650" fill="#111827" font-size="60" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateClassicInkCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 6, 4), { x: 300, lineHeight: 96 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <radialGradient id="paper" cx="50%" cy="28%" r="78%">
      <stop offset="0%" stop-color="#fbf6e9" />
      <stop offset="100%" stop-color="#d9c5a4" />
    </radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="22" /></filter>
  </defs>
  <rect width="600" height="840" fill="url(#paper)" />
  <path d="M-80 526C120 404 202 540 342 444C438 378 492 250 680 238V840H-80Z" fill="#20231f" opacity="0.14" filter="url(#blur)" />
  <path d="M0 620C130 542 220 610 334 538C432 476 514 366 600 388V840H0Z" fill="#1d211c" opacity="0.28" />
  <circle cx="455" cy="160" r="76" fill="#b94235" opacity="0.88" />
  <text x="300" y="278" text-anchor="middle" fill="#241b13" font-size="100" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="300" y="560" text-anchor="middle" fill="#5e4933" font-size="52" font-weight="700">${bookAuthor(book)}</text>
  <text x="300" y="604" text-anchor="middle" fill="#7b6144" font-size="42">${bookKind(book, '古典文学')}</text>
  <path d="M234 644H366" stroke="#b94235" stroke-width="7" stroke-linecap="round" />
</svg>`);
}

function generateTraditionalBindingCover(book: CoverBookInput): string {
  const title = verticalTextSpans(wrapText(book.title, 4, 3), {
    x: 390,
    y: 210,
    columnGap: 136,
    charGap: 108,
  });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <pattern id="thread" width="36" height="36" patternUnits="userSpaceOnUse">
      <path d="M0 18H36M18 0V36" stroke="#8b1e1e" stroke-opacity="0.08" />
    </pattern>
  </defs>
  <rect width="600" height="840" fill="#efe3c4" />
  <rect width="600" height="840" fill="url(#thread)" />
  <rect x="0" y="0" width="88" height="840" fill="#254b3f" />
  <circle cx="44" cy="150" r="10" fill="#e7d8b0" />
  <circle cx="44" cy="256" r="10" fill="#e7d8b0" />
  <circle cx="44" cy="362" r="10" fill="#e7d8b0" />
  <path d="M88 0V840" stroke="#1d372f" stroke-width="12" />
  <text fill="#25190e" font-size="96" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="300" y="642" text-anchor="middle" fill="#7f2b1d" font-size="56" font-weight="800">${bookAuthor(book)}</text>
  <text x="300" y="692" text-anchor="middle" fill="#765f42" font-size="44">${bookKind(book, '线装古籍')}</text>
</svg>`);
}

function generatePaperTextureCover(book: CoverBookInput): string {
  const palette = paletteFromBook(book);
  const title = textSpans(wrapText(book.title, 7, 4), { x: 300, lineHeight: 100 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <pattern id="grain" width="44" height="44" patternUnits="userSpaceOnUse">
      <circle cx="9" cy="11" r="1.4" fill="rgba(75,48,21,0.08)" />
      <circle cx="31" cy="22" r="1.1" fill="rgba(75,48,21,0.08)" />
      <circle cx="20" cy="34" r="0.9" fill="rgba(75,48,21,0.06)" />
    </pattern>
    <linearGradient id="wash" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fff7e8" />
      <stop offset="100%" stop-color="#ead7b7" />
    </linearGradient>
  </defs>
  <rect width="600" height="840" fill="url(#wash)" />
  <rect width="600" height="840" fill="url(#grain)" />
  <path d="M72 188C148 132 220 146 292 196C378 256 454 248 548 174V840H72Z" fill="#ffffff" opacity="0.28" />
  <path d="M0 690C150 604 314 722 600 608V840H0Z" fill="${palette.accent}" opacity="0.7" />
  <text x="300" y="286" text-anchor="middle" fill="${palette.deep}" font-size="104" font-weight="900" font-family="'Noto Serif SC', 'Source Han Serif SC', serif">
    ${title}
  </text>
  <text x="300" y="560" text-anchor="middle" fill="rgba(42,28,15,0.86)" font-size="56" font-weight="700">${bookAuthor(book)}</text>
  <text x="300" y="606" text-anchor="middle" fill="rgba(42,28,15,0.64)" font-size="44">${bookKind(book, '纸纹文艺')}</text>
  <rect x="190" y="650" width="220" height="10" rx="5" fill="${palette.primary}" opacity="0.76" />
</svg>`);
}

function generateWebNovelMaleCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 6, 4), { x: 60, lineHeight: 120 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#06111f" />
      <stop offset="50%" stop-color="#123d63" />
      <stop offset="100%" stop-color="#f97316" />
    </linearGradient>
  </defs>
  <rect width="600" height="840" fill="url(#bg)" />
  <path d="M-40 640L224 120L338 524L474 252L650 840H-40Z" fill="#020617" opacity="0.45" />
  <path d="M50 602L560 388" stroke="#facc15" stroke-width="16" stroke-linecap="round" opacity="0.86" />
  <path d="M82 640L504 462" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.62" />
  <text x="60" y="250" fill="#ffffff" font-size="116" font-weight="900" font-family="'Noto Sans SC','Source Han Sans SC',sans-serif">${title}</text>
  <text x="60" y="640" fill="#fde68a" font-size="48" font-weight="800">${bookKind(book, '热血网文')}</text>
  <text x="60" y="694" fill="#ffffff" font-size="60" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateFemaleRomanceCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 7, 4), { x: 300, lineHeight: 104 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff1f7" />
      <stop offset="100%" stop-color="#f9a8d4" />
    </linearGradient>
  </defs>
  <rect width="600" height="840" fill="url(#bg)" />
  <circle cx="110" cy="158" r="132" fill="#ffffff" opacity="0.56" />
  <circle cx="482" cy="628" r="240" fill="#be185d" opacity="0.14" />
  <path d="M0 628C122 552 222 642 344 548C456 462 514 448 600 492V840H0Z" fill="#ffffff" opacity="0.48" />
  <text x="300" y="274" text-anchor="middle" fill="#831843" font-size="108" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="300" y="548" text-anchor="middle" fill="#9d174d" font-size="48" font-weight="800">${bookKind(book, '女性文学')}</text>
  <text x="300" y="608" text-anchor="middle" fill="#831843" font-size="60" font-weight="900">${bookAuthor(book)}</text>
  <path d="M236 650C268 676 330 676 364 650" stroke="#be185d" stroke-width="7" stroke-linecap="round" fill="none" opacity="0.6" />
</svg>`);
}

function generateWuxiaCover(book: CoverBookInput): string {
  const title = verticalTextSpans(wrapText(book.title, 4, 3), {
    x: 430,
    y: 168,
    columnGap: 152,
    charGap: 120,
  });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#111827" />
      <stop offset="100%" stop-color="#6b1d1d" />
    </linearGradient>
  </defs>
  <rect width="600" height="840" fill="url(#bg)" />
  <circle cx="112" cy="130" r="86" fill="#fef3c7" opacity="0.86" />
  <path d="M-40 680C106 548 190 638 310 528C420 428 502 358 640 392V840H-40Z" fill="#020617" opacity="0.5" />
  <path d="M98 620L528 268" stroke="#fef3c7" stroke-width="10" stroke-linecap="round" opacity="0.76" />
  <path d="M120 648L550 296" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity="0.54" />
  <text fill="#fff7ed" font-size="112" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="74" y="674" fill="#fed7aa" font-size="48" font-weight="800">${bookKind(book, '武侠江湖')}</text>
  <text x="74" y="724" fill="#ffffff" font-size="60" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateFantasyEpicCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 6, 4), { x: 300, lineHeight: 116 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <radialGradient id="glow" cx="50%" cy="35%" r="70%">
      <stop offset="0%" stop-color="#fef3c7" />
      <stop offset="42%" stop-color="#7c3aed" />
      <stop offset="100%" stop-color="#111827" />
    </radialGradient>
  </defs>
  <rect width="600" height="840" fill="url(#glow)" />
  <path d="M300 120L516 720H84Z" fill="#020617" opacity="0.38" />
  <path d="M300 170L426 668H174Z" fill="#f59e0b" opacity="0.42" />
  <circle cx="300" cy="342" r="108" fill="#ffffff" opacity="0.16" />
  <text x="300" y="282" text-anchor="middle" fill="#ffffff" font-size="112" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="300" y="604" text-anchor="middle" fill="#fde68a" font-size="48" font-weight="800">${bookKind(book, '史诗幻想')}</text>
  <text x="300" y="660" text-anchor="middle" fill="#ffffff" font-size="60" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateHistoricalCourtCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 6, 4), { x: 300, lineHeight: 108 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <rect width="600" height="840" fill="#7f1d1d" />
  <circle cx="300" cy="222" r="154" fill="#fbbf24" opacity="0.78" />
  <circle cx="300" cy="222" r="116" fill="#991b1b" opacity="0.3" />
  <path d="M0 496C120 442 214 510 318 456C414 404 486 344 600 372V840H0Z" fill="#2f140f" opacity="0.64" />
  <path d="M80 676H520" stroke="#fbbf24" stroke-width="9" stroke-linecap="round" opacity="0.72" />
  <text x="300" y="284" text-anchor="middle" fill="#fff7ed" font-size="108" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="300" y="586" text-anchor="middle" fill="#fde68a" font-size="48" font-weight="800">${bookKind(book, '历史宫廷')}</text>
  <text x="300" y="636" text-anchor="middle" fill="#ffffff" font-size="60" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateSciFiCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 7, 4), { x: 64, lineHeight: 112 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <radialGradient id="star" cx="72%" cy="20%" r="64%">
      <stop offset="0%" stop-color="#67e8f9" />
      <stop offset="42%" stop-color="#1e3a8a" />
      <stop offset="100%" stop-color="#020617" />
    </radialGradient>
  </defs>
  <rect width="600" height="840" fill="url(#star)" />
  <circle cx="438" cy="180" r="92" fill="#e0f2fe" opacity="0.92" />
  <circle cx="438" cy="180" r="126" fill="none" stroke="#67e8f9" stroke-width="3" opacity="0.5" />
  <path d="M-20 702L620 372V840H-20Z" fill="#020617" opacity="0.72" />
  <path d="M64 620H536M112 560H488M168 500H432" stroke="#22d3ee" stroke-width="2" opacity="0.45" />
  <text x="64" y="258" fill="#f8fafc" font-size="112" font-weight="900" font-family="'Noto Sans SC','Source Han Sans SC',sans-serif">${title}</text>
  <text x="64" y="596" fill="#67e8f9" font-size="48" font-weight="800">${bookKind(book, '科幻未来')}</text>
  <text x="64" y="656" fill="#ffffff" font-size="60" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateSuspenseNoirCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 6, 4), { x: 64, lineHeight: 116 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <rect width="600" height="840" fill="#09090b" />
  <path d="M0 0H600V840H0Z" fill="#1f2937" opacity="0.34" />
  <path d="M360 0L600 0L430 840H190Z" fill="#f8fafc" opacity="0.08" />
  <path d="M72 622C144 586 224 610 298 570C392 520 452 438 560 462" stroke="#dc2626" stroke-width="8" stroke-linecap="round" fill="none" />
  <text x="64" y="268" fill="#f8fafc" font-size="116" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="64" y="560" fill="#fca5a5" font-size="48" font-weight="800">${bookKind(book, '悬疑推理')}</text>
  <text x="64" y="704" fill="#ffffff" font-size="60" font-weight="900">${bookAuthor(book)}</text>
  <rect x="64" y="724" width="160" height="5" fill="#dc2626" />
</svg>`);
}

function generateHorrorGothicCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 6, 4), { x: 300, lineHeight: 112 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <radialGradient id="fog" cx="50%" cy="24%" r="74%">
      <stop offset="0%" stop-color="#6b7280" />
      <stop offset="48%" stop-color="#18181b" />
      <stop offset="100%" stop-color="#030712" />
    </radialGradient>
  </defs>
  <rect width="600" height="840" fill="url(#fog)" />
  <path d="M0 690C120 596 206 720 322 610C418 520 506 456 600 504V840H0Z" fill="#000000" opacity="0.62" />
  <path d="M300 130C260 230 248 330 300 430C352 330 340 230 300 130Z" fill="#991b1b" opacity="0.72" />
  <text x="300" y="304" text-anchor="middle" fill="#f9fafb" font-size="108" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="300" y="586" text-anchor="middle" fill="#fca5a5" font-size="48" font-weight="800">${bookKind(book, '暗黑惊悚')}</text>
  <text x="300" y="642" text-anchor="middle" fill="#ffffff" font-size="60" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateYouthCampusCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 7, 4), { x: 72, lineHeight: 104 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <rect width="600" height="840" fill="#dbeafe" />
  <circle cx="490" cy="130" r="96" fill="#fef3c7" />
  <path d="M0 584C130 530 220 590 336 534C448 480 512 450 600 486V840H0Z" fill="#bfdbfe" />
  <path d="M0 674C146 604 262 704 408 622C500 570 550 558 600 574V840H0Z" fill="#60a5fa" />
  <path d="M82 172H332" stroke="#2563eb" stroke-width="8" stroke-linecap="round" />
  <text x="72" y="256" fill="#1e3a8a" font-size="108" font-weight="900" font-family="'Noto Sans SC','Source Han Sans SC',sans-serif">${title}</text>
  <text x="72" y="542" fill="#1d4ed8" font-size="48" font-weight="800">${bookKind(book, '青春校园')}</text>
  <text x="72" y="698" fill="#ffffff" font-size="60" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateChildrenStoryCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 6, 4), { x: 300, lineHeight: 108 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <rect width="600" height="840" fill="#93c5fd" />
  <circle cx="112" cy="112" r="78" fill="#fde047" />
  <path d="M0 646C120 590 206 642 308 604C418 562 486 504 600 548V840H0Z" fill="#86efac" />
  <path d="M0 712C150 658 270 736 414 672C498 636 552 626 600 644V840H0Z" fill="#22c55e" opacity="0.82" />
  <circle cx="448" cy="248" r="90" fill="#fef3c7" />
  <circle cx="422" cy="226" r="14" fill="#1f2937" />
  <circle cx="476" cy="226" r="14" fill="#1f2937" />
  <path d="M420 276C448 304 486 300 504 274" stroke="#1f2937" stroke-width="9" stroke-linecap="round" fill="none" />
  <text x="300" y="328" text-anchor="middle" fill="#1f2937" font-size="104" font-weight="900" font-family="'Noto Sans SC','Source Han Sans SC',sans-serif">${title}</text>
  <text x="300" y="562" text-anchor="middle" fill="#14532d" font-size="48" font-weight="800">${bookKind(book, '儿童故事')}</text>
  <text x="300" y="612" text-anchor="middle" fill="#1f2937" font-size="56" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateBusinessWorkplaceCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 8, 4), { x: 64, lineHeight: 108 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <rect width="600" height="840" fill="#f8fafc" />
  <rect x="0" y="0" width="600" height="300" fill="#0f172a" />
  <path d="M0 300L600 188V420L0 520Z" fill="#2563eb" />
  <path d="M0 536L600 408V840H0Z" fill="#e2e8f0" />
  <text x="64" y="160" fill="#ffffff" font-size="108" font-weight="900" font-family="'Noto Sans SC','Source Han Sans SC',sans-serif">${title}</text>
  <text x="64" y="604" fill="#1e3a8a" font-size="48" font-weight="800">${bookKind(book, '职场商业')}</text>
  <text x="64" y="662" fill="#0f172a" font-size="62" font-weight="900">${bookAuthor(book)}</text>
  <rect x="64" y="696" width="280" height="10" rx="5" fill="#2563eb" />
</svg>`);
}

function generateHealingPastelCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 7, 4), { x: 300, lineHeight: 104 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <rect width="600" height="840" fill="#ecfccb" />
  <circle cx="150" cy="190" r="146" fill="#bfdbfe" opacity="0.78" />
  <circle cx="462" cy="238" r="120" fill="#fecdd3" opacity="0.72" />
  <circle cx="320" cy="612" r="220" fill="#fde68a" opacity="0.58" />
  <path d="M82 584C170 520 252 632 342 560C416 502 476 498 538 546" stroke="#65a30d" stroke-width="8" stroke-linecap="round" fill="none" opacity="0.58" />
  <text x="300" y="312" text-anchor="middle" fill="#365314" font-size="104" font-weight="900" font-family="'Noto Serif SC','Source Han Serif SC',serif">${title}</text>
  <text x="300" y="566" text-anchor="middle" fill="#4d7c0f" font-size="48" font-weight="800">${bookKind(book, '治愈日常')}</text>
  <text x="300" y="624" text-anchor="middle" fill="#365314" font-size="60" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateComicVividCover(book: CoverBookInput): string {
  const title = textSpans(wrapText(book.title, 5, 4), { x: 66, lineHeight: 124 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <rect width="600" height="840" fill="#fde047" />
  <path d="M0 0H600V260H0Z" fill="#ef4444" />
  <path d="M0 260L600 112V358L0 512Z" fill="#2563eb" />
  <circle cx="456" cy="572" r="150" fill="#22c55e" />
  <path d="M424 458L530 570L404 684L298 552Z" fill="#ffffff" opacity="0.9" />
  <text x="66" y="196" fill="#ffffff" font-size="120" font-weight="900" font-family="'Noto Sans SC','Source Han Sans SC',sans-serif">${title}</text>
  <text x="66" y="628" fill="#111827" font-size="48" font-weight="900">${bookKind(book, '漫画轻快')}</text>
  <text x="66" y="690" fill="#111827" font-size="62" font-weight="900">${bookAuthor(book)}</text>
</svg>`);
}

function generateTitleBlockCover(book: CoverBookInput): string {
  const palette = paletteFromBook(book);
  const title = textSpans(wrapText(book.title, 7, 4), { x: 72, lineHeight: 116 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.deep}" />
      <stop offset="58%" stop-color="${palette.primary}" />
      <stop offset="100%" stop-color="${palette.secondary}" />
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.32" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
  </defs>
  <rect width="600" height="840" fill="url(#bg)" />
  <path d="M-80 166C116 86 210 122 360 30C492-50 596-16 704-70V292C532 350 422 294 282 358C150 420 34 468-80 430Z" fill="url(#shine)" />
  <circle cx="492" cy="638" r="220" fill="#000000" opacity="0.12" />
  <circle cx="536" cy="122" r="118" fill="#ffffff" opacity="0.12" />
  <text x="72" y="98" fill="#ffffff" opacity="0.66" font-size="38" font-weight="700" letter-spacing="5">POMREADER ORIGINAL</text>
  <text x="72" y="276" fill="#ffffff" font-size="116" font-weight="900" font-family="'Noto Sans SC', 'Source Han Sans SC', sans-serif">
    ${title}
  </text>
  <rect x="72" y="628" width="168" height="8" rx="4" fill="#ffffff" opacity="0.72" />
  <text x="72" y="690" fill="#ffffff" font-size="56" font-weight="800">${bookAuthor(book)}</text>
  <text x="72" y="734" fill="#ffffff" opacity="0.72" font-size="44">${bookKind(book, '现代封面')}</text>
</svg>`);
}

function generateAuthorBandCover(book: CoverBookInput): string {
  const palette = paletteFromBook(book);
  const title = textSpans(wrapText(book.title, 8, 3), { x: 70, lineHeight: 108 });
  return buildDataUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${palette.light}" />
      <stop offset="100%" stop-color="#ffffff" />
    </linearGradient>
  </defs>
  <rect width="600" height="840" fill="url(#bg)" />
  <rect x="0" y="0" width="600" height="240" fill="${palette.deep}" />
  <path d="M0 232C118 282 220 284 344 236C452 194 534 194 600 226V0H0Z" fill="${palette.primary}" opacity="0.9" />
  <circle cx="90" cy="692" r="260" fill="${palette.secondary}" opacity="0.16" />
  <text x="70" y="366" fill="${palette.deep}" font-size="120" font-weight="900" font-family="'Noto Sans SC', 'Source Han Sans SC', sans-serif">
    ${title}
  </text>
  <rect x="70" y="560" width="340" height="96" rx="22" fill="${palette.primary}" />
  <text x="94" y="604" fill="#ffffff" font-size="36" font-weight="800" letter-spacing="4">AUTHOR</text>
  <text x="94" y="638" fill="#ffffff" font-size="64" font-weight="900">${bookAuthor(book)}</text>
  <text x="70" y="148" fill="#ffffff" font-size="48" opacity="0.86">${bookKind(book, '作者签名')}</text>
  <path d="M70 452H356" stroke="${palette.secondary}" stroke-width="7" stroke-linecap="round" />
</svg>`);
}

/** 内置 20 款封面生成器（顺序即 UI 渲染顺序） */
export const BUILTIN_COVER_GENERATORS: BuiltinCoverGeneratorDefinition[] = [
  { id: 'builtin:modern-literature', name: '现代文学', description: '留白、抽象色块和稳重字体，适合现实、文学、散文。', generate: generateModernLiteratureCover },
  { id: 'builtin:minimal-literary', name: '极简文学', description: '克制留白和小面积强调色，适合严肃文学、短篇、散文。', generate: generateMinimalLiteraryCover },
  { id: 'builtin:classic-ink', name: '古典水墨', description: '宣纸、远山与朱印，适合古典文学、诗词、传统题材。', generate: generateClassicInkCover },
  { id: 'builtin:traditional-binding', name: '线装古籍', description: '仿线装书视觉，适合传统文化、历史典籍和古籍风格。', generate: generateTraditionalBindingCover },
  { id: 'builtin:paper-texture', name: '纸纹文艺版', description: '带纸纹与浅色底卡，适合简介型或文学类封面。', generate: generatePaperTextureCover },
  { id: 'builtin:webnovel-male', name: '男频热血', description: '高对比、强动势、金色光线，适合玄幻、都市、升级流。', generate: generateWebNovelMaleCover },
  { id: 'builtin:female-romance', name: '女频柔光', description: '粉白渐变、柔和曲线，适合言情、成长、女性向作品。', generate: generateFemaleRomanceCover },
  { id: 'builtin:wuxia', name: '武侠江湖', description: '月色、山影与刀光，适合武侠、仙侠、江湖题材。', generate: generateWuxiaCover },
  { id: 'builtin:fantasy-epic', name: '史诗幻想', description: '神秘光晕和金色金字塔构图，适合奇幻、神话、史诗冒险。', generate: generateFantasyEpicCover },
  { id: 'builtin:historical-court', name: '历史宫廷', description: '朱红与鎏金，适合历史、宫廷、权谋和古代言情。', generate: generateHistoricalCourtCover },
  { id: 'builtin:sci-fi', name: '科幻星环', description: '深空、星环与冷色霓光，适合科幻、末世、未来题材。', generate: generateSciFiCover },
  { id: 'builtin:suspense-noir', name: '悬疑黑幕', description: '黑白红高反差，适合悬疑、推理、惊悚、犯罪题材。', generate: generateSuspenseNoirCover },
  { id: 'builtin:horror-gothic', name: '暗黑惊悚', description: '暗色雾面和红色中心视觉，适合恐怖、灵异、黑暗幻想。', generate: generateHorrorGothicCover },
  { id: 'builtin:youth-campus', name: '青春校园', description: '清爽蓝白和阳光曲线，适合校园、青春、成长题材。', generate: generateYouthCampusCover },
  { id: 'builtin:children-story', name: '儿童童趣', description: '明亮色块和童趣图形，适合儿童读物、童话、启蒙故事。', generate: generateChildrenStoryCover },
  { id: 'builtin:business-workplace', name: '职场商业', description: '理性几何和商务蓝，适合职场、商业、管理、现实都市。', generate: generateBusinessWorkplaceCover },
  { id: 'builtin:healing-pastel', name: '治愈日常', description: '柔和彩色圆形与自然线条，适合治愈、日常、轻文学。', generate: generateHealingPastelCover },
  { id: 'builtin:comic-vivid', name: '漫画活力', description: '强烈原色与漫画动势，适合轻小说、漫画风、幽默故事。', generate: generateComicVividCover },
  { id: 'builtin:title-block', name: '标题块封面', description: '大字标题 + 渐变主题色，适合没有封面的纯文字书籍。', generate: generateTitleBlockCover },
  { id: 'builtin:author-band', name: '作者签名版', description: '突出书名与作者信息，适合补封面时保留基本元信息。', generate: generateAuthorBandCover },
];
