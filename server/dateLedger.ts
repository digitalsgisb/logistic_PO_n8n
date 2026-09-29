import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DispatchDate, Order } from './types.ts';
import { Store } from './store.ts';
import { batchFilename, ordersByDate, writeBatch } from './workbook.ts';

const identity = (order: Order) => `${order.source_order_id}|${order.destination}|${order.delivery_sequence}`;
const content = (order: Order) => JSON.stringify({
  sequence: order.delivery_sequence, route: order.route, trip: order.trip,
  page_count: order.page_count, items: order.items,
});

export class DateLedger {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private store: Store, private dataDir: string, private template: string) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work, work);
    this.pending = result.catch(() => {});
    return result;
  }

  private file(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw Object.assign(new Error('Invalid order date.'), { statusCode: 400 });
    return path.join(this.dataDir, 'dispatch-dates', `Toyota_${date}_Combined.xlsx`);
  }

  private async write(entry: DispatchDate) {
    const output = this.file(entry.date);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      await writeBatch(entry.orders, this.template, temporary);
      await fs.rename(temporary, output);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  ingest(orders: Order[]) {
    return this.serial(async () => {
      const changes: { date: string; count: number; changed: boolean; reopened: boolean }[] = [];
      for (const [date, incoming] of ordersByDate(orders)) {
        const previous = this.store.getDate(date);
        const byId = new Map((previous?.orders ?? []).map((order) => [identity(order), order]));
        let changed = false;
        for (const order of incoming) {
          const earlier = byId.get(identity(order));
          if (!earlier || content(earlier) !== content(order)) {
            byId.set(identity(order), order);
            changed = true;
          }
        }
        const entry: DispatchDate = {
          date,
          status: changed ? 'open' : previous?.status ?? 'open',
          orders: [...byId.values()],
          updated_at: changed ? new Date().toISOString() : previous?.updated_at ?? new Date().toISOString(),
          completed_at: changed ? undefined : previous?.completed_at,
          reopened_reason: changed && previous?.status === 'complete' ? 'new_po' : previous?.reopened_reason,
          revision: (previous?.revision ?? 0) + Number(changed),
        };
        if (changed) {
          if (previous?.status === 'complete') {
            previous.status = 'open';
            previous.completed_at = undefined;
            this.store.saveDate(previous);
          }
          await this.write(entry);
          this.store.saveDate(entry);
        }
        changes.push({ date, count: entry.orders.length, changed, reopened: changed && previous?.status === 'complete' });
      }
      return changes;
    });
  }

  setComplete(date: string, complete: boolean) {
    return this.serial(async () => {
      this.file(date);
      const entry = this.store.getDate(date);
      if (!entry) throw Object.assign(new Error('No orders are saved for this date.'), { statusCode: 404 });
      if (complete) {
        // The draft is already saved; refresh it before exposing the download.
        await this.write(entry);
        entry.status = 'complete';
        entry.completed_at = new Date().toISOString();
        entry.reopened_reason = undefined;
      } else {
        entry.status = 'open';
        entry.completed_at = undefined;
        entry.reopened_reason = 'manual';
      }
      entry.updated_at = new Date().toISOString();
      return this.store.saveDate(entry);
    });
  }

  clearAll(jobIds: string[]) {
    return this.serial(async () => {
      const dates = this.store.allDates();
      const dataRoot = path.resolve(this.dataDir) + path.sep;
      const directories = jobIds.map((id) => {
        const directory = path.resolve(this.dataDir, id);
        if (!directory.startsWith(dataRoot) || !/^[A-Za-z0-9_-]+$/.test(id))
          throw new Error('An invalid upload directory prevented clearing history.');
        return directory;
      });
      const workbooks = dates.map((entry) => this.file(entry.date));
      for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
      for (const workbook of workbooks) await fs.rm(workbook, { force: true });
      this.store.clearHistoryRows();
      return { dates: dates.length, uploads: jobIds.length };
    });
  }

  publicEntry(entry: DispatchDate) {
    return {
      date: entry.date,
      status: entry.status,
      order_count: entry.orders.length,
      order_numbers: entry.orders.map((order) => order.kb_number),
      trips: [...new Set(entry.orders.map((order) => order.trip))].sort((a, b) => a - b),
      sources: [...new Set(entry.orders.flatMap((order) => order.source_pages))],
      updated_at: entry.updated_at,
      completed_at: entry.completed_at,
      reopened_reason: entry.reopened_reason,
      revision: entry.revision,
      filename: entry.status === 'complete' ? batchFilename(entry.orders) : undefined,
    };
  }

  download(date: string) {
    this.file(date);
    const entry = this.store.getDate(date);
    if (!entry || entry.status !== 'complete')
      throw Object.assign(new Error('Mark this date complete before downloading its Excel.'), { statusCode: 404 });
    return { path: this.file(date), filename: batchFilename(entry.orders) };
  }
}
