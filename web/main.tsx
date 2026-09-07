import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import companyLogo from './assets/sugihara-logo.png';
import { Workflow } from './Workflow';

function CompanyLogo() {
  return <img className="company-logo" src={companyLogo} alt="Sugihara Grand Industries Sdn Bhd" />;
}

function UnitMark() {
  return (
    <div className="unit-mark">
      <span className="copyright-mark" aria-hidden="true">
        ©
      </span>
      <span>Digital Transformation Unit</span>
    </div>
  );
}
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
    [password, setPassword] = useState(''),
    [username, setUsername] = useState('pilot'),
    [loginBusy, setLoginBusy] = useState(false),
    [retryBusy, setRetryBusy] = useState(false);
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
          <CompanyLogo />
          <p className="eyebrow">OPERATIONS WORKSPACE</p>
          <h1>
            Less paperwork.
            <br />
            More clarity.
          </h1>
          <p>Prepare your daily orders, kanban workbooks and rack tags in one workspace.</p>
          <div className="login-line" />
          <UnitMark />
        </div>
        <form className="login-form" onSubmit={login}>
          <span className="eyebrow teal">LOGISTIC DIGITAL</span>
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
          <small>Private workspace · Logistic Digital</small>
        </form>
      </div>
    );
  return (
    <div className="app">
      <header className="topbar">
        <a className="mobile-brand" href="/" aria-label="Logistic Digital home">
          <CompanyLogo />
        </a>
        <nav className="header-context" aria-label="Breadcrumb">
          <span>Workspace</span>
          <Icon name="arrow" size={15} />
          <strong>Logistic Digital</strong>
        </nav>
        <div className="top-right">
          <span className="private-label">{session.username}</span>
          <span className="avatar" aria-label={`Signed in as ${session.username}`}>
            {session.username[0].toUpperCase()}
          </span>
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
        <a className="brand" href="/" aria-label="Logistic Digital home">
          <CompanyLogo />
          <span className="brand-workspace">
            Logistic Digital<span className="brand-sub">LOGISTICS DOCUMENT WORKSPACE</span>
          </span>
        </a>
        <p className="nav-label">WORKSPACE</p>
        <a className="nav-active" href="#workflow-upload">
          <Icon name="grid" />
          <span>Daily dispatch</span>
          <span className="nav-dot" />
        </a>
        <a className="nav-active tag-nav" href="#workflow-review">
          <Icon name="file" />
          <span>Review & print</span>
        </a>
        <div className="sidebar-note">
          <div className="side-rule" />
          <span className="eyebrow">LOGISTIC DIGITAL</span>
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
          <div className="processing-label">
            <span className="status-dot" />
            Local AI processing
          </div>
          <UnitMark />
        </div>
      </aside>
      <main>
        <Workflow
          files={files}
          job={job}
          busy={busy || retryBusy}
          error={error}
          add={add}
          remove={(i) => setFiles(files.filter((_, n) => n !== i))}
          submit={submit}
          restart={restart}
          maxMb={session.limits.fileMb}
          retry={async () => {
            setRetryBusy(true);
            try {
              setJob(await api('/api/jobs/' + job!.id + '/retry', 'POST'));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setRetryBusy(false);
            }
          }}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
