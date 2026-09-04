import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
export async function readPdf(bytes: Uint8Array, maxPages = 100): Promise<string[]> {
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > maxPages) throw new Error(`PDF exceeds the ${maxPages}-page limit.`);
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const seen: { text: string; x: number; y: number }[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const x = item.transform[4],
          y = item.transform[5],
          text = item.str.trim();
        if (!seen.some((p) => p.text === text && Math.abs(p.x - x) < 1.5 && Math.abs(p.y - y) < 1.5))
          seen.push({ text, x, y });
      }
      seen.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));
      const rows: { y: number; cells: typeof seen }[] = [];
      for (const item of seen) {
        let row = rows.find((r) => Math.abs(r.y - item.y) < 2);
        if (!row) {
          row = { y: item.y, cells: [] };
          rows.push(row);
        }
        row.cells.push(item);
      }
      pages.push(
        rows
          .map((r) =>
            r.cells
              .sort((a, b) => a.x - b.x)
              .map((c) => c.text)
              .join(' '),
          )
          .join('\n'),
      );
    }
    return pages;
  } catch (error) {
    if (error instanceof Error && /password/i.test(error.name + error.message))
      throw new Error('Password-protected PDF. Upload an unlocked copy.');
    throw error;
  } finally {
    await task.destroy();
  }
}
