/** URL 是否指向可自动导入的文件（.txt/.zip/.rar/.7z，忽略 query/hash）——纯函数便于单测 */
export function isImportableUrl(url: string): boolean {
  return /\.(txt|zip|rar|7z)([?#].*)?$/i.test(url.trim());
}
