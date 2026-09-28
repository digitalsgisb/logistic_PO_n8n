import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { config } from './config.ts';
import { readPdf } from './pdf.ts';
import { assemble, hash, sourceDeliveryDate, sourceItems } from './mapping.ts';
import { batchFilename, writeBatch } from './workbook.ts';
import type { Job, Extraction, Order } from './types.ts';
import { dispatchSession } from './dispatch.ts';
const running = new Set(['reading', 'processing', 'generating']);
export class Engine {
  busy = false;
  constructor(
    public store: Store,
    public options = config,
  ) {}
  recover() {
    for (const job of this.store.all())
      if (running.has(job.state)) {
        job.state = 'interrupted';
        job.stage = 'Processing interrupted. Retry to continue.';
        this.store.save(job);
      }
  }
  async tick() {
    if (this.busy) return;
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
    const session = dispatchSession(job.created_at, job.dispatch_shift);
    if (session.shift === 'evening') {
      job.results = results;
      job.state = orders.length ? (results.length ? 'partial' : 'completed') : 'failed';
      job.stage = orders.length
        ? 'Night orders saved for the next morning. No Excel download yet.'
        : 'Review required';
      job.error = undefined;
      this.store.save(job);
      return;
    }
    const byIdentity = new Map<string, Order>();
    const priorJobs = this.store.all()
      .filter((previous) => previous.id !== job.id && ['completed', 'partial'].includes(previous.state))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const previousMorningDate = priorJobs
      .filter((previous) => previous.results.some((result) => result.status === 'ready'))
      .map((previous) => dispatchSession(previous.created_at, previous.dispatch_shift))
      .filter((previous) => previous.shift === 'morning' && previous.date < session.date)
      .map((previous) => previous.date)
      .at(-1);
    const alreadyDispatched = new Set(priorJobs
      .filter((previous) => {
        const shift = dispatchSession(previous.created_at, previous.dispatch_shift);
        return shift.shift === 'morning' && shift.date < session.date;
      })
      .flatMap((previous) => previous.results
        .filter((result) => result.status === 'ready')
        .flatMap((result) => result.order_numbers ?? [])));
    const signature = (order: Order) => JSON.stringify({
      date: order.delivery_date, sequence: order.delivery_sequence, route: order.route,
      items: order.items, page_count: order.page_count,
    });
    const carriedEveningJobs: Job[] = [];
    for (const previous of priorJobs) {
      const shift = dispatchSession(previous.created_at, previous.dispatch_shift);
      const sameMorning = shift.shift === 'morning' && shift.date === session.date;
      const awaitingEvening = shift.shift === 'evening' && shift.date < session.date &&
        (!previousMorningDate || shift.date >= previousMorningDate);
      if (!sameMorning && !awaitingEvening) continue;
      const eligible = assemble(previous.pages).orders.filter((order) => !alreadyDispatched.has(order.kb_number));
      if (awaitingEvening && eligible.length) carriedEveningJobs.push(previous);
      for (const order of eligible)
        byIdentity.set(`${order.source_order_id}|${order.destination}`, order);
    }
    const freshOrders = orders.filter((order) => !alreadyDispatched.has(order.kb_number));
    if (orders.length && !freshOrders.length && !results.length) {
      job.results = [];
      job.state = 'completed';
      job.stage = 'These POs are already in an earlier morning Excel. Upload a new morning order to create the next Excel.';
      job.error = undefined;
      this.store.save(job);
      return;
    }
    for (const order of freshOrders) {
      const key = `${order.source_order_id}|${order.destination}`;
      const prior = byIdentity.get(key);
      if (prior && signature(prior) !== signature(order))
        results.push({
          id: `changed-${hash(key).slice(0, 16)}`,
          order_id: order.source_order_id,
          status: 'review',
          error: 'This PO differs from an earlier upload. The latest version is used in the new workbook; verify the change.',
          sources: order.source_pages,
        });
      byIdentity.set(key, order);
    }
    const combined = [...byIdentity.values()];
    if (freshOrders.length) {
      const date = session.date;
      const dailyOrders = combined;
      const id = `date-${date}`;
      const filename = batchFilename(dailyOrders, date),
        out = path.join(this.options.dataDir, job.id, filename),
        temporary = `${out}.${randomUUID()}.tmp`,
        sources = [...new Set(dailyOrders.flatMap((order) => order.source_pages))];
      try {
        // Always rebuild from validated orders; retry never adds onto an old output.
        await writeBatch(dailyOrders, this.options.template, temporary, date);
        await fs.rename(temporary, out);
        results.push({
          id,
          status: 'ready',
          order_id: `Toyota orders — ${date}`,
          order_count: dailyOrders.length,
          order_numbers: dailyOrders.map((order) => order.kb_number),
          destination: [...new Set(dailyOrders.map((order) => order.destination))].join(' / '),
          date,
          dates: [date],
          filename,
          path: out,
          sources,
          source_page_ids: dailyOrders.flatMap((order) => order.source_page_ids),
        });
      } catch (e) {
        results.push({
          id,
          status: 'review',
          order_id: `Toyota orders — ${date}`,
          date,
          error: e instanceof Error ? e.message : String(e),
          sources,
        });
      } finally {
        await fs.rm(temporary, { force: true });
      }
      job.results = results;
      this.store.save(job);
    }
    job.results = results;
    const successes = results.filter((r) => r.status === 'ready').length;
    job.state = successes ? (results.some((r) => r.status === 'review') ? 'partial' : 'completed') : 'failed';
    job.stage =
      job.state === 'completed'
        ? successes === 1
          ? 'Your daily workbook is ready'
          : 'Your daily workbooks are ready'
        : successes
          ? 'Completed with items to review'
          : 'Review required';
    job.error = undefined;
    this.store.save(job);
    if (successes) {
      const displayDate = session.date.split('-').reverse().join('/');
      for (const previous of carriedEveningJobs) {
        previous.stage = `Night orders included in the morning Excel dated ${displayDate}.`;
        this.store.save(previous);
      }
    }
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
}
export function publicJob(job: Job) {
  const terminal = ['completed', 'partial', 'failed', 'interrupted'].includes(job.state);
  const done = job.pages.filter((p) => p.state === 'extracted' || p.state === 'error').length;
  return {
    id: job.id,
    dispatch_shift: job.dispatch_shift,
    state: job.state,
    stage: job.stage.replace(/^Evening orders/, 'Night orders'),
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
