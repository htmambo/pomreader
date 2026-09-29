import { describe, it, expect, afterEach } from 'vitest';
import {
  stripTags,
  absUrl,
  pickText,
  pickHtml,
  pickAttr,
  matchLinkItems,
  matchSearchItems,
  isCssRule,
  ruleSelector,
  detectSiteName,
  detectSearchPath,
  detectContentPattern,
  buildRules,
  buildFormBody,
  applyContentReplaceRules,
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
  it('双重编码实体（&amp;nbsp;）先还原 &amp; 再统一转换，不残留字面 &nbsp;', () => {
    expect(stripTags('<p>&amp;nbsp;&amp;nbsp;段落</p>')).toBe('段落');
  });
  it('水平空白压缩但保留段间空行（\\n\\n），3+ 换行封顶', () => {
    expect(stripTags('<p>甲</p><br><br><br><p>乙</p>')).toBe('甲\n\n乙');
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
    expect(
      matchLinkItems(DEFAULT_PATTERNS.searchItemPattern, many, 'https://x.com/', 3),
    ).toHaveLength(3);
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
    for (const p of [
      'dl.list dd a',
      'div.content',
      '#content',
      'dl.list dd a[href]',
      'h1 > span.t',
    ]) {
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
    '<span class="button" onclick="bookfavorite.add(\'book\',5)">加入书架</span></div></dd></dl>';
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
    expect(pickHtml('<div class="intro">([\\s\\S]*?)</div>', SEARCH_HTML)).toContain(
      '一个年轻的病人',
    );
    expect(pickHtml('div.not-exist', SEARCH_HTML)).toBe('');
    // CSS 命中 0 元素不抛异常,返回 ''
    expect(() => pickText('css:span.not-exist', SEARCH_HTML)).not.toThrow();
    expect(pickText('css:span.not-exist', SEARCH_HTML)).toBe('');
  });
  it('pickAttr: CSS 命中元素取指定属性（不绝对化 URL，由调用方按 base 解析）', () => {
    expect(pickAttr('css:.list img', SEARCH_HTML, 'src')).toBe('/book/cover.pic/cover_5.jpg');
    expect(pickAttr('css:.list img', SEARCH_HTML, 'alt')).toBe('');
  });
  it('pickAttr: 正则模式按捕获组 1', () => {
    expect(pickAttr('<img[^>]+src="([^"]+)"', SEARCH_HTML, 'src')).toBe(
      '/book/cover.pic/cover_5.jpg',
    );
  });
  it('pickAttr: 未命中返回空串(不抛)', () => {
    expect(pickAttr('css:span.not-exist', SEARCH_HTML, 'src')).toBe('');
    expect(pickAttr('xxx.*', SEARCH_HTML, 'src')).toBe(''); // 正则未命中
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

describe('buildRules', () => {
  const html =
    '<title>测试站_小说网</title><form action="/search/" method="get">' +
    '<input type="text" name="q"></form><div id="content">正文</div>';
  it('buildRules 汇总探测结果', () => {
    const rules = buildRules('https://www.test.com/index.html', html);
    expect(rules.siteName).toBe('测试站');
    expect(rules.searchPath).toBe('/search/?q={keyword}');
    expect(rules.contentPattern).toContain('id="content"');
  });
  it('buildRules 自动填充封面规则默认值与空净化规则列表', () => {
    const rules = buildRules('https://www.test.com/index.html', html);
    expect(rules.coverUrlPattern).toBe(DEFAULT_PATTERNS.coverUrlPattern);
    expect(rules.contentReplaceRules).toEqual([]);
  });
  it('buildRules 默认不猜作者/分类规则（空串 = 不提取）', () => {
    const rules = buildRules('https://www.test.com/', '<title>t</title>');
    expect(rules.searchAuthorPattern).toBe('');
    expect(rules.searchCategoryPattern).toBe('');
  });
});

describe('buildFormBody', () => {
  it('空参数返回空字符串', () => {
    expect(buildFormBody([], 'k', 1)).toBe('');
  });
  it('空 key 跳过（避免生成 "&value" 这类无效段）', () => {
    expect(buildFormBody([{ key: '', value: 'x' }], 'k', 1)).toBe('');
    expect(
      buildFormBody(
        [
          { key: 'q', value: 'k' },
          { key: '', value: 'y' },
        ],
        'k',
        1,
      ),
    ).toBe('q=k');
  });
  it('{keyword}/{page} 占位符替换 + encodeURIComponent', () => {
    const out = buildFormBody(
      [
        { key: 'q', value: '{keyword}' },
        { key: 'p', value: '{page}' },
      ],
      '庆余年',
      2,
    );
    expect(out).toBe(`q=${encodeURIComponent('庆余年')}&p=2`);
  });
  it('value 含 & = 空格等特殊字符也正确 encode', () => {
    const out = buildFormBody([{ key: 'k', value: 'a&b=c d' }], 'x', 1);
    expect(out).toBe('k=a%26b%3Dc%20d');
  });
});

describe('正文净化规则', () => {
  it('applyContentReplaceRules:按顺序全局替换,替换为留空 = 删除', () => {
    expect(applyContentReplaceRules('aa广告bb广告cc', [{ rule: '广告', replace: '' }])).toBe(
      'aabbcc',
    );
    expect(applyContentReplaceRules('第1章', [{ rule: '第(\\d+)章', replace: '第 $1 章' }])).toBe(
      '第 1 章',
    );
  });
  it('applyContentReplaceRules:空 rule 与非法正则跳过,不中断后续规则', () => {
    const out = applyContentReplaceRules('a1b2', [
      { rule: '', replace: 'x' }, // 空 rule 跳过
      { rule: '([', replace: 'x' }, // 非法正则跳过
      { rule: '\\d', replace: '#' },
    ]);
    expect(out).toBe('a#b#');
  });
  it('applyContentReplaceRules:rules 缺省原样返回', () => {
    expect(applyContentReplaceRules('原文', undefined)).toBe('原文');
  });
});

// ========== 搜索结果增强规则（SEARCH_AUTHOR_RULE / SEARCH_CATEGORY_RULE） ==========

describe('matchSearchItems — 条目作用域内的作者/分类增强', () => {
  const BASE = 'https://www.example.com/search?keyword=x';
  /** 搜索页样例：每条 = 书名链接 + 作者 + 分类（与真实小说站结构一致） */
  const HTML =
    '<dl class="list">' +
    '<dd><h4><a href="/book/5/index.html">庆余年</a></h4>' +
    '<span class="author">猫腻</span><span class="kind">历史穿越</span></dd>' +
    '<dd><h4><a href="/book/6/index.html">将夜</a></h4>' +
    '<span class="author">猫腻</span><span class="kind">东方玄幻</span></dd>' +
    '</dl>';

  afterEach(() => localStorage.removeItem('pom.cssRules'));

  it('未配置增强规则 → 与 matchLinkItems 等价（不产生 author/kind 字段）', () => {
    expect(matchSearchItems('dl.list dd', HTML, BASE)).toEqual([
      { name: '庆余年', url: 'https://www.example.com/book/5/index.html' },
      { name: '将夜', url: 'https://www.example.com/book/6/index.html' },
    ]);
  });

  it('CSS 条目规则：作者/分类取自条目元素内部', () => {
    const items = matchSearchItems('dl.list dd', HTML, BASE, {
      authorRule: 'css:.author',
      categoryRule: 'css:.kind',
    });
    expect(items).toEqual([
      {
        name: '庆余年',
        url: 'https://www.example.com/book/5/index.html',
        author: '猫腻',
        kind: '历史穿越',
      },
      {
        name: '将夜',
        url: 'https://www.example.com/book/6/index.html',
        author: '猫腻',
        kind: '东方玄幻',
      },
    ]);
  });

  it('条目规则只选中书名 <a> 时作用域不含作者 → 增强字段缺省（不是整页取值）', () => {
    const items = matchSearchItems('dl.list dd h4 a', HTML, BASE, {
      authorRule: 'css:.author',
      categoryRule: 'css:.kind',
    });
    expect(items).toEqual([
      { name: '庆余年', url: 'https://www.example.com/book/5/index.html' },
      { name: '将夜', url: 'https://www.example.com/book/6/index.html' },
    ]);
  });

  it('CSS 条目规则 + 正则增强规则：同一条目内命中即写入', () => {
    const items = matchSearchItems('dl.list dd', HTML, BASE, {
      authorRule: '<span class="author">([^<]+)</span>',
    });
    expect(items[0].author).toBe('猫腻');
    expect(items[0].kind).toBeUndefined();
  });

  it('正则条目规则：作用域 = 本条匹配起点 → 下一条匹配起点', () => {
    const HTML2 =
      '<div class="item"><a href="/b/1.html">书一</a>' +
      '<span class="author">作者甲</span><span class="kind">玄幻</span></div>' +
      '<div class="item"><a href="/b/2.html">书二</a><span class="author">作者乙</span></div>';
    const items = matchSearchItems('<a href="([^"]+)">([^<]+)</a>', HTML2, BASE, {
      authorRule: '<span class="author">([^<]+)</span>',
      categoryRule: '<span class="kind">([^<]+)</span>',
    });
    expect(items).toEqual([
      { name: '书一', url: 'https://www.example.com/b/1.html', author: '作者甲', kind: '玄幻' },
      { name: '书二', url: 'https://www.example.com/b/2.html', author: '作者乙' },
    ]);
  });

  it('规则未命中 → 字段缺省而非空串（不污染下游 pickString 判定）', () => {
    const items = matchSearchItems('dl.list dd', HTML, BASE, { authorRule: 'css:.not-exist' });
    expect(items.every((it) => !('author' in it))).toBe(true);
  });

  it('非法增强规则沿用 pickText 的报错（选择器非法 / 正则非法）', () => {
    expect(() => matchSearchItems('dl.list dd', HTML, BASE, { authorRule: 'css:###' })).toThrow(
      '选择器无效',
    );
    expect(() => matchSearchItems('dl.list dd', HTML, BASE, { authorRule: '([' })).toThrow(
      '正则无效',
    );
  });
});
