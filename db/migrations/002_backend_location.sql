ALTER TABLE photo_worker_runs
  ADD COLUMN IF NOT EXISTS backend TEXT NOT NULL DEFAULT 'oracle'
  CHECK (backend IN ('oracle', 'modal'));

ALTER TABLE photo_jobs
  ADD COLUMN IF NOT EXISTS backend TEXT NOT NULL DEFAULT 'oracle'
  CHECK (backend IN ('oracle', 'modal'));
