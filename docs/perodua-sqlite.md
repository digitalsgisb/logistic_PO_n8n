# Production Perodua integration

The main application keeps its SQLite database, accounts, persistent sessions and
Toyota n8n/Ollama processing. Toyota's existing `dispatch_dates` schema, grouping
by delivery date, Kanban template, workbook filename and download rebuilding remain.
The new Perodua branch uses Python rules and SQLite in the same `DATA_DIR/jobs.sqlite`.
There is no login bypass or offline Toyota substitute in the production application.

## Create and inspect tables

Application startup creates the tables automatically with `CREATE TABLE IF NOT EXISTS`.
To create the schema before starting the app, run:

```powershell
npm ci
npm run db:init
```

This creates tables without starting the API, connecting to n8n or creating accounts.
Use the production `DATA_DIR` when running this command against an existing installation.
The repository's default local path is `data/jobs.sqlite`; Docker uses `/data/jobs.sqlite`
in its existing named volume. Do not replace an existing deployed database with a new
database from a development checkout.

| Table | Contents |
| --- | --- |
| `perodua_documents` | Stable document key, PIDO, delivery date/time/trip, source filename and extracted JSON including all items |
| `perodua_batches` | Unique batch ID, cutoff-adjusted PDF delivery date, PG/PM/PK/PM_PK family, completion state and metadata |
| `perodua_batch_documents` | Ordered batch membership; one document can be selected in multiple independent batches |
| `perodua_exports` | Immutable Excel filenames, batch association, dates and export metadata |
| `perodua_meta` | Initialization marker and compatibility metadata for serials/models |

The schema is in `server/perodua-schema.sql`. Node and Python share this schema.
Python receives the same database path from `server/perodua.ts`; no second production
Perodua database or JSON ledger is used. Structured payloads are stored as JSON text
inside SQLite. Each ledger write is a transaction restricted to Perodua tables.
Existing Toyota jobs, date records, users and sessions are not rewritten by it.

Optional SQLite verification queries:

```sql
SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'perodua_%';
SELECT pido, delivery_date, delivery_trip FROM perodua_documents;
SELECT id, save_date, family, status FROM perodua_batches;
SELECT batch_id, filename FROM perodua_exports;
SELECT json_extract(payload, '$.data.Item') FROM perodua_documents;
PRAGMA foreign_key_check;
```

Standalone Python unit/CLI calls without `--database` use a test-local
`perodua.sqlite` in their state directory. They can import legacy `state.json`
once, leaving the original file intact. The web application always supplies
`DATA_DIR/jobs.sqlite` explicitly.

## Processing and exports

PDF.js text routes PDFs containing the word PERODUA to the Python parser. All
other PDFs retain Toyota's existing n8n webhook and authenticated callbacks.
Mixed uploads queue only Toyota pages to n8n; completion saves both companies.
Perodua-only batches do not invoke n8n. Retries reuse parsed Perodua JSON and do
not create another export for already saved entries.

Perodua batches save automatically with blank number fields. PG uses its 10-column
format. PM and numeric-only PK use the same 13-column format and may share a batch
and Delivery worksheet. Mixed cards display PERODUA PM & PK; mixed Excel names use
`DD-MM-YYYY_PERODUA_PM_PK_PO.xlsx`. PG stays separate. Reopen a completed entry
before adding POs. Same-date batches have separate IDs/files; repeated filenames
receive `(1)`, `(2)`, and so on. PO membership is deduplicated within a batch.

Existing sort/model/destination rules remain: PM uses Back No groups and model
mapping, with destination 1045(SDY); PK uses trip ordering and
1047(PK). PK Back No GC G01 with middle part code BZ460 maps to D66B BAD; other
PK combinations return no model. Both sort delivery dates from earliest to latest. PG keeps trip/item order.
Model conditions live in `server/perodua-models.json`. PM/PK use a single Total Qty
column calculated as Qty per Box × Total Box; the two factors remain in extracted
data but are not separate Excel columns. Delivery Time and TRIP are the final columns.

Perodua PDF/extraction sidecars remain under `DATA_DIR/<job>/perodua/<file>/` and
Excel versions under `DATA_DIR/perodua/exports/`. These are file artifacts; their
PO data, membership, status and export metadata are authoritative in SQLite.

## Interface and authorization

The latest shared review cards, completion, Company/calendar/Year/sort filters,
PM/PK labels and prefix-mismatch popup are included. Current Toyota browser job
and section keys are retained so existing browser sessions can resume.

Perodua routes use `/api/perodua`; the current-job review uses
`GET /api/jobs/:id/saved-dates`. Existing production login protects all routes.
Operators can process and complete entries; individual deletion and Clear history
require administrator access. Clear history removes both companies' PO history,
but retains accounts and sessions. Toyota's internal callbacks still require the
existing service secret and remain inaccessible through the public nginx proxy.

## Runtime and checks

For a non-Docker installation, install Python and run:

```powershell
python -m pip install -r server/requirements-perodua.txt
```

`PYTHON_BIN` selects the executable if needed. The API Dockerfile installs Python,
a dedicated virtual environment, PyMuPDF and openpyxl. Rebuild the API image when
deploying the new source; existing environment secrets and data volume remain.

Run `npm test` and `npm run build`. Tests include the original Toyota account,
mapping, date recovery and tagging checks, plus mixed-company authenticated n8n
callbacks, shared SQLite persistence, transactional rollback, PM/PK combining,
same-date batches, version retention and deletion authorization.


## Perodua 08:00 delivery cutoff

For new PG, PM and PK entries, the history/card date and filename date come from
PDF delivery date/time, interpreted as Malaysia local time. Before 08:00, use the
previous calendar day. At exactly 08:00 and later, use the printed delivery date.
For example, 24/11 at 07:59 groups under 23/11; 24/11 at 08:00 groups under 24/11.
Upload time, server timezone and the current date do not determine this grouping.

Each upload splits by cutoff date and then by compatible family: PG stays separate,
while PM/PK can share a date entry. PDFs dated 23/11 after 08:00 and 24/11 before
08:00 can therefore be in one 23/11 entry. Excel keeps the original PDF delivery
date/time. The Current Date column and generated_date metadata remain the actual
Excel creation date; the filename uses the cutoff date.

Adding POs to a new cutoff-based entry requires matching cutoff dates. Reopening,
completing and regenerating an entry retains its assigned date. Existing saved
entries are not automatically renamed or moved; legacy entries without the
cutoff policy retain their earlier dating behavior. Start a new batch to apply the
new grouping to old PDFs. No SQLite schema migration is required; date_basis is
stored in the existing batch JSON payload.

## Company logo filters

Orders by date uses the provided Perodua logo, Toyota logo and prohibition icon
instead of a Company dropdown. The logos filter the displayed company. The third
icon clears company, exact-date and year filters and shows all matching entries;
it does not delete history. It replaces the additional Clear filters text button.
The calendar, Year and Sort dates controls remain. Logo selection is exposed with
aria-pressed, and all three buttons have accessible names and keyboard focus.
