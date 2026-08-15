-- Canonical bootstrap/reference schema.
--
-- Vercel deployments do NOT execute this file directly. Production schema changes
-- are applied by the numbered files in db/migrations/ via `npm run db:migrate`.
-- Keep this file synchronized with the migration history for human reference.

CREATE TABLE IF NOT EXISTS photo_requests (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS photo_jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES photo_requests(id) ON DELETE CASCADE,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT 'px',
  dpi INTEGER NOT NULL DEFAULT 300,
  background TEXT NOT NULL DEFAULT '#ffffff',
  input_key TEXT NOT NULL,
  output_key TEXT NOT NULL,
  input_url TEXT,
  output_url TEXT,
  url_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  error TEXT,
  processing_time_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  worker_run_id TEXT,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS photo_jobs_status_created_idx ON photo_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS photo_jobs_request_idx ON photo_jobs(request_id);
CREATE INDEX IF NOT EXISTS photo_jobs_lease_idx ON photo_jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS photo_worker_runs (
  id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  credential_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','running','completed','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS photo_worker_runs_active_idx
  ON photo_worker_runs(status, credential_expires_at, last_seen_at);

CREATE TABLE IF NOT EXISTS photo_worker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','starting','running')),
  active_run_id TEXT REFERENCES photo_worker_runs(id),
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO photo_worker_state (id, status)
VALUES (1, 'idle')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE photo_jobs ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photo_jobs ADD COLUMN IF NOT EXISTS worker_run_id TEXT;
ALTER TABLE photo_jobs ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE photo_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE photo_worker_runs ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE photo_worker_state ADD COLUMN IF NOT EXISTS active_run_id TEXT REFERENCES photo_worker_runs(id);
