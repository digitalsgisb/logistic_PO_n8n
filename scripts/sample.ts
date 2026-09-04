import fs from 'node:fs/promises';
import path from 'node:path';
import { readPdf } from '../server/pdf.ts';
import { assemble, hash } from '../server/mapping.ts';
import { writeOrder } from '../server/workbook.ts';
import fixtures from '../tests/fixtures/orders.json' with { type: 'json' };
import type { Page } from '../server/types.ts';
const live = process.argv.includes('--live'),
  source = process.env.SAMPLE_PDF ?? 'TOYOTA PO.pdf';
const texts = await readPdf(await fs.readFile(source));
const pages: Page[] = [];
const prompt = await fs.readFile('workflows/extraction-prompt.txt', 'utf8');
const schema = JSON.parse(await fs.readFile('workflows/extraction-schema.json', 'utf8'));
const output = live ? 'outputs/live-sample' : 'outputs/fixture-sample';
await fs.mkdir(output, { recursive: true });
for (const [i, text] of texts.entries()) {
  console.log(`Extracting page ${i + 1}/${texts.length} (${live ? 'live Ollama' : 'known test fixture'})`);
  let extraction = fixtures[i];
  if (live) {
    const response = await fetch((process.env.OLLAMA_URL ?? 'http://100.109.37.96:11434') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-4.7-flash:q8_0',
        stream: false,
        think: false,
        format: schema,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: text },
        ],
        options: { temperature: 0, num_ctx: 32768, num_predict: 8192 },
        keep_alive: '30m',
      }),
      signal: AbortSignal.timeout(600000),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = (await response.json()) as { message: { content: string } };
    extraction = JSON.parse(data.message.content);
  }
  pages.push({
    id: String(i),
    file_id: 'sample',
    filename: path.basename(source),
    number: i + 1,
    text,
    hash: hash(text),
    state: 'extracted',
    extraction,
  });
}
await fs.writeFile(
  path.join(output, 'extractions.json'),
  JSON.stringify(
    pages.map((p) => p.extraction),
    null,
    2,
  ),
);
const { orders, errors } = assemble(pages);
if (errors.length) throw new Error(JSON.stringify(errors, null, 2));
for (const order of orders)
  await writeOrder(
    order,
    'templates/toyota.xlsx',
    path.join(output, `Toyota_${order.delivery_date}_${order.kb_number}.xlsx`),
  );
console.log(
  `Created ${orders.length} workbooks with ${orders.reduce((s, o) => s + o.items.length, 0)} item lines in ${output}.`,
);
