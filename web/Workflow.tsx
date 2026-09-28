import React, { useEffect, useState } from 'react';
import { Tagging } from './Tagging';
import { ExcelDownload } from './ExcelDownload';
type Result = {
  id: string;
  status: string;
  date?: string;
  order_count?: number;
  order_numbers?: string[];
  order_id: string;
  error?: string;
};
type Job = {
  id: string;
  dispatch_shift?: 'morning' | 'evening';
  state: string;
  stage: string;
  progress: number;
  results: Result[];
  files: { filename: string }[];
};
export function Workflow({
  files,
  job,
  busy,
  error,
  add,
  remove,
  submit,
  restart,
  retry,
  maxMb,
}: {
  files: File[];
  job: Job | null;
  busy: boolean;
  error: string;
  add: (f: File[]) => void;
  remove: (i: number) => void;
  submit: (shift: 'morning' | 'evening') => void;
  restart: () => void;
  retry: () => void;
  maxMb: number;
}) {
  const [mode, setMode] = useState('both'),
    [dispatchShift, setDispatchShift] = useState<'morning' | 'evening' | null>(null),
    [tag, setTag] = useState<File>(),
    [started, setStarted] = useState(false),
    [step, setStep] = useState(1),
    [localError, setLocalError] = useState('');
  const active = started || !!job;
  useEffect(() => {
    if (job) setStep(2);
  }, [job?.id]);
  const done = !!job && ['completed', 'partial', 'failed', 'interrupted'].includes(job.state);
  const ready = job?.results.filter((r) => r.status === 'ready') ?? [];
  const canReview = mode === 'tags' ? started : done;
  const workbooks = ready.map((r) => ({ ...r, href: `/api/jobs/${job!.id}/outputs/${r.id}` }));
  function selectTag(incoming: File[]) {
    if (
      incoming.length !== 1 ||
      !incoming[0].name.toLowerCase().endsWith('.pdf') ||
      incoming[0].size > maxMb * 1024 ** 2
    ) {
      setLocalError(`Choose one tagging PDF up to ${maxMb} MB.`);
      return;
    }
    setTag(incoming[0]);
    setLocalError('');
  }
  function start() {
    if (mode !== 'tags' && !dispatchShift) {
      setLocalError('Choose Morning or Night before processing your POs.');
      return;
    }
    setStarted(true);
    setStep(2);
    if (mode !== 'tags') submit(dispatchShift!);
    requestAnimationFrame(() =>
      document.getElementById('workflow-review')?.scrollIntoView({ block: 'start' }),
    );
  }
  function reset() {
    restart();
    setStarted(false);
    setTag(undefined);
    setDispatchShift(null);
    setStep(1);
    setLocalError('');
  }
  return (
    <>
      <div className="page-heading" id="po-converter">
        <div>
          <div className="eyebrow teal">DAILY LOGISTICS</div>
          <h1>Logistic Digital</h1>
          <p>Upload documents, check your quantities, and print your rack tags.</p>
        </div>
        {active && (
          <button className="outline" disabled={busy} onClick={reset}>
            New batch
          </button>
        )}
      </div>
      <nav className="workflow-progress" aria-label="Dispatch progress">
        {['Upload', 'Review', 'Print'].map((label, i) => (
          <a
            key={label}
            href={['#workflow-upload', '#workflow-review', '#tag-print-review'][i]}
            aria-current={step === i + 1 ? 'step' : undefined}
          >
            <b>{i + 1}</b>
            {label}
            {i === 2 && mode === 'po' ? ' (not needed)' : ''}
          </a>
        ))}
        <span>
          {busy
            ? (job?.stage ?? 'Uploading…')
            : active
              ? 'Your documents stay together'
              : 'Start with your documents'}
        </span>
      </nav>
      {(error || localError) && (
        <p className="error" role="alert">
          {error || localError}
        </p>
      )}
      <details className="workflow-upload" id="workflow-upload" open={!active || !!error || !!localError}>
        <summary>
          <strong>1. Documents</strong>
          <span>
            {active
              ? `${job?.files.length ?? files.length} PO file(s) · ${tag?.name ?? 'No tagging PDF selected'}`
              : 'Choose your task and add PDFs'}
          </span>
        </summary>
        <div className="workflow-modes" role="group" aria-label="Task type">
          {[
            ['both', 'PO + tagging'],
            ['po', 'PO only'],
            ['tags', 'Tagging only'],
          ].map(([value, label]) => (
            <button
              className={mode === value ? 'selected' : ''}
              aria-pressed={mode === value}
              disabled={active || busy}
              key={value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="workflow-drop-grid">
          {mode !== 'tags' && (
            <div
              className="workflow-drop"
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add('dragging');
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove('dragging')}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('dragging');
                if (!active) add(Array.from(e.dataTransfer.files));
              }}
            >
              <h3>Purchase orders</h3>
              <p>Drop PO PDFs here or browse</p>
              <input
                aria-label="Purchase order PDFs"
                type="file"
                accept=".pdf"
                multiple
                disabled={active || busy}
                onChange={(e) => {
                  add(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              {(job ? job.files : files).map((f, i) => (
                <div className="workflow-file" key={i}>
                  <span>{'filename' in f ? f.filename : f.name}</span>
                  {!active && (
                    <button
                      aria-label={`Remove ${'name' in f ? f.name : f.filename}`}
                      onClick={() => remove(i)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {mode !== 'po' && (
            <div
              className="workflow-drop"
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add('dragging');
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove('dragging')}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('dragging');
                if (!busy) selectTag(Array.from(e.dataTransfer.files));
              }}
            >
              <h3>Rack tagging</h3>
              <p>Drop one tagging PDF here or browse</p>
              <input
                aria-label="Upload rack-tagging PDF"
                type="file"
                accept=".pdf"
                disabled={busy}
                onChange={(e) => {
                  selectTag(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              {tag && (
                <div className="workflow-file">
                  <span>{tag.name}</span>
                  <button aria-label="Remove tagging PDF" disabled={active} onClick={() => setTag(undefined)}>
                    ×
                  </button>
                </div>
              )}
              <small>
                {mode === 'both'
                  ? 'We’ll check copies against your POs automatically.'
                  : 'You’ll verify copies against your PO before printing.'}
              </small>
            </div>
          )}
        </div>
        {mode !== 'tags' && (
          <section className="dispatch-shift-picker" aria-labelledby="dispatch-shift-title">
            <h3 id="dispatch-shift-title">Which order batch is this?</h3>
            <p>Choose the batch you are handling. The choice does not depend on the time you upload.</p>
            <div role="group" aria-label="Order batch">
              {([
                ['morning', 'Morning order', 'Create today’s Excel with saved night orders.'],
                ['evening', 'Night order', 'Save these POs for the next morning. No Excel yet.'],
              ] as const).map(([value, title, description]) => (
                <button
                  type="button"
                  key={value}
                  className={(job?.dispatch_shift ?? dispatchShift) === value ? 'selected' : ''}
                  aria-pressed={(job?.dispatch_shift ?? dispatchShift) === value}
                  disabled={active || busy}
                  onClick={() => { setDispatchShift(value); setLocalError(''); }}
                >
                  <strong>{title}</strong>
                  <small>{description}</small>
                </button>
              ))}
            </div>
          </section>
        )}
        {!active && (
          <button
            className="primary"
            disabled={busy || (mode !== 'tags' && (!files.length || !dispatchShift)) || (mode !== 'po' && !tag)}
            onClick={start}
          >
            Process documents →
          </button>
        )}
        {active && !job && mode !== 'tags' && !busy && (
          <button className="primary" onClick={() => dispatchShift && submit(dispatchShift)}>
            Retry upload
          </button>
        )}
      </details>
      <section className="workflow-review" id="workflow-review">
        <h2>2. Review your dispatch</h2>
        {!!workbooks.length && (
          <section className="kanban-download-card" aria-labelledby="kanban-download-title">
            <div className="kanban-card-heading">
              <span className="kanban-card-icon" aria-hidden="true">
                X<span>▦</span>
              </span>
              <div>
                <span className="kanban-card-eyebrow">EXCEL WORKBOOK · READY</span>
                <h3 id="kanban-download-title">Download your Kanban Excel</h3>
                <p>Your daily Kanban sheet is ready. Download it here, then open Excel to print.</p>
              </div>
            </div>
            <div className="workflow-workbooks">
              {workbooks.map((r) => (
                <ExcelDownload href={r.href} key={r.id} date={r.date} orders={r.order_count} />
              ))}
            </div>
            {ready.length > 1 && (
              <a className="kanban-download-all" href={`/api/jobs/${job!.id}/download-all`}>
                Download all {ready.length} workbooks as ZIP ↓
              </a>
            )}
            <p className="kanban-card-note">Dated to the morning upload · Includes saved night orders · Previously dispatched POs are counted once · A4 landscape</p>
          </section>
        )}
        {done && !ready.length && (job!.stage.startsWith('Night orders saved') || job!.stage.startsWith('Evening orders saved')) && (
          <div className="dispatch-waiting-note" role="status">
            <strong>Night orders saved</strong>
            <p>No Excel download yet. The next morning upload will combine these orders into one Excel dated that morning.</p>
            <p>You can review and print rack tags now.</p>
          </div>
        )}
        {done && !ready.length && (job!.stage.startsWith('Night orders included') || job!.stage.startsWith('Evening orders included')) && (
          <div className="dispatch-waiting-note" role="status">
            <strong>Included in the morning Excel</strong>
            <p>{job!.stage.replace(/^Evening orders/, 'Night orders')} Open the morning batch to download the combined Excel.</p>
          </div>
        )}
        {done && !ready.length && job!.stage.startsWith('These POs are already') && (
          <div className="dispatch-waiting-note" role="status">
            <strong>These POs were already dispatched</strong>
            <p>They are in an earlier morning Excel, so no duplicate Excel was created. Upload a new morning order to prepare the next one.</p>
          </div>
        )}
        {!active ? (
          <p>Your daily workbooks and rack quantities will appear here.</p>
        ) : busy ? (
          <div role="status">
            <p>{job?.stage ?? 'Uploading your POs…'}</p>
            <progress max="100" value={job?.progress ?? 0} />
            <p>Your tagging PDF is queued and will be checked when PO processing finishes.</p>
          </div>
        ) : null}
        {job?.results
          .filter((r) => r.status === 'review')
          .map((r) => (
            <p className="tag-warning" key={r.id}>
              {r.order_id}: {r.error}
            </p>
          ))}
        {done && ['partial', 'failed', 'interrupted'].includes(job!.state) && (
          <button className="outline" onClick={retry}>
            Retry unsuccessful POs
          </button>
        )}
        {canReview && mode !== 'po' && !tag && (
          <p className="tag-warning">
            Open Documents above and add your tagging PDF to continue. Files selected in the browser need to
            be selected again after a refresh.
          </p>
        )}
      </section>
      {canReview && mode !== 'po' && tag && (
        <Tagging
          key={`${job?.id ?? 'standalone'}-${job?.state ?? ''}`}
          jobId={done ? job!.id : undefined}
          maxMb={maxMb}
          sourceFile={tag}
          guided
          workbooks={workbooks}
          onStage={setStep}
        />
      )}
    </>
  );
}
