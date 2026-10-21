import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { writeFile } from 'node:fs/promises';
import type { Order } from './types.ts';
import { headers } from './mapping.ts';

const usesQtyRow = (code: string) => code === '614' || code === 'HU83';

export function batchFilename(orders: Order[], workbookDate?: string) {
  if (workbookDate) return `Toyota_${workbookDate}_Combined.xlsx`;
  const dates = [...new Set(orders.map((order) => order.delivery_date))].sort();
  if (dates.length !== 1) throw new Error('Each workbook must contain exactly one delivery date.');
  return `Toyota_${dates[0]}_Combined.xlsx`;
}

export function ordersByDate(orders: Order[]): [string, Order[]][] {
  const groups = new Map<string, Order[]>();
  for (const order of orders) {
    const group = groups.get(order.delivery_date) ?? [];
    group.push(order);
    groups.set(order.delivery_date, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Orders are validated and deduplicated by assemble before reaching this writer. */
export async function writeBatch(orders: Order[], template: string, destination: string, workbookDate?: string) {
  if (!orders.length) throw new Error('No valid orders to include in the workbook.');
  batchFilename(orders, workbookDate); // Reject mixed dates unless the dispatch date is supplied.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(template);
  const original = wb.getWorksheet('ASSB2016');
  if (!original) throw new Error('Toyota template is missing ASSB2016.');
  for (const [code, map] of Object.entries(headers))
    if (String(original.getCell(8, map.column).value) !== code)
      throw new Error(`Template header mismatch: ${code}.`);

  // Each output contains one daily template; the engine groups orders before calling this writer.
  const dates = workbookDate ? [workbookDate] : [...new Set(orders.map((order) => order.delivery_date))].sort();
  for (const date of dates) {
    const sheet = original;
    const tripOrdersByTrip = Array.from({ length: 10 }, (_, index) =>
      orders.filter((order) => (workbookDate || order.delivery_date === date) && order.trip === index + 1),
    );
    const extraRows = tripOrdersByTrip.map((group) => Math.max(0, group.length - 3));
    const addedRows = extraRows.reduce((sum, count) => sum + count, 0);
    if (addedRows) {
      // ExcelJS does not relocate merged ranges reliably during row insertion.
      // Unmerge first, then rebuild the ranges around the expanded trip blocks.
      const merges = [...sheet.model.merges];
      for (const range of merges) sheet.unMergeCells(range);
      for (let index = 9; index >= 0; index--) {
        if (!extraRows[index]) continue;
        const insertAt = 16 + index * 3;
        sheet.insertRows(insertAt, Array.from({ length: extraRows[index] }, () => []), 'i+');
        for (let offset = 0; offset < extraRows[index]; offset++)
          sheet.getRow(insertAt + offset).height = sheet.getRow(insertAt - 1).height;
      }
      const shiftedRow = (row: number, end: boolean) => row + extraRows.reduce(
        (sum, count, index) => sum + (15 + index * 3 < row || (end && 15 + index * 3 === row) ? count : 0),
        0,
      );
      for (const range of merges) {
        const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/)!;
        sheet.mergeCells(`${match[1]}${shiftedRow(+match[2], false)}:${match[3]}${shiftedRow(+match[4], true)}`);
      }
    }
    // Force every generated daily sheet to one A4 landscape page.
    sheet.pageSetup.paperSize = 9;
    sheet.pageSetup.orientation = 'landscape';
    sheet.pageSetup.fitToPage = true;
    sheet.pageSetup.fitToWidth = 1;
    sheet.pageSetup.fitToHeight = 1;
    sheet.pageSetup.printArea = `A4:AE${42 + addedRows}`;
    sheet.pageSetup.margins = { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1, header: 0, footer: 0 };
    // Balance the template's narrow columns against the text size. Enlarging all
    // fonts caused clipped part descriptions, wrapped trip labels and ### quantities.
    sheet.getColumn(1).width = Math.max(sheet.getColumn(1).width ?? 0, 11);
    sheet.getColumn(2).width = Math.max(sheet.getColumn(2).width ?? 0, 8);
    for (let column = 4; column <= 30; column++)
      sheet.getColumn(column).width = Math.max(sheet.getColumn(column).width ?? 0, 12);
    sheet.getColumn(31).width = Math.max(sheet.getColumn(31).width ?? 0, 48);
    sheet.getRow(9).height = Math.max(sheet.getRow(9).height ?? 0, 150);
    for (let row = 4; row <= 42 + addedRows; row++)
      for (let column = 1; column <= 31; column++) {
        const cell = sheet.getCell(row, column);
        if (cell.isMerged && cell.master.address !== cell.address) continue;
        if (cell.value !== null) {
          cell.style = structuredClone(cell.style);
          const size = row <= 6 ? 18 : row === 9 ? 14 : row <= 8 ? 14 : column === 2 ? 10 : 14;
          cell.font = { ...cell.font, name: 'Arial', size };
          cell.alignment = { ...cell.alignment, vertical: 'middle', shrinkToFit: true, wrapText: row === 9 };
        }
      }
    const [year, month, day] = date.split('-');
    sheet.getCell('F4').value = `DATE : ${day}/${month}/${year}`;
    let row = 13;
    for (let trip = 1; trip <= 10; trip++) {
      const tripOrders = tripOrdersByTrip[trip - 1];
      const rowCount = 3 + extraRows[trip - 1];
      const markersByOrder = new Map<Order, string>();
      for (const destination of ['BUKIT RAJA', 'SHAH ALAM'] as const) {
        const group = tripOrders
          .filter((order) => order.destination === destination)
          .sort((a, b) => a.kb_number.localeCompare(b.kb_number));
        if (!group.length) continue;
        const isHook = (order: Order) => order.items.some((item) => item.item_code === 'HU83');
        // Only CBOX/HOOK may carry stars. Prefer an ordinary PO as the unmarked base.
        const hasQtyPart = (order: Order) => order.items.some((item) => usesQtyRow(item.item_code));
        const base = group.find((order) => !hasQtyPart(order)) ?? group.find((order) => !isHook(order)) ?? group[0];
        markersByOrder.set(base, '');
        group
          .filter((order) => order !== base && hasQtyPart(order))
          .sort((a, b) => Number(isHook(b)) - Number(isHook(a)))
          .forEach((order, index) => markersByOrder.set(order, '*'.repeat(index + 1)));
      }
      const markedOrders = tripOrders.map((order) => ({
        order,
        marker: markersByOrder.get(order) ?? '',
      }));
      const quantities = new Map<string, { part: string; total: number; markers: string[] }>();
      for (const { order, marker } of markedOrders)
        for (const item of order.items) {
          const previous = quantities.get(item.item_code);
          if (previous && previous.part !== item.part_number)
            throw new Error(`Conflicting part numbers for ${item.item_code} on ${date}, trip ${trip}.`);
          const total = (previous?.total ?? 0) + item.total_quantity;
          if (!Number.isSafeInteger(total))
            throw new Error(`Quantity total is too large for ${item.item_code}.`);
          quantities.set(item.item_code, {
            part: item.part_number,
            total,
            markers: [...(previous?.markers ?? []), usesQtyRow(item.item_code) ? marker : ''],
          });
        }
      for (const [code, { total, markers }] of quantities) {
        const targetRow = usesQtyRow(code) ? row : row + 1;
        const cell = sheet.getCell(targetRow, headers[code].column);
        cell.value = total;
        // Template cells can share style objects; each quantity needs its own markers.
        cell.style = structuredClone(cell.style);
        cell.font = { ...cell.font, name: 'Arial', size: 18 };
        cell.alignment = { ...cell.alignment, horizontal: 'center', vertical: 'middle', wrapText: false, shrinkToFit: true };
        // A literal prefix in the number format keeps the underlying value numeric.
        if (!usesQtyRow(code)) {
          cell.numFmt = '0';
        } else if (markers.length === 1) {
          cell.numFmt = markers[0] ? `"${markers[0]}"0` : '0';
        } else {
          const lines = markers.filter(Boolean);
          cell.numFmt = `0"\n${lines.join('\n')}"`;
          cell.alignment = { ...cell.alignment, wrapText: true };
          sheet.getRow(targetRow).height = Math.max(sheet.getRow(targetRow).height ?? 15, (lines.length + 1) * 22 + 6);
        }
      }

      // Each PO gets its own cell; expanded trip blocks keep overflow in the same trip.
      const numbers = markedOrders.map(({ order, marker }) =>
        marker ? `${marker} ${order.kb_number}` : order.kb_number,
      );
      for (let i = 0; i < rowCount; i++) {
        const cell = sheet.getCell(row + i, 31);
        cell.value = numbers[i] ?? null;
        if (numbers[i]) {
          cell.font = { ...cell.font, name: 'Arial', size: 16, bold: true };
          cell.alignment = {
            ...cell.alignment,
            horizontal: 'left',
            vertical: 'middle',
            wrapText: false,
            shrinkToFit: true,
          };
          sheet.getRow(row + i).height = Math.max(sheet.getRow(row + i).height ?? 15, 32);
        }
      }
      row += rowCount;
    }
  }
  wb.creator = 'Logistic Digital';
  wb.created = new Date();
  wb.modified = new Date();
  const archive = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  const styles = await archive.file('xl/styles.xml')!.async('string');
  // XML normalizes literal newlines in attributes; preserve multiline number formats.
  archive.file(
    'xl/styles.xml',
    styles.replace(/formatCode="[^"]*"/g, (attribute) => attribute.replace(/\r?\n/g, '&#10;')),
  );
  await writeFile(destination, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
