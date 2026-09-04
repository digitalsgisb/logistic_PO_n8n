import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ExcelJS from 'exceljs';
await fs.mkdir('templates', { recursive: true });
const wb = new ExcelJS.Workbook();
const fallback = process.argv.indexOf('--from-xls-json');
if (fallback >= 0) {
  const source = JSON.parse(await fs.readFile(process.argv[fallback + 1], 'utf8'));
  const sheet = wb.addWorksheet('ASSB2016');
  for (const item of source.cells) {
    const cell = sheet.getCell(item.r, item.c);
    cell.value = item.value;
    cell.style = source.styles[item.style];
  }
  for (const [r, props] of Object.entries(source.rows)) Object.assign(sheet.getRow(+r), props);
  for (const [c, props] of Object.entries(source.cols)) Object.assign(sheet.getColumn(+c), props);
  for (const [r1, r2, c1, c2] of source.merges) sheet.mergeCells(r1 + 1, c1 + 1, r2, c2);
  sheet.pageSetup = {
    paperSize: 8 as ExcelJS.PaperSize,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
    printArea: 'A4:AE42',
    margins: { left: 0.2, right: 0.2, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 },
  };
} else {
  const source = path.resolve(process.argv[2] ?? 'templates/source.xls'),
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'toyota-template-'));
  try {
    execFileSync(
      process.env.SOFFICE_PATH ?? 'soffice',
      [
        '-env:UserInstallation=file:///' + path.join(temp, 'profile').replaceAll('\\', '/'),
        '--headless',
        '--convert-to',
        'xlsx',
        '--outdir',
        temp,
        source,
      ],
      { stdio: 'inherit', timeout: 120000 },
    );
    await wb.xlsx.readFile(path.join(temp, path.basename(source, path.extname(source)) + '.xlsx'));
    for (const s of [...wb.worksheets]) if (s.name !== 'ASSB2016') wb.removeWorksheet(s.id);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
const sheet = wb.getWorksheet('ASSB2016');
if (!sheet) throw new Error('Source Toyota sheet not found.');
for (let r = 10; r <= 42; r++)
  for (let c = 3; c <= 33; c++) {
    const cell = sheet.getCell(r, c);
    if (!cell.isMerged || cell.master.address === cell.address) cell.value = null;
  }
sheet.getCell('F4').value = 'DATE :';
sheet.getCell('A25').value = 'TRIP 5';
sheet.views = [{ state: 'normal', showGridLines: false }];
wb.views = [{ x: 0, y: 0, width: 16000, height: 9000, activeTab: 0, firstSheet: 0, visibility: 'visible' }];
await wb.xlsx.writeFile('templates/toyota.xlsx');
console.log(
  'Prepared templates/toyota.xlsx (' +
    (fallback >= 0 ? 'BIFF style fallback' : 'LibreOffice conversion') +
    ').',
);
