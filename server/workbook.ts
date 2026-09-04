import ExcelJS from 'exceljs';
import type { Order } from './types.ts';
import { headers } from './mapping.ts';
export async function writeOrder(order: Order, template: string, destination: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(template);
  const sheet = wb.getWorksheet('ASSB2016');
  if (!sheet) throw new Error('Toyota template is missing ASSB2016.');
  for (const [code, map] of Object.entries(headers))
    if (String(sheet.getCell(8, map.column).value) !== code)
      throw new Error(`Template header mismatch: ${code}.`);
  const [year, month, day] = order.delivery_date.split('-');
  sheet.getCell('F4').value = `DATE : ${day}/${month}/${year}`;
  const row = 13 + (order.trip - 1) * 3;
  for (const item of order.items) {
    const col = headers[item.item_code].column;
    sheet.getCell(row, col).value = item.total_quantity;
    const kb = sheet.getCell(row + 1, col);
    kb.value = order.kb_number;
    kb.font = { ...kb.font, size: 8 };
    kb.alignment = {
      ...kb.alignment,
      horizontal: 'center',
      vertical: 'middle',
      shrinkToFit: false,
      wrapText: true,
    };
    sheet.getRow(row + 1).height = Math.max(sheet.getRow(row + 1).height ?? 15, 30);
  }
  wb.creator = 'Toyota PO Converter';
  wb.created = new Date();
  wb.modified = new Date();
  await wb.xlsx.writeFile(destination);
}
