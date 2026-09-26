import { describe, it, expect, afterEach } from 'vitest';
import {
  stripTags,
  absUrl,
  pickText,
  pickHtml,
  matchLinkItems,
  isCssRule,
  ruleSelector,
  detectSiteName,
  detectSearchPath,
  detectContentPattern,
  buildRules,
  generateSourceCode,
  DEFAULT_PATTERNS,
} from './smart-rules';

describe('stripTags', () => {
  it('去标签/脚本/样式并反转义实体（</p> 与 <br> 各产生一个换行）', () => {
    expect(stripTags('<div><script>evil()</script><p>第一章&nbsp;开始</p><br>次行</div>')).toBe(
      '第一章 开始\n\n次行',
    );
  });
  it('空输入返回空串', () => {
    expect(stripTags('')).toBe('');
  });
});

describe('absUrl', () => {
  it('相对路径基于 base 绝对化', () => {
    expect(absUrl('/book/1.html', 'https://x.com/search')).toBe('https://x.com/book/1.html');
    expect(absUrl('book/2', 'https://x.com/a/')).toBe('https://x.com/a/book/2');
  });
  it('非法输入原样返回', () => {
    expect(absUrl('ht tp://broken url', 'also-broken')).toBe('ht tp://broken url');
  });
});

describe('pickText', () => {
  it('命中返回指定捕获组', () => {
    expect(pickText('<h1[^>]*>([\\s\\S]*?)</h1>', '<h1 class="t">斗破苍穹</h1>')).toBe('斗破苍穹');
    expect(pickText('作者[：:]\\s*([^<]{1,30})', '作者：天蚕土豆<br>')).toBe('天蚕土豆');
  });
  it('未命中返回空串', () => {
    expect(pickText('<h2>(.*?)</h2>', '<p>nothing</p>')).toBe('');
  });
  it('非法正则抛带「正则无效」的错误', () => {
    expect(() => pickText('([', 'x')).toThrow('正则无效');
  });
});

describe('matchLinkItems', () => {
  const html =
    '<ul><li><a href="/b/1.html">第一本书</a></li>' +
    '<li><a href="https://x.com/b/2.html">第二本书</a></li></ul>';
  it('组1=URL 组2=书名，URL 自动绝对化、文本去标签', () => {
    const items = matchLinkItems(DEFAULT_PATTERNS.searchItemPattern, html, 'https://x.com/');
    expect(items).toEqual([
      { name: '第一本书', url: 'https://x.com/b/1.html' },
      { name: '第二本书', url: 'https://x.com/b/2.html' },
    ]);
  });
  it('limit 截断', () => {
    const many = '<a href="/b/1">书名一二三</a>'.repeat(10);
    expect(matchLinkItems(DEFAULT_PATTERNS.searchItemPattern, many, 'https://x.com/', 3)).toHaveLength(3);
  });
  it('非法正则抛错', () => {
    expect(() => matchLinkItems('([', 'x', 'https://x.com')).toThrow('正则无效');
  });
});

describe('isCssRule / ruleSelector — 双模式判定', () => {
  it('css: 前缀强制 CSS，ruleSelector 剥离前缀', () => {
    expect(isCssRule('css:a[href^="/book"]')).toBe(true);
    expect(isCssRule('CSS:dl.list dd a')).toBe(true);
    expect(ruleSelector('css:a[href^="/book"]')).toBe('a[href^="/book"]');
    expect(ruleSelector('dl.list dd a')).toBe('dl.list dd a');
  });
  it('ruleSelector 剥离大小写前缀与首尾空白', () => {
    expect(ruleSelector('CSS:dl.list dd a')).toBe('dl.list dd a');
    expect(ruleSelector('Css:dl.list dd a')).toBe('dl.list dd a');
    expect(ruleSelector('  css:dl.list dd a  ')).toBe('dl.list dd a');
    // 前缀后空格：实现里有二次 trim,更严谨,不会输出前导空格
    expect(ruleSelector('css: dl.list dd a')).toBe('dl.list dd a');
  });
  it('裸 ^（非 [^ 上下文）判为正则（与生成代码 char-loop 一致）', () => {
    expect(isCssRule('foo^bar')).toBe(false);
  });
  it('含正则特征字符判为正则', () => {
    for (const p of [
      DEFAULT_PATTERNS.searchItemPattern,
      DEFAULT_PATTERNS.bookAuthorPattern,
      '第.*章',
      'a[href^="/book"]', // 已知误判边界 → 用户加 css: 前缀强制
    ]) {
      expect(isCssRule(p)).toBe(false);
    }
  });
  it('普通选择器兜底判 CSS', () => {
    for (const p of ['dl.list dd a', 'div.content', '#content', 'dl.list dd a[href]', 'h1 > span.t']) {
      expect(isCssRule(p)).toBe(true);
    }
  });
});

describe('CSS 选择器模式', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  // 用户提供的真实搜索页样例:每本书 3 个相同 href 的锚点(img / 书名 / 免费阅读按钮)
  const SEARCH_HTML =
    '<dl class="list"><dt>共搜索到1本作品<span>(关键词：庆余年)</span></dt>' +
    '<dd><a href="/book/5/index.html"><img src="/book/cover.pic/cover_5.jpg"></a>' +
    '<div class="state"></div>' +
    '<h4 style=""><a href="/book/5/index.html">庆余年</a><span>/ 猫腻 /</span></h4>' +
    '<div class="intro"><p>一个年轻的病人，因为一次毫不意外的经历……</p><p>一部《庆余年》……</p></div>' +
    '<div><a href="/book/5/index.html" class="button">免费阅读</a>' +
    "<span class=\"button\" onclick=\"bookfavorite.add('book',5)\">加入书架</span></div></dd></dl>";
  const BASE = 'https://www.example.com/search?keyword=x';
  const BOOK_URL = 'https://www.example.com/book/5/index.html';

  it('dl.list dd a:同 URL 三锚点收敛为一条，非空书名优先', () => {
    expect(matchLinkItems('dl.list dd a', SEARCH_HTML, BASE)).toEqual([
      { name: '庆余年', url: BOOK_URL },
    ]);
  });
  it('容器选择器:命中非 a 元素时取后代锚点', () => {
    expect(matchLinkItems('dl.list dd', SEARCH_HTML, BASE)).toEqual([
      { name: '庆余年', url: BOOK_URL },
    ]);
  });
  it('多容器选择器:去重发生在扁平化链接层，不同容器的不同 URL 各自保留', () => {
    const html =
      '<dl class="list"><dd><a href="/b/1.html">书一</a></dd>' +
      '<dd><a href="/b/2.html">书二</a><a href="/b/2.html">阅读</a></dd></dl>';
    expect(matchLinkItems('dl.list dd', html, BASE)).toEqual([
      { name: '书一', url: 'https://www.example.com/b/1.html' },
      { name: '书二', url: 'https://www.example.com/b/2.html' },
    ]);
  });
  it('css: 前缀与自动判定等价', () => {
    expect(matchLinkItems('css:dl.list dd a', SEARCH_HTML, BASE)).toEqual([
      { name: '庆余年', url: BOOK_URL },
    ]);
  });
  it('pickText CSS 模式取首个命中元素 textContent', () => {
    expect(pickText('h4 a', SEARCH_HTML)).toBe('庆余年');
    expect(pickText('div.not-exist', SEARCH_HTML)).toBe('');
  });
  it('pickHtml CSS 取 innerHTML，正则取捕获组', () => {
    expect(pickHtml('div.intro', SEARCH_HTML)).toContain('<p>一个年轻的病人');
    expect(pickHtml('<div class="intro">([\\s\\S]*?)</div>', SEARCH_HTML)).toContain('一个年轻的病人');
    expect(pickHtml('div.not-exist', SEARCH_HTML)).toBe('');
    // CSS 命中 0 元素不抛异常,返回 ''
    expect(() => pickText('css:span.not-exist', SEARCH_HTML)).not.toThrow();
    expect(pickText('css:span.not-exist', SEARCH_HTML)).toBe('');
  });
  it('选择器语法非法抛「选择器无效」', () => {
    expect(() => matchLinkItems('css:###', SEARCH_HTML, BASE)).toThrow('选择器无效');
    expect(() => pickText('css:###', SEARCH_HTML)).toThrow('选择器无效');
  });
  it('Feature Flag 关闭时全量回退正则', () => {
    localStorage.setItem('pom.cssRules', '0');
    // 'dl.list dd a' 按正则编译合法但不可能命中 → 空结果而非 CSS 命中
    expect(matchLinkItems('dl.list dd a', SEARCH_HTML, BASE)).toEqual([]);
    expect(pickText('h4 a', SEARCH_HTML)).toBe('');
  });
});

describe('detect 系列', () => {
  it('detectSiteName 剥 title 后缀', () => {
    expect(detectSiteName('<title>無錯書吧-小说阅读网</title>', 'wcshuba.com')).toBe('無錯書吧');
    expect(detectSiteName('<html></html>', 'wcshuba.com')).toBe('wcshuba');
  });
  it('detectSearchPath 命中 search 表单 action', () => {
    const html = '<form action="/search/" method="get"><input type="text" name="searchkey"></form>';
    expect(detectSearchPath(html)).toBe('/search/?searchkey={keyword}');
  });
  it('detectSearchPath 无表单时给默认', () => {
    expect(detectSearchPath('<div>no form</div>')).toBe('/search?keyword={keyword}');
  });
  it('detectContentPattern 按命中情况选择容器正则', () => {
    expect(detectContentPattern('<div id="content">x</div>')).toContain('id="content"');
    expect(detectContentPattern('<div id="chaptercontent">x</div>')).toContain('chaptercontent');
    expect(detectContentPattern('<div class="main content">x</div>')).toContain('class=');
  });
});

describe('buildRules / generateSourceCode', () => {
  const html =
    '<title>测试站_小说网</title><form action="/search/" method="get">' +
    '<input type="text" name="q"></form><div id="content">正文</div>';
  it('buildRules 汇总探测结果', () => {
    const rules = buildRules('https://www.test.com/index.html', html);
    expect(rules.siteName).toBe('测试站');
    expect(rules.searchPath).toBe('/search/?q={keyword}');
    expect(rules.contentPattern).toContain('id="content"');
  });
  it('生成的代码包含规则值且能被 new Function 编译（沙箱同款）', () => {
    const rules = buildRules('https://www.test.com/', html);
    const code = generateSourceCode('https://www.test.com/', rules);
    expect(code).toContain('测试站');
    expect(code).toContain('SEARCH_ITEM_RULE');
    const factory = new Function(
      'legado',
      `${code}\n;return { search: typeof search === 'function' ? search : undefined,` +
        ` bookInfo: typeof bookInfo === 'function' ? bookInfo : undefined,` +
        ` chapterContent: typeof chapterContent === 'function' ? chapterContent : undefined };`,
    );
    const mod = factory({ http: {} }) as Record<string, unknown>;
    expect(typeof mod['search']).toBe('function');
    expect(typeof mod['bookInfo']).toBe('function');
    expect(typeof mod['chapterContent']).toBe('function');
  });
  it('含特殊字符（引号/斜杠/反斜杠）的规则不破坏生成代码', () => {
    const rules = {
      ...buildRules('https://www.test.com/', html),
      contentPattern: '<div[^>]+class="con/tent"[^>]*>([\\s\\S]*?)"引号"<\\/div>',
    };
    const code = generateSourceCode('https://www.test.com/', rules);
    const factory = new Function('legado', `${code}\n;return 1;`);
    expect(factory({ http: {} })).toBe(1);
  });
});

describe('generateSourceCode — CSS 规则运行时（mock legado 模拟沙箱）', () => {
  const SEARCH_HTML =
    '<dl class="list"><dd><a href="/book/5/index.html"><img src="c.jpg"></a>' +
    '<h4><a href="/book/5/index.html">庆余年</a></h4>' +
    '<div><a href="/book/5/index.html" class="button">免费阅读</a></div></dd></dl>';
  const cssRules = {
    ...buildRules('https://www.example.com/', '<title>样例站</title>'),
    searchPath: '/search?keyword={keyword}',
    searchItemPattern: 'dl.list dd a',
  };

  /** 编译生成代码并注入 mock legado(query 用 jsdom DOMParser 模拟主线程代理语义) */
  const compile = (code: string) => {
    const legado = {
      http: { get: async () => SEARCH_HTML },
      query: async (html: string, selector: string, baseUrl: string) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const abs = (h: string | null) => (h ? new URL(h, baseUrl).href : '');
        return Array.from(doc.querySelectorAll(selector)).map((el) => {
          const isA = el.tagName === 'A';
          const anchors = isA ? [el] : Array.from(el.querySelectorAll('a[href]'));
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? '').trim(),
            html: el.innerHTML,
            href: isA ? abs(el.getAttribute('href')) : '',
            links: anchors
              .map((a) => ({ href: abs(a.getAttribute('href')), text: (a.textContent ?? '').trim() }))
              .filter((l) => l.href),
          };
        });
      },
    };
    const factory = new Function(
      'legado',
      `${code}\n;return { search, bookInfo, chapterContent };`,
    );
    return factory(legado) as {
      search: (k: string, p: string) => Promise<Array<{ name: string; bookUrl: string }>>;
    };
  };

  it('CSS 规则生成代码含 legado.query 分支', () => {
    const code = generateSourceCode('https://www.example.com/', cssRules);
    expect(code).toContain('legado.query');
    expect(code).toContain('isCssRule');
  });
  it('沙箱内 search():dl.list dd a 三锚点收敛为一条庆余年', async () => {
    const code = generateSourceCode('https://www.example.com/', cssRules);
    const mod = compile(code);
    const res = await mod.search('庆余年', '1');
    expect(res).toEqual([
      { name: '庆余年', author: '', bookUrl: 'https://www.example.com/book/5/index.html' },
    ]);
  });
  it('正则规则生成代码 search() 行为与旧版一致(不走路径变化)', async () => {
    const rules = {
      ...cssRules,
      searchItemPattern: '<h4><a href="([^"]+)">([^<]+)</a>',
    };
    const code = generateSourceCode('https://www.example.com/', rules);
    const mod = compile(code);
    const res = await mod.search('x', '1');
    expect(res).toEqual([
      { name: '庆余年', author: '', bookUrl: 'https://www.example.com/book/5/index.html' },
    ]);
  });
});
