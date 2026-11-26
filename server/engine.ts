import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { config } from './config.ts';
import { detectCompany, readPdf } from './pdf.ts';
import { assemble, destination, hash, sourceDeliveryDate, sourceItems, sourceOrderId, sourceRoute, sourcePagination } from './mapping.ts';
import { logScan } from './scan-log.ts';
import { DateLedger } from './dateLedger.ts';
import { deletePeroduaDate, peroduaReview, savedPeroduaExport, resolvePeroduaDate } from './perodua-history.ts';
import { changePeroduaDate, generatePerodua, processPerodua } from './perodua.ts';
import type { Job, Extraction, Result } from './types.ts';
const running = new Set(['reading', 'processing', 'generating']);
export class Engine {
  busy = false;
  clearing = false;
  ledger: DateLedger;
  constructor(
    public store: Store,
    public options = config,
  ) {
    this.ledger = new DateLedger(store, options.dataDir, options.template);
  }
  recover() {
    for (const job of this.store.all())
      if (running.has(job.state)) {
        job.state = 'interrupted';
        job.stage = 'Processing interrupted. Retry to continue.';
        this.store.save(job);
      }
  }
  async tick() {
    if (this.busy || this.clearing) return;
    this.busy = true;
    try {
      const jobs = this.store.all();
      for (const job of jobs) {
        if (
          running.has(job.state) &&
          Date.now() - Date.parse(job.updated_at) > this.options.staleMinutes * 60000
        ) {
          job.state = 'interrupted';
          job.stage = 'No response from processing. Retry to continue.';
          job.attempt = randomUUID();
          this.store.save(job);
        }
        if (
          !running.has(job.state) &&
          Date.now() - Date.parse(job.created_at) > this.options.retentionDays * 86400000
        ) {
          await fs.rm(path.join(this.options.dataDir, job.id), { recursive: true, force: true });
          this.store.delete(job.id);
        }
      }
      if (this.store.all().some((j) => running.has(j.state))) return;
      const next = this.store.all().find((j) => j.state === 'queued');
      if (next) await this.start(next);
    } finally {
      this.busy = false;
    }
  }
  async start(job: Job) {
    try {
      job.state = 'reading';
      job.stage = 'Reading documents';
      this.store.save(job);
      for (const file of job.files) {
        if (file.history_deleted || file.duplicate || (file.perodua && (['ready', 'extracted'].includes(file.perodua.status) || isPeroduaSetupNotice(file.perodua.error))) || job.pages.some((p) => p.file_id === file.id)) continue;
        try {
          const texts = await readPdf(await fs.readFile(file.path), this.options.maxPages);
          const company = detectCompany(texts);
          file.company = company;

          if (company === 'PERODUA') {
            file.perodua = await processPerodua(
              file, this.options.dataDir,
              path.join(this.options.dataDir, job.id, 'perodua', file.id),
              this.options.peroduaSettingsPath,
            );
            file.error = file.perodua.error;
            const data = JSON.parse(await fs.readFile(file.perodua.json_path, 'utf8'));
            await logScan(this.options.dataDir, job.id, file.id, {
              source_file: file.filename, company: 'PERODUA', status: file.perodua.status,
              data, ...(file.error ? { error: file.error } : {}),
            });
            this.store.save(job);
            continue; // Perodua documents must not enter the Toyota AI queue.
          }

          texts.forEach((text, i) =>
            job.pages.push({
              id: randomUUID(),
              file_id: file.id,
              filename: file.filename,
              number: i + 1,
              text,
              hash: hash(text),
              state: text.trim().length > 40 ? 'pending' : 'error',
              error:
                text.trim().length > 40
                  ? undefined
                  : 'No readable text. Upload the original text-based PDF; scans are not supported in this pilot.',
            }),
          );
          file.error = undefined;
        } catch (e) {
          file.error = e instanceof Error ? e.message : 'Unable to read PDF.';
          await logScan(this.options.dataDir, job.id, file.id, {
            source_file: file.filename, status: 'error', error: file.error,
          });
        }
        this.store.save(job);
      }
      job.state = 'processing';
      job.stage = 'Waiting for n8n';
      this.store.save(job);
      if (!job.pages.some((p) => p.state === 'pending')) {
        await this.finish(job);
        return;
      }
      // At-most-once dispatch: an uncertain webhook response is not blindly retried.
      const response = await fetch(this.options.n8nWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Secret': this.options.serviceSecret },
        body: JSON.stringify({ job_id: job.id, attempt: job.attempt }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new Error(
          `n8n webhook returned ${response.status}. Check that the Toyota workflow is published and credentials match.`,
        );
    } catch (e) {
      const latest = this.store.get(job.id)!;
      // Do not overwrite a callback that already advanced the job.
      if (
        latest.state === 'processing' &&
        latest.pages.some((p) => p.state !== 'pending' && p.state !== 'error')
      )
        return;
      latest.state = 'interrupted';
      latest.stage = 'Unable to start processing';
      latest.error = e instanceof Error ? e.message : String(e);
      this.store.save(latest);
    }
  }
  async claim(id: string, attempt: string) {
    const job = this.requireActive(id, attempt);
    if (job.pages.some((p) => p.state === 'extracting'))
      throw Object.assign(new Error('A page is already being processed.'), { statusCode: 409 });
    const page = job.pages.find((p) => p.state === 'pending');
    if (!page) {
      await this.finish(job);
      return { done: true, job_id: id, attempt };
    }
    page.state = 'extracting';
    job.stage = `Extracting page ${job.pages.indexOf(page) + 1} of ${job.pages.length}`;
    this.store.save(job);
    return { done: false, job_id: id, attempt, page_id: page.id, document_text: page.text };
  }
  result(id: string, attempt: string, pageId: string, raw: unknown, error?: string) {
    const job = this.requireActive(id, attempt),
      page = job.pages.find((p) => p.id === pageId);
    if (!page) throw Object.assign(new Error('Page not found.'), { statusCode: 404 });
    if (page.state === 'extracted' || page.state === 'error') return { job_id: id, attempt };
    if (page.state !== 'extracting')
      throw Object.assign(new Error('Page has not been claimed.'), { statusCode: 409 });
    try {
      if (error) throw new Error(error);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('AI returned invalid structured output.');
      const extraction = parsed as Extraction;
      // Prefer unambiguous printed fields. Items must reconcile with the printed
      // TOTAL; full source validation still runs before any order is saved.
      const printedItems = sourceItems(page.text);
      const printedDate = sourceDeliveryDate(page.text);
      const printedId = sourceOrderId(page.text);
      const printedRoute = sourceRoute(page.text);
      const printedPagination = sourcePagination(page.text);
      // A missing or conflicting printed destination must fail even if AI guesses one.
      const printedDestination = destination(page.text);
      page.extraction = {
        ...extraction,
        source_order_id: printedId ?? extraction.source_order_id,
        destination: printedDestination,
        route: printedRoute ?? extraction.route,
        ...(printedPagination ?? {}),
        items: printedItems ?? extraction.items,
        delivery_date: printedDate ?? extraction.delivery_date,
      };
      page.state = 'extracted';
      page.error = undefined;
    } catch (e) {
      page.state = 'error';
      page.error = e instanceof Error ? e.message : 'AI extraction failed.';
    }
    this.store.save(job);
    return { job_id: id, attempt };
  }
  requireActive(id: string, attempt: string) {
    const job = this.store.get(id);
    if (!job) throw Object.assign(new Error('Job not found.'), { statusCode: 404 });
    if (job.attempt !== attempt || job.state !== 'processing')
      throw Object.assign(new Error('Job is no longer active; callback rejected.'), { statusCode: 409 });
    return job;
  }
  async finish(job: Job, autoSavePerodua = true) {
    job.state = 'generating';
    job.stage = 'Preparing dispatch orders';
    this.store.save(job);
    if (autoSavePerodua) await this.saveExtractedPerodua(job);
    const { orders, errors } = assemble(job.pages.filter(page => !page.history_deleted));
    const results = jobResults(job, this.options.dataDir, errors);
    for (const file of job.files)
      if (file.error && !isPeroduaSetupNotice(file.error) && !file.history_deleted)
        results.push({
          id: file.id,
          order_id: file.filename,
          status: 'review',
          error: file.error,
          sources: [file.filename],
        });
    try {
      const changes = await this.ledger.ingest(orders);
      job.results = results;
      const successful = orders.length + results.filter(result => result.status === 'ready' || result.status === 'saved').length;
      const hasErrors = results.some(result => result.status === 'review');
      job.state = successful ? (hasErrors ? 'partial' : 'completed') : 'failed';
      const dates = changes.map((change) => change.date.split('-').reverse().join('/'));
      job.stage = orders.length
        ? `Orders saved for ${dates.join(', ')}. Mark each entry complete in Review when all POs have arrived.`
        : successful ? 'Perodua POs saved. Mark each entry complete in Review or Orders by date to download its Excel.' : 'Review required';
      job.error = undefined;
    } catch (error) {
      job.results = results;
      job.state = 'partial';
      job.stage = 'Some orders could not be saved. Retry this batch.';
      job.error = error instanceof Error ? error.message : String(error);
    }
    this.store.save(job);
  }
  async generateSavedPerodua(selection: { jobId?: string; keys?: string[]; serials: string[]; saveDate?: string; saveId?: string }) {
    this.assertDateIdle();
    this.busy = true;
    try {
      const root = path.resolve(this.options.dataDir) + path.sep;
      const selectedJob = selection.jobId ? this.store.get(selection.jobId) : undefined;
      if (selection.jobId && !selectedJob)
        throw Object.assign(new Error('Upload batch not found.'), { statusCode: 404 });
      const jsonPaths = selectedJob?.files.flatMap(file => file.perodua && !file.history_deleted ? [path.resolve(file.perodua.json_path)] : []);
      let targetId = selection.saveId ?? selectedJob?.perodua_entry_id;
      if (targetId) {
        const target = resolvePeroduaDate((await peroduaReview(this.options.dataDir, this.options.peroduaSettingsPath)).dates, targetId);
        if (!target) throw Object.assign(new Error('Saved Perodua batch not found.'), { statusCode: 404 });
        targetId = target.id;
      }
      if (jsonPaths?.some(file => !file.startsWith(root))) throw new Error('Invalid saved Perodua output path.');
      if (selectedJob && !jsonPaths?.length)
        throw Object.assign(new Error('This batch has no parsed Perodua POs.'), { statusCode: 400 });
      const result = await generatePerodua(this.options.dataDir, this.options.peroduaSettingsPath,
        { jsonPaths, keys: selection.keys, serials: selection.serials, saveDate: selection.saveDate ?? selectedJob?.perodua_date,
          saveId: targetId, batchId: selectedJob?.id });
      if (result.status !== 'ready' || !result.date)
        throw Object.assign(new Error(result.error ?? 'Perodua date could not be saved.'), { statusCode: 400 });
      let updated = 0;
      for (const entry of result.dates ?? [result.date]) updated += await this.syncPeroduaDate(entry, selectedJob?.id);
      return { ...result, updated_jobs: updated };
    } finally { this.busy = false; }
  }
  /** Save the current upload automatically; staff numbering fields stay blank. */
  private async saveExtractedPerodua(job: Job) {
    const pending = job.files.filter(file => !file.history_deleted && file.perodua && file.perodua.status !== 'ready');
    if (!pending.length) return;
    try {
      const result = await generatePerodua(this.options.dataDir, this.options.peroduaSettingsPath, {
        jsonPaths: pending.map(file => file.perodua!.json_path), serials: ['', '', ''],
        saveDate: job.perodua_date, saveId: job.perodua_entry_id, batchId: job.id,
      });
      if (result.status !== 'ready' || !result.date) throw new Error(result.error ?? 'Perodua POs could not be saved.');
      for (const date of result.dates ?? [result.date]) {
        const record = date.export_id ? await savedPeroduaExport(this.options.dataDir, date.export_id) : undefined;
        const keys = new Set(date.document_keys);
        // Also refresh older uploads when appending to a reopened entry.
        for (const related of [job, ...this.store.all().filter(other => other.id !== job.id)]) {
          let changed = false;
          for (const file of related.files) {
            const metadata = file.perodua;
            if (!metadata || file.history_deleted || !metadata.document_key || !keys.has(metadata.document_key)) continue;
            if (related.id === job.id ? !pending.includes(file) : metadata.entry_id !== date.id) continue;
            file.perodua = { ...metadata, status: 'ready', entry_id: date.id, save_date: date.date, date_status: date.status,
              export_id: record?.id, path: record?.path, filename: record?.filename,
              generated_date: record?.generated_date, created_at: record?.created_at,
              document_count: date.order_count, trip_count: date.trip_count, missing_trip_count: date.missing_trip_count, error: undefined };
            file.error = undefined; changed = true;
          }
          if (changed && related.id !== job.id) {
            related.results = jobResults(related, this.options.dataDir);
            this.store.save(related);
          }
        }
      }
    } catch (error) {
      for (const file of pending) file.error = error instanceof Error ? error.message : String(error);
    }
  }
  private assertDateIdle() {
    if (this.busy || this.clearing || this.store.all().some(job =>
      ['queued', 'reading', 'processing', 'generating'].includes(job.state)))
      throw Object.assign(new Error('Wait for document processing to finish.'), { statusCode: 409 });
  }
  async setPeroduaDate(date: string, complete: boolean) {
    this.assertDateIdle();
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(date)) throw Object.assign(new Error('Invalid saved date.'), { statusCode: 400 });
    this.busy = true;
    try {
      const target = resolvePeroduaDate((await peroduaReview(this.options.dataDir, this.options.peroduaSettingsPath)).dates, date);
      if (!target) throw Object.assign(new Error('Saved Perodua batch not found.'), { statusCode: 404 });
      const result = await changePeroduaDate(this.options.dataDir, this.options.peroduaSettingsPath, target.id, complete ? 'complete' : 'reopen');
      if (result.status !== 'ready' || !result.date)
        throw Object.assign(new Error(result.error ?? 'Perodua date could not be updated.'), { statusCode: 400 });
      await this.syncPeroduaDate(result.date);
      return result.date;
    } finally { this.busy = false; }
  }
  private async syncPeroduaDate(date: import('./perodua-history.ts').PeroduaSavedDate, selectedJobId?: string) {
    const record = date.export_id ? await savedPeroduaExport(this.options.dataDir, date.export_id) : undefined;
    const review = await peroduaReview(this.options.dataDir, this.options.peroduaSettingsPath);
    const root = path.resolve(this.options.dataDir) + path.sep;
    const keys = new Set(date.document_keys);
    let updated = 0;
    for (const job of this.store.all()) {
      let changed = false;
      for (const file of job.files) {
        if (!file.perodua || file.history_deleted) continue;
        const belongs = file.perodua.entry_id === date.id || !file.perodua.entry_id && date.id === date.date &&
          (file.perodua.save_date ?? file.perodua.generated_date) === date.date;
        if (!belongs && selectedJobId && job.id !== selectedJobId) continue;
        if (!belongs && !selectedJobId && file.perodua.status !== 'review') continue;
        let key = file.perodua.document_key;
        if (!key && path.resolve(file.perodua.json_path).startsWith(root)) {
          const data = JSON.parse(await fs.readFile(file.perodua.json_path, 'utf8'));
          key = review.documents.find(entry => entry.pido === data.PIDO &&
            entry.delivery_date === data.delivery_date && entry.delivery_time === data.delivery_time)?.key;
        }
        if (!key || !keys.has(key)) continue;
        file.perodua = { ...file.perodua, status: 'ready', document_key: key, entry_id: date.id, save_date: date.date, date_status: date.status,
          export_id: record?.id, path: record?.path, filename: record?.filename,
          generated_date: record?.generated_date, created_at: record?.created_at,
          document_count: date.order_count, trip_count: date.trip_count, missing_trip_count: date.missing_trip_count, error: undefined };
        file.error = undefined; changed = true;
      }
      if (changed) { await this.finish(job, false); updated++; }
    }
    return updated;
  }
  async deleteSavedDate(company: 'PERODUA' | 'TOYOTA', date: string) {
    this.assertDateIdle();
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(date)) throw Object.assign(new Error('Invalid saved date.'), { statusCode: 400 });
    this.busy = true; this.clearing = true;
    try {
      const removed = company === 'PERODUA' ? await deletePeroduaDate(this.options.dataDir, date) : undefined;
      const toyota = company === 'TOYOTA' ? await this.ledger.deleteDate(date) : undefined;
      const actualDate = removed?.date ?? toyota!.date;
      const protectedPages = new Set(this.store.allDates().flatMap(entry => entry.orders.flatMap(order => order.source_page_ids)));
      for (const job of this.store.all()) {
        let changed = false;
        if (company === 'TOYOTA') {
          for (const page of job.pages) {
            if (!page.history_deleted && (page.extraction?.delivery_date ?? sourceDeliveryDate(page.text)) === actualDate &&
                (toyota!.source_page_ids.includes(page.id) || toyota!.job_id === job.id || toyota!.id === actualDate && !protectedPages.has(page.id))) {
              page.history_deleted = true; changed = true;
            }
          }
        }
        for (const file of job.files) {
          if (file.history_deleted) continue;
          const metadata = file.perodua;
          const pages = job.pages.filter(page => page.file_id === file.id);
          const peroduaMatch = company === 'PERODUA' && metadata && (
            metadata.entry_id === removed!.id || !metadata.entry_id && removed!.id === actualDate && (metadata.save_date ?? metadata.generated_date) === actualDate ||
            !!metadata.document_key && removed!.removed_document_keys.includes(metadata.document_key) ||
            !!metadata.export_id && removed!.export_ids.includes(metadata.export_id));
          if (peroduaMatch || company === 'TOYOTA' && !metadata && pages.length && pages.every(page => page.history_deleted)) {
            file.history_deleted = true; changed = true;
          }
        }
        if (!changed) continue;
        const deletedFiles = new Set(job.files.filter(file => file.history_deleted).map(file => file.id));
        const deletedPages = new Set(job.pages.filter(page => page.history_deleted).map(page => page.id));
        job.results = jobResults(job, this.options.dataDir, job.results.filter(result =>
          !deletedFiles.has(result.id) && !result.source_page_ids?.some(id => deletedPages.has(id)) &&
          !(company === 'TOYOTA' && result.date === actualDate)));
        if (company === 'PERODUA' && (job.perodua_entry_id === removed!.id || !job.perodua_entry_id && job.perodua_date === actualDate)) { delete job.perodua_date; delete job.perodua_entry_id; }
        job.stage = 'Selected order history deleted.';
        if (!job.files.some(file => !file.history_deleted)) { job.state = 'completed'; job.error = undefined; }
        this.store.save(job);
      }
      return { ok: true, company, date };
    } finally { this.busy = false; this.clearing = false; }
  }

  retry(id: string) {
    const job = this.store.get(id);
    if (!job) throw Object.assign(new Error('Job not found.'), { statusCode: 404 });
    if (!['partial', 'failed', 'interrupted'].includes(job.state))
      throw Object.assign(new Error('This job cannot be retried now.'), { statusCode: 409 });
    const protectedPages = new Set(
      job.results.filter((r) => r.status === 'ready').flatMap((r) => r.source_page_ids ?? []),
    );
    for (const p of job.pages)
      if (!p.history_deleted && !protectedPages.has(p.id)) {
        p.state = 'pending';
        delete p.extraction;
        delete p.error;
      }
    job.results = job.results.filter((r) => r.status === 'ready');
    job.state = 'queued';
    job.stage = 'Queued for retry';
    job.error = undefined;
    job.attempt = randomUUID();
    this.store.save(job);
    return job;
  }
  async clearHistory() {
    if (this.busy || this.clearing || this.store.all().some((job) =>
      ['queued', 'reading', 'processing', 'generating'].includes(job.state)))
      throw Object.assign(new Error('Wait for current uploads to finish before clearing history.'), { statusCode: 409 });
    this.clearing = true;
    try {
      const result = await this.ledger.clearAll(this.store.all().map((job) => job.id));
      const localRoot = path.resolve(this.options.dataDir);
      const peroduaDir = path.resolve(localRoot, 'perodua');
      if (path.dirname(peroduaDir) !== localRoot) throw new Error('Invalid data folder.');
      await fs.rm(peroduaDir, { recursive: true, force: true });
      const taggingDir = path.resolve(localRoot, 'tagging');
      if (path.dirname(taggingDir) !== localRoot) throw new Error('Invalid data folder.');
      await fs.rm(taggingDir, { recursive: true, force: true });
      await fs.rm(path.join(localRoot, 'scans.jsonl'), { force: true });
      return result;
    } finally {
      this.clearing = false;
    }
  }
}
/** One current result for each Perodua saved date in this upload. */
function isPeroduaSetupNotice(error?: string) {
  return !!error && ['Save this PG PO to Orders by date to generate Excel.',
    'Confirm optional Perodua numbers to generate Excel.', 'Confirm optional PM numbers to generate Excel.'].includes(error);
}

export function jobResults(job: Job, dataDir: string, input: Result[] = job.results): Result[] {
  const peroduaIds = new Set(job.files.filter(file => file.perodua).map(file => file.id));
  const results = input.filter(result => !isPeroduaSetupNotice(result.error) && !result.id.startsWith('perodua-') &&
    !(['ready', 'saved'].includes(result.status) && peroduaIds.has(result.id)));
  const groups = new Map<string, typeof job.files>();
  for (const file of job.files.filter(file => !file.history_deleted && file.perodua?.status === 'ready')) {
    const key = file.perodua!.entry_id ?? file.perodua!.save_date ?? 'legacy';
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  for (const [date, files] of groups) {
    const latest = [...files].sort((a, b) => (b.perodua!.created_at ?? '').localeCompare(a.perodua!.created_at ?? ''))[0].perodua!;
    results.push({ id: groups.size === 1 ? 'perodua-combined' : `perodua-${date}`,
      status: latest.date_status === 'open' ? 'saved' : 'ready', order_id: 'Perodua saved date',
      date: latest.save_date ?? (date === 'legacy' ? undefined : date), order_count: latest.document_count ?? files.length,
      trip_count: latest.trip_count ?? 0, filename: latest.filename ?? 'Combined_Delivery.xlsx',
      path: latest.path ?? path.join(dataDir, 'perodua', 'Combined_Delivery.xlsx'),
      order_numbers: [...new Set(files.map(file => file.perodua!.pido))], sources: [...new Set(files.map(file => file.filename))] });
  }
  return results;
}

function peroduaMismatchType(error?: string) {
  return /^(?:Perodua extraction\/export failed:\s*)?Add only (PM_PK|PG|PM|PK) POs to this entry\. Use New batch for another prefix\.$/.exec(error?.trim() ?? '')?.[1];
}

export function publicJob(job: Job, dataDir = config.dataDir) {
  const terminal = ['completed', 'partial', 'failed', 'interrupted'].includes(job.state);
  const pages = job.pages.filter(page => !page.history_deleted);
  const done = pages.filter((p) => p.state === 'extracted' || p.state === 'error').length;
  const results = jobResults(job, dataDir);
  const currentType = terminal ? [...results.map(result => result.error),
    ...job.files.filter(file => !file.history_deleted).map(file => file.error)]
    .map(peroduaMismatchType).find(Boolean) : undefined;
  return {
    id: job.id,
    perodua_date: job.perodua_date,
    perodua_entry_id: job.perodua_entry_id,
    file_type_error: currentType ? { id: hash(`${job.id}:${job.attempt}:${currentType}`), current_type: currentType === 'PM_PK' ? 'PM & PK' : currentType,
      message: `Error: different files type, Current file: ${currentType === 'PM_PK' ? 'PM & PK' : currentType}` } : undefined,
    state: job.state,
    stage: job.stage,
    created_at: job.created_at,
    error: job.error,
    progress: terminal
      ? 100
      : job.state === 'generating'
        ? 95
        : job.state === 'processing'
          ? 10 + Math.floor((80 * done) / Math.max(pages.length, 1))
          : 0,
    pages_done: done,
    pages_total: pages.length,
    files: job.files.filter(file => !file.history_deleted).map(({ id, filename, size, error, duplicate, company, perodua }) => ({
      id,
      filename,
      size,
      duplicate,
      error: isPeroduaSetupNotice(error) || peroduaMismatchType(error) ? undefined : error,
      company: company ?? (perodua ? 'PERODUA' : undefined),
      perodua: perodua ? { status: perodua.status, pido: perodua.pido, document_key: perodua.document_key, entry_id: perodua.entry_id, save_date: perodua.save_date, date_status: perodua.date_status } : undefined,
    })),
    results: results.filter(result => !peroduaMismatchType(result.error)).map(({ path: _, source_page_ids: __, ...result }) => result),
  };
}
