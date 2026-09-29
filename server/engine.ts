import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { config } from './config.ts';
import { readPdf } from './pdf.ts';
import { assemble, hash, sourceDeliveryDate, sourceItems } from './mapping.ts';
import { DateLedger } from './dateLedger.ts';
import type { Job, Extraction } from './types.ts';
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
        if (file.duplicate || job.pages.some((p) => p.file_id === file.id)) continue;
        try {
          const texts = await readPdf(await fs.readFile(file.path), this.options.maxPages);
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
      // These rows have a fixed, printed layout. Use the source text when every
      // row and the printed TOTAL reconcile, instead of a model's misread digits.
      const printedItems = sourceItems(page.text);
      const printedDate = sourceDeliveryDate(page.text);
      page.extraction = {
        ...extraction,
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
  async finish(job: Job) {
    job.state = 'generating';
    job.stage = 'Preparing dispatch orders';
    this.store.save(job);
    const { orders, errors } = assemble(job.pages);
    const results = [...errors];
    for (const file of job.files)
      if (file.error)
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
      job.state = orders.length ? (results.length ? 'partial' : 'completed') : 'failed';
      const dates = changes.map((change) => change.date.split('-').reverse().join('/'));
      job.stage = orders.length
        ? `Orders saved for ${dates.join(', ')}. Mark each date complete below when all POs have arrived.`
        : 'Review required';
      job.error = undefined;
    } catch (error) {
      job.results = results;
      job.state = 'partial';
      job.stage = 'Some orders could not be saved. Retry this batch.';
      job.error = error instanceof Error ? error.message : String(error);
    }
    this.store.save(job);
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
      if (!protectedPages.has(p.id)) {
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
      return await this.ledger.clearAll(this.store.all().map((job) => job.id));
    } finally {
      this.clearing = false;
    }
  }
}
export function publicJob(job: Job) {
  const terminal = ['completed', 'partial', 'failed', 'interrupted'].includes(job.state);
  const done = job.pages.filter((p) => p.state === 'extracted' || p.state === 'error').length;
  return {
    id: job.id,
    state: job.state,
    stage: job.stage,
    created_at: job.created_at,
    error: job.error,
    progress: terminal
      ? 100
      : job.state === 'generating'
        ? 95
        : job.state === 'processing'
          ? 10 + Math.floor((80 * done) / Math.max(job.pages.length, 1))
          : 0,
    pages_done: done,
    pages_total: job.pages.length,
    files: job.files.map(({ id, filename, size, error, duplicate }) => ({
      id,
      filename,
      size,
      error,
      duplicate,
    })),
    results: job.results.map(({ path: _, source_page_ids: __, ...result }) => result),
  };
}
