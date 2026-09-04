import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
type Result = {
  id: string;
  status: 'ready' | 'review';
  order_id: string;
  kb_number?: string;
  destination?: string;
  date?: string;
  dates?: string[];
  order_count?: number;
  order_numbers?: string[];
  filename?: string;
  error?: string;
  sources: string[];
};
type Job = {
  id: string;
  state: string;
  stage: string;
  progress: number;
  pages_done: number;
  pages_total: number;
  error?: string;
  results: Result[];
  files: { id: string; filename: string; size: number; duplicate?: boolean; error?: string }[];
};
const finished = new Set(['completed', 'partial', 'failed', 'interrupted']);
function Icon({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'upload' ? (
        <>
          <path d="M12 16V3m-5 5 5-5 5 5" />
          <path d="M4 15v5h16v-5" />
        </>
      ) : name === 'download' ? (
        <>
          <path d="M12 3v13m-5-5 5 5 5-5" />
          <path d="M4 16v5h16v-5" />
        </>
      ) : name === 'file' ? (
        <>
          <path d="M14 2H5v20h14V7z" />
          <path d="M14 2v6h5M8 13h8M8 17h5" />
        </>
      ) : name === 'check' ? (
        <path d="m5 12 4 4L19 6" />
      ) : name === 'arrow' ? (
        <path d="M3 12h18m-6-6 6 6-6 6" />
      ) : name === 'grid' ? (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6m0 4h.01" />
        </>
      )}
    </svg>
  );
}
async function api(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { 'X-Requested-With': 'ToyotaPO', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error ?? 'Request failed'), { status: response.status });
  return data;
}
function App() {
  const [session, setSession] = useState<{
      username: string;
      limits: { files: number; fileMb: number; batchMb: number };
    } | null>(null),
    [checking, setChecking] = useState(true),
    [files, setFiles] = useState<File[]>([]),
    [job, setJob] = useState<Job | null>(null),
    [error, setError] = useState(''),
    [upload, setUpload] = useState<number | null>(null),
    [drag, setDrag] = useState(false),
    [password, setPassword] = useState(''),
    [username, setUsername] = useState('pilot'),
    [loginBusy, setLoginBusy] = useState(false),
    [retryBusy, setRetryBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api('/api/session')
      .then(setSession)
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (!session) return;
    const id = localStorage.getItem('toyota_job');
    if (id)
      api('/api/jobs/' + id)
        .then(setJob)
        .catch((e) => {
          setError(e.message);
          if (e.status === 401) setSession(null);
          if (e.status === 404) localStorage.removeItem('toyota_job');
        });
  }, [session]);
  useEffect(() => {
    if (!session || !job || finished.has(job.state)) return;
    let live = true;
    const timer = setInterval(() => {
      api('/api/jobs/' + job.id)
        .then((j) => {
          if (live) {
            setJob(j);
            setError('');
          }
        })
        .catch((e) => {
          if (live) {
            setError(
              e.status === 401
                ? 'Your session expired. Sign in again to resume viewing this batch.'
                : e.message,
            );
            if (e.status === 401) setSession(null);
          }
        });
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [job?.id, job?.state, session]);
  const busy = upload !== null || (!!job && !finished.has(job.state));
  const add = (incoming: File[]) => {
    if (busy || job) return;
    setError('');
    const next = [...files];
    for (const f of incoming) {
      if (!/\.pdf$/i.test(f.name)) {
        setError('Please select PDF files only.');
        continue;
      }
      if (f.size > (session?.limits.fileMb ?? 20) * 1024 ** 2) {
        setError(`${f.name} exceeds the file size limit.`);
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified))
        next.push(f);
    }
    if (
      next.length > (session?.limits.files ?? 20) ||
      next.reduce((a, f) => a + f.size, 0) > (session?.limits.batchMb ?? 100) * 1024 ** 2
    ) {
      setError('This batch exceeds the upload limits. Remove some files.');
      return;
    }
    setFiles(next);
  };
  const submit = () => {
    if (!files.length || busy) return;
    setError('');
    setUpload(0);
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/jobs');
    xhr.setRequestHeader('X-Requested-With', 'ToyotaPO');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUpload(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUpload(null);
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status !== 202) throw new Error(data.error ?? 'Upload failed');
        setJob(data);
        localStorage.setItem('toyota_job', data.id);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    xhr.onerror = () => {
      setUpload(null);
      setError('Upload failed. Check your connection and try again.');
    };
    xhr.timeout = 120000;
    xhr.ontimeout = () => {
      setUpload(null);
      setError('Upload timed out. Please try again.');
    };
    xhr.send(form);
  };
  const ready = job?.results.filter((r) => r.status === 'ready') ?? [],
    review = job?.results.filter((r) => r.status === 'review') ?? [];
  const restart = () => {
    setJob(null);
    setFiles([]);
    setError('');
    localStorage.removeItem('toyota_job');
  };
  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginBusy(true);
    setError('');
    try {
      await api('/api/login', 'POST', { username, password });
      setPassword('');
      setSession(await api('/api/session'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  };
  if (checking) return <div className="loading-screen">Opening your workspace…</div>;
  if (!session)
    return (
      <div className="login-page">
        <div className="login-art">
          <div className="brand-mark">S</div>
          <p className="eyebrow">OPERATIONS WORKSPACE</p>
          <h1>
            Less paperwork.
            <br />
            More clarity.
          </h1>
          <p>Turn Toyota purchase orders into your daily kanban template.</p>
          <div className="login-line" />
        </div>
        <form className="login-form" onSubmit={login}>
          <span className="eyebrow teal">TOYOTA PO CONVERTER</span>
          <h2>Welcome back</h2>
          <p>Sign in to your internal workspace.</p>
          <label>
            Username
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary" disabled={loginBusy}>
            {loginBusy ? 'Signing in…' : 'Sign in'} <Icon name="arrow" size={18} />
          </button>
          <small>Private server · Toyota pilot</small>
        </form>
      </div>
    );
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Toyota PO Converter home">
          <span className="brand-mark small">S</span>
          <span>
            Operations<span className="brand-sub">DOCUMENT WORKSPACE</span>
          </span>
        </a>
        <div className="top-right">
          <span className="private-label">PRIVATE WORKSPACE</span>
          <span className="avatar">{session.username[0].toUpperCase()}</span>
          <button
            className="signout"
            onClick={async () => {
              try {
                await api('/api/logout', 'POST');
              } finally {
                setSession(null);
              }
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <aside className="sidebar">
        <p className="nav-label">WORKSPACE</p>
        <div className="nav-active">
          <Icon name="grid" />
          <span>PO Converter</span>
          <span className="nav-dot" />
        </div>
        <div className="sidebar-note">
          <div className="side-rule" />
          <span className="eyebrow">TOYOTA PILOT</span>
          <p>
            A simpler way to
            <br />
            prepare your orders.
          </p>
          <div className="plant-tags">
            <span>Shah Alam</span>
            <span>Bukit Raja</span>
          </div>
        </div>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          Local AI processing
        </div>
      </aside>
      <main>
        <div className="breadcrumb">
          Workspace <span>/</span> PO Converter
        </div>
        <div className="page-heading">
          <div>
            <div className="eyebrow teal">PURCHASE ORDERS, SIMPLIFIED</div>
            <h1>Toyota PO Converter</h1>
            <p>Upload your orders. Download one combined kanban workbook.</p>
          </div>
          <span className="pilot-pill">
            TOYOTA <span>PILOT</span>
          </span>
        </div>
        <div className="steps">
          <span className="step">
            <b>01</b> Upload PDFs
          </span>
          <span className="step-line" />
          <span className="step">
            <b>02</b> Convert orders
          </span>
          <span className="step-line" />
          <span className="step">
            <b>03</b> Download workbook
          </span>
        </div>
        {error && (
          <div className="error global-error" role="alert">
            {error}
          </div>
        )}
        <div className="converter">
          <section className="panel">
            <div className="panel-heading">
              <span className="panel-number">01</span>
              <h2>Your purchase orders</h2>
              <span className="file-count">{job ? job.files.length : files.length} files</span>
            </div>
            <div
              className={'dropzone corner-frame ' + (drag ? 'dragging' : '')}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                add(Array.from(e.dataTransfer.files));
              }}
            >
              <div className="upload-icon">
                <Icon name="upload" size={32} />
              </div>
              <h3>{job ? 'Your files are uploaded' : 'Drop your PDFs here'}</h3>
              <p>
                {job ? 'All orders go into one combined workbook.' : 'or choose files from your computer'}
              </p>
              <button className="outline" disabled={busy || !!job} onClick={() => input.current?.click()}>
                Browse files
              </button>
              <input
                ref={input}
                type="file"
                accept=".pdf,application/pdf"
                multiple
                hidden
                onChange={(e) => {
                  add(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <small>
                PDF only · Up to {session.limits.files} files · {session.limits.fileMb} MB per file
              </small>
            </div>
            <div className="file-list">
              {(job ? job.files : files).map((f, i) => (
                <div className="file-row" key={i}>
                  <span className="pdf-icon">
                    <Icon name="file" size={20} />
                  </span>
                  <div className="file-info">
                    <strong title={'filename' in f ? f.filename : f.name}>
                      {'filename' in f ? f.filename : f.name}
                    </strong>
                    <small>
                      {Math.max(1, Math.round(f.size / 1024))} KB
                      {'duplicate' in f && f.duplicate ? ' · Duplicate skipped' : ''}
                    </small>
                  </div>
                  {!job && (
                    <button
                      aria-label={`Remove ${(f as File).name}`}
                      className="remove"
                      onClick={() => setFiles(files.filter((_, n) => n !== i))}
                    >
                      ×
                    </button>
                  )}
                  {job && <Icon name="check" size={17} />}
                </div>
              ))}
            </div>
            {!job ? (
              <button className="primary submit" disabled={!files.length || busy} onClick={submit}>
                {upload !== null ? `Uploading ${upload}%` : 'Submit for conversion'}
                <Icon name="arrow" size={19} />
              </button>
            ) : (
              <button className="outline full" disabled={busy} onClick={restart}>
                Start new batch
              </button>
            )}
            <div className="panel-foot">
              <Icon name="file" size={15} />
              <span>Original documents stay unchanged.</span>
            </div>
          </section>
          <div className="flow-arrow">
            <Icon name="arrow" size={30} />
          </div>
          <section className="panel output-panel">
            <div className="panel-heading">
              <span className="panel-number">02</span>
              <h2>Your combined workbook</h2>
              <span className="file-count">{ready.length} ready</span>
            </div>
            {!job || (!finished.has(job.state) && !job.results.length) ? (
              <div className="output-placeholder corner-frame">
                <div className={'output-icon ' + (busy ? 'processing' : '')}>
                  <Icon name={busy ? 'grid' : 'file'} size={36} />
                </div>
                <h3>{busy ? 'Preparing your workbook' : 'Ready when you are'}</h3>
                <p>
                  {busy
                    ? 'We’re reading and checking each order.'
                    : 'Your combined Excel workbook will appear here.'}
                </p>
                <span className="xlsx-chip">XLSX</span>
              </div>
            ) : (
              <div className="results" aria-live="polite">
                {job.results.map((r) => (
                  <div className={'result ' + r.status} key={r.id}>
                    <span className="result-icon">
                      <Icon name={r.status === 'ready' ? 'file' : 'info'} />
                    </span>
                    <div className="result-info">
                      <strong>
                        {r.order_count ? 'Combined Toyota orders' : (r.kb_number ?? r.order_id)}
                      </strong>
                      {r.status === 'ready' ? (
                        <small>
                          {r.order_count ? `${r.order_count} orders · ` : ''}
                          {(r.dates ?? (r.date ? [r.date] : []))
                            .map((date) => date.split('-').reverse().join('/'))
                            .join(', ')}
                        </small>
                      ) : (
                        <p>{r.error}</p>
                      )}
                      {r.order_numbers && (
                        <small title={r.order_numbers.join('\n')}>{r.order_numbers.join(', ')}</small>
                      )}
                      <small title={r.sources.join('\n')}>{r.sources.join(', ')}</small>
                    </div>
                    {r.status === 'ready' && (
                      <a
                        className="download-one"
                        href={`/api/jobs/${job.id}/outputs/${r.id}`}
                        aria-label={`Download ${r.order_count ? 'combined workbook' : (r.kb_number ?? r.order_id)}`}
                      >
                        <Icon name="download" size={20} />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
            {(busy || job) && (
              <div className="progress-area" aria-live="polite">
                <div>
                  <strong>{upload !== null ? 'Uploading documents' : job?.stage}</strong>
                  <span>{upload !== null ? upload : job?.progress}%</span>
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-valuenow={upload ?? job?.progress ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Conversion progress"
                >
                  <span style={{ width: `${upload ?? job?.progress ?? 0}%` }} />
                </div>
                {job?.error && <p className="processing-error">{job.error}</p>}
              </div>
            )}
            {ready.length === 1 && (
              <a className="primary download-all" href={`/api/jobs/${job!.id}/outputs/${ready[0].id}`}>
                <Icon name="download" size={18} />
                {job?.state === 'partial' ? 'Download workbook (valid orders)' : 'Download Excel workbook'}
              </a>
            )}
            {ready.length > 1 && (
              <a className="primary download-all" href={`/api/jobs/${job!.id}/download-all`}>
                <Icon name="download" size={18} />
                Download all ZIP <span>{ready.length}</span>
              </a>
            )}
            {job && ['partial', 'failed', 'interrupted'].includes(job.state) && (
              <button
                className="outline full"
                disabled={retryBusy}
                onClick={async () => {
                  setRetryBusy(true);
                  try {
                    setJob(await api(`/api/jobs/${job.id}/retry`, 'POST'));
                    setError('');
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setRetryBusy(false);
                  }
                }}
              >
                {retryBusy ? 'Queuing…' : 'Retry unsuccessful orders'}
              </button>
            )}
            <div className="panel-foot">
              <Icon name="check" size={15} />
              <span>One workbook per batch · PO numbers in Remarks</span>
            </div>
          </section>
        </div>
        <footer className="main-footer">
          <span>
            <Icon name="info" size={15} /> Use original, text-based Toyota PDFs. Scanned copies aren’t
            supported yet.
          </span>
          <span>Files available for 7 days</span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
