-- Run once in the connected Neon database.

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS photo_jobs_status_created_idx ON photo_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS photo_jobs_request_idx ON photo_jobs(request_id);

CREATE TABLE IF NOT EXISTS photo_worker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','starting','running')),
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO photo_worker_state (id, status)
VALUES (1, 'idle')
ON CONFLICT (id) DO NOTHING;
