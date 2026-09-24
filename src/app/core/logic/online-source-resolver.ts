/**
 * 外部源 URL 解析（mock）
 * 来源：v1.1 §7.2 + SPEC §5.2
 *
 * 当前实现：mock（无原 vendor 接入）
 * 真实接入时替换 fetch + 解析规则
 */

export interface ResolvedChapter {
  title: string;
  url: string;
}

export interface ResolvedSource {
  title?: string;
  author?: string;
  chapters?: ResolvedChapter[];
  error?: string;
}

const LOREM_TITLES = [
  '第一章 风起云涌',
  '第二章 山雨欲来',
  '第三章 落花流水',
  '第四章 孤帆远影',
  '第五章 故人重逢',
  '第六章 风云突变',
  '第七章 月圆之夜',
  '第八章 往事如烟',
  '第九章 沧海桑田',
  '第十章 天下归心',
];

/**
 * Mock 解析：返回 5-10 章 + 5% 失败率
 */
export function resolveSource(url: string): Promise<ResolvedSource> {
  return new Promise((resolve) => {
    setTimeout(() => {
      // 1. URL 格式校验优先（无随机性，避免误判为 source-unavailable）
      let host: string;
      try {
        const u = new URL(url);
        host = u.host || 'example.com';
      } catch {
        resolve({ error: 'invalid-url' });
        return;
      }
      // 2. 模拟源不可用（5%）
      if (Math.random() < 0.05) {
        resolve({ error: 'source-unavailable' });
        return;
      }
      // 3. 正常返回 mock 解析
      const count = 5 + Math.floor(Math.random() * 6); // 5-10
      const title = `${host} 在线书 ${new Date().toISOString().slice(0, 10)}`;
      const author = host;
      const chapters: ResolvedChapter[] = LOREM_TITLES.slice(0, count).map(
        (t, i) => ({ title: t, url: `${url}#chapter-${i + 1}` })
      );
      resolve({ title, author, chapters });
    }, 300);
  });
}