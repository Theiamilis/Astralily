export function overviewReplyPages(text: string, columns: number) {
  const pages: string[] = [];
  let chunk = '';
  let row = 0;
  let column = 0;
  for (const char of Array.from(text)) {
    chunk += char;
    if (char === '\n') { row++; column = 0; }
    else column += char.charCodeAt(0) > 255 ? 2 : 1;
    if (column >= columns) { row++; column = 0; }
    if (row < 5) continue;
    const boundary = Math.max(chunk.lastIndexOf(' '), chunk.lastIndexOf('\n'));
    if (boundary > 0 && boundary >= chunk.length - 32) {
      pages.push(chunk.slice(0, boundary + 1));
      chunk = chunk.slice(boundary + 1);
      const units = Array.from(chunk).reduce((sum, item) => sum + (item.charCodeAt(0) > 255 ? 2 : 1), 0);
      row = Math.floor(units / columns);
      column = units % columns;
    } else {
      pages.push(chunk);
      chunk = ''; row = 0; column = 0;
    }
  }
  if (chunk || !pages.length) pages.push(chunk);
  return pages;
}
