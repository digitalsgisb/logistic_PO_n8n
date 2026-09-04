import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { writeFile } from 'node:fs/promises';
import type { Order } from './types.ts';
import { headers } from './mapping.ts';

export function batchFilename(orders: Order[]) {
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
export async function writeBatch(orders: Order[], template: string, destination: string) {
  if (!orders.length) throw new Error('No valid orders to include in the workbook.');
  batchFilename(orders); // Reject mixed dates even when the caller supplies a custom filename.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(template);
  const original = wb.getWorksheet('ASSB2016');
  if (!original) throw new Error('Toyota template is missing ASSB2016.');
  for (const [code, map] of Object.entries(headers))
    if (String(original.getCell(8, map.column).value) !== code)
      throw new Error(`Template header mismatch: ${code}.`);

  // Each output contains one daily template; the engine groups orders before calling this writer.
  const dates = [...new Set(orders.map((order) => order.delivery_date))].sort();
  for (const date of dates) {
    const sheet = original;
    // Force every generated daily sheet to one A4 landscape page.
    sheet.pageSetup.paperSize = 9;
    sheet.pageSetup.orientation = 'landscape';
    sheet.pageSetup.fitToPage = true;
    sheet.pageSetup.fitToWidth = 1;
    sheet.pageSetup.fitToHeight = 1;
    sheet.getColumn(31).width = Math.max(sheet.getColumn(31).width ?? 0, 44);
    const [year, month, day] = date.split('-');
    sheet.getCell('F4').value = `DATE : ${day}/${month}/${year}`;
    for (let trip = 1; trip <= 10; trip++) {
      const row = 13 + (trip - 1) * 3;
      const tripOrders = orders.filter((order) => order.delivery_date === date && order.trip === trip);
      const markersByOrder = new Map<Order, string>();
      for (const destination of ['BUKIT RAJA', 'SHAH ALAM'] as const) {
        const group = tripOrders
          .filter((order) => order.destination === destination)
          .sort((a, b) => a.kb_number.localeCompare(b.kb_number));
        if (!group.length) continue;
        const isHook = (order: Order) => order.items.some((item) => item.item_code === 'HU83');
        // Each destination has an unmarked base PO. Give HOOK the first star when ambiguous.
        const base = group.find((order) => !isHook(order)) ?? group[0];
        markersByOrder.set(base, '');
        group
          .filter((order) => order !== base)
          .sort((a, b) => Number(isHook(b)) - Number(isHook(a)))
          .forEach((order, index) => markersByOrder.set(order, '*'.repeat(index + 1)));
      }
      const markedOrders = tripOrders.map((order) => ({
        order,
        marker: markersByOrder.get(order)!,
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
            markers: [...(previous?.markers ?? []), marker],
          });
        }
      for (const [code, { total, markers }] of quantities) {
        const cell = sheet.getCell(row, headers[code].column);
        cell.value = total;
        // Template cells can share style objects; each quantity needs its own markers.
        cell.style = structuredClone(cell.style);
        cell.font = { ...cell.font, size: 18 };
        cell.alignment = { ...cell.alignment, wrapText: true, shrinkToFit: false };
        // A literal prefix in the number format keeps the underlying value numeric.
        if (markers.length === 1) {
          cell.numFmt = markers[0] ? `"${markers[0]} "0` : '0';
        } else {
          const lines = markers.filter(Boolean);
          cell.numFmt = `0"\n${lines.join('\n')}"`;
          sheet.getRow(row).height = Math.max(sheet.getRow(row).height ?? 15, (lines.length + 1) * 24 + 6);
        }
      }

      // Use the three existing Remarks cells next to each trip; KB and DO rows stay blank.
      const numbers = markedOrders.map(({ order, marker }) =>
        marker ? `${marker} ${order.kb_number}` : order.kb_number,
      );
      let offset = 0;
      for (let i = 0; i < 3; i++) {
        const count = Math.ceil((numbers.length - offset) / (3 - i));
        const cell = sheet.getCell(row + i, 31);
        cell.value = count ? numbers.slice(offset, offset + count).join('\n') : null;
        if (count) {
          cell.font = { ...cell.font, size: 20, bold: true };
          cell.alignment = {
            ...cell.alignment,
            horizontal: 'left',
            vertical: 'middle',
            wrapText: true,
            shrinkToFit: false,
          };
          sheet.getRow(row + i).height = Math.max(sheet.getRow(row + i).height ?? 15, count * 26 + 6);
        }
        offset += count;
      }
    }
  }
  wb.creator = 'Toyota PO Converter';
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
