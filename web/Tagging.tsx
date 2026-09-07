import React, { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

type Page = {
  page: number;
  kind: string;
  place: string;
  sequence: string;
  copies: number;
  lines: { code: string; racks: number; tagRacks?: number; multiplier: number; copies: number }[];
  notes: string[];
  matchedOrders: string[];
};

export function Tagging({ jobId, maxMb }: { jobId?: string; maxMb: number }) {
  const [pages, setPages] = useState<Page[]>([]),
    [previews, setPreviews] = useState<string[]>([]);
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const [approved, setApproved] = useState(false),
    [printImages, setPrintImages] = useState<string[]>([]);
  const [prepared, setPrepared] = useState(false);
  const document = useRef<PDFDocumentProxy | null>(null);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
      void document.current?.loadingTask.destroy();
    },
    [],
  );
  useEffect(() => {
    const done = () => window.document.body.classList.remove('printing-tags');
    window.addEventListener('afterprint', done);
    return () => {
      window.removeEventListener('afterprint', done);
      done();
    };
  }, []);
  async function render(pdf: PDFDocumentProxy, n: number, scale: number) {
    const page = await pdf.getPage(n);
    const original = page.getViewport({ scale });
    const viewport = page.getViewport({
      scale: scale * Math.min(1, 2400 / Math.max(original.width, original.height)),
    });
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d')!, canvas, viewport }).promise;
    return canvas.toDataURL('image/png');
  }
  async function upload(file?: File) {
    if (!file) return;
    setError('');
    setApproved(false);
    setPrepared(false);
    setPrintImages([]);
    setPages([]);
    setPreviews([]);
    if (!/\.pdf$/i.test(file.name) || file.size > maxMb * 1024 ** 2) {
      setError(`Choose a PDF up to ${maxMb} MB.`);
      return;
    }
    const current = ++request.current;
    setBusy('Reading your tagging PDF…');
    setName(file.name);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(`/api/tagging/review${jobId ? `?job=${encodeURIComponent(jobId)}` : ''}`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'ToyotaPO' },
        body: form,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await document.current?.loadingTask.destroy();
      const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
      GlobalWorkerOptions.workerSrc = workerUrl;
      const pdf = await getDocument({ data: await file.arrayBuffer() }).promise;
      if (current !== request.current) {
        await pdf.loadingTask.destroy();
        return;
      }
      document.current = pdf;
      setPages(result.pages);
      const images = [];
      for (let n = 1; n <= pdf.numPages; n++) images.push(await render(pdf, n, 0.65));
      if (current === request.current) setPreviews(images);
    } catch (e) {
      if (current === request.current) {
        setError((e as Error).message);
        setPages([]);
      }
    } finally {
      if (current === request.current) setBusy('');
    }
  }
  const total = pages.reduce((sum, p) => sum + p.copies, 0);
  const valid =
    pages.length > 0 &&
    pages.every(
      (p) => p.kind !== 'unknown' && Number.isInteger(p.copies) && p.copies >= 0 && p.copies <= 500,
    ) &&
    total > 0 &&
    total <= 1000;
  function update(index: number, change: Partial<Page>) {
    setPages((old) => old.map((p, i) => (i === index ? { ...p, ...change } : p)));
    setApproved(false);
    setPrepared(false);
    setPrintImages([]);
  }
  async function prepare() {
    if (!approved || !valid || !document.current) return;
    setBusy('Preparing print pages…');
    setError('');
    try {
      const images = [];
      for (const page of pages)
        images.push(page.copies ? await render(document.current, page.page, 2.5) : '');
      setPrintImages(images);
      setPrepared(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function print() {
    if (!approved || !valid || !prepared) return;
    setError('');
    try {
      await Promise.all(
        Array.from(window.document.querySelectorAll<HTMLImageElement>('.tag-print-sheet img')).map((img) =>
          img.decode(),
        ),
      );
      window.document.body.classList.add('printing-tags');
      window.print();
    } catch {
      window.document.body.classList.remove('printing-tags');
      setError('Print preview could not open. Please try again.');
    }
  }
  return (
    <section className="tagging-panel" id="rack-tagging">
      <div className="tag-heading">
        <div>
          <div className="eyebrow teal">RACK TAGGING</div>
          <h2>Review. Confirm. Print.</h2>
          <p>Small-tag pages print once. Large rack pages use the copies calculated below.</p>
        </div>
        <span className="xlsx-chip">PDF → PRINT</span>
      </div>
      <label className="tag-upload">
        {' '}
        <strong>{name || 'Upload rack-tagging PDF'}</strong>
        <span>
          {name ? 'Replace PDF' : 'Choose PDF'} · up to {maxMb} MB
        </span>
        <input
          aria-label="Upload rack-tagging PDF"
          type="file"
          accept=".pdf,application/pdf"
          disabled={!!busy}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
          }}
        />
      </label>
      <p className="tag-hint">
        {jobId
          ? 'Matching tags against the validated POs in this batch.'
          : 'You can prepare tags separately. Upload and convert POs first to cross-check rack quantities.'}
      </p>
      {busy && <p role="status">{busy}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!!pages.length && (
        <>
          <div className="tag-summary">
            <div>
              <strong>{pages.length}</strong>
              <span>Source pages</span>
            </div>
            <div>
              <strong>{pages.filter((p) => p.kind === 'small').reduce((n, p) => n + p.copies, 0)}</strong>
              <span>Small-tag sheets</span>
            </div>
            <div>
              <strong>{pages.filter((p) => p.kind === 'rack').reduce((n, p) => n + p.copies, 0)}</strong>
              <span>Rack sheets</span>
            </div>
            <div>
              <strong>{total}</strong>
              <span>Total printed pages</span>
            </div>
          </div>
          <div className="tag-pages">
            {pages.map((p, i) => (
              <article className="tag-card" key={p.page}>
                <div className="tag-preview">
                  {previews[i] ? (
                    <img src={previews[i]} alt={`Source tagging page ${p.page}`} />
                  ) : (
                    <span>Loading preview…</span>
                  )}
                </div>
                <div className="tag-card-body">
                  <h3>
                    Page {p.page}{' '}
                    <span>
                      {p.kind === 'rack' ? 'Rack cover' : p.kind === 'small' ? 'Small tags' : 'Needs review'}
                    </span>
                  </h3>
                  <p>
                    {p.place || 'Check destination'} ·{' '}
                    {p.sequence
                      ? `${p.sequence.slice(6, 8)}/${p.sequence.slice(4, 6)}/${p.sequence.slice(0, 4)} · Trip ${Number(p.sequence.slice(-2))}`
                      : 'Check date / trip'}
                  </p>
                  {!!p.lines.length && (
                    <table>
                      <thead>
                        <tr>
                          <th>Part</th>
                          <th>{p.matchedOrders.length ? 'PO racks' : 'Racks'}</th>
                          {!!p.matchedOrders.length && <th>Tags found</th>}
                          <th>Tags/rack</th>
                          <th>Copies</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.lines.map((l) => (
                          <tr key={l.code}>
                            <td>{l.code}</td>
                            <td>{l.racks}</td>
                            {!!p.matchedOrders.length && <td>{l.tagRacks}</td>}
                            <td>{l.multiplier}</td>
                            <td>{l.copies}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {!!p.matchedOrders.length && (
                    <p className="tag-match">Matched: {p.matchedOrders.join(', ')}</p>
                  )}
                  {p.notes.map((note) => (
                    <p className="tag-warning" key={note}>
                      {note}
                    </p>
                  ))}
                  <div className="tag-controls">
                    <label>
                      Page type
                      <select
                        value={p.kind}
                        disabled={!!busy}
                        onChange={(e) => update(i, { kind: e.target.value })}
                      >
                        <option value="unknown">Select type</option>
                        <option value="small">Small tags</option>
                        <option value="rack">Large rack page</option>
                      </select>
                    </label>
                    <label>
                      Copies
                      <input
                        aria-label={`Copies for page ${p.page}`}
                        type="number"
                        min="0"
                        max="500"
                        value={p.copies}
                        disabled={!!busy}
                        onChange={(e) =>
                          update(i, { copies: e.target.value === '' ? 0 : Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <small>Set 0 to exclude a page. Verify changes against the PO.</small>
                </div>
              </article>
            ))}
          </div>
          <div className="tag-confirm">
            <h3>Print with your Windows printer</h3>
            <p>
              Next, choose your printer, paper size, colour and other settings in the browser print dialog.
              Use <strong>Copies: 1</strong>, <strong>single-sided</strong>, and turn off headers and
              footers—the repeated rack pages are already included.
            </p>
            <label className="tag-check">
              <input
                type="checkbox"
                checked={approved}
                disabled={!!busy || !valid}
                onChange={(e) => {
                  setApproved(e.target.checked);
                  setPrepared(false);
                }}
              />
              I checked all pages, rack quantities, copy counts and review notes.
            </label>
            {!valid && (
              <p className="tag-warning">
                Choose every page type and a total of 1–1,000 pages, with up to 500 copies per source page.
              </p>
            )}
            {!prepared ? (
              <button
                className="primary"
                disabled={!approved || !valid || !!busy}
                onClick={() => void prepare()}
              >
                Confirm & prepare {total} pages
              </button>
            ) : (
              <button className="primary" onClick={() => void print()}>
                Choose printer & print {total} pages
              </button>
            )}
            {prepared && (
              <p role="status">
                Ready for print preview. Nothing is sent to a printer until you confirm in the print dialog.
              </p>
            )}
          </div>
        </>
      )}
      <div className="tag-print-output" aria-hidden="true">
        {prepared &&
          pages.flatMap((p, i) =>
            Array.from({ length: p.copies }, (_, copy) => (
              <div className="tag-print-sheet" key={`${i}-${copy}`}>
                <img src={printImages[i]} alt="" />
              </div>
            )),
          )}
      </div>
    </section>
  );
}
