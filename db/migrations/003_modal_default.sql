-- Keep the actual location of historical runs and photos intact.
ALTER TABLE photo_worker_runs ALTER COLUMN backend SET DEFAULT 'modal';
ALTER TABLE photo_jobs ALTER COLUMN backend SET DEFAULT 'modal';
