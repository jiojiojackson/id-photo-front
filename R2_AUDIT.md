# R2 request audit — 2026-10-02

The reported warning occurred in the Cloudflare console on 2026-09-26 at 20:09.
The exact warning text and Cloudflare historical analytics were unavailable during
the code audit. Retained server journal entries begin after that date. The code
findings below are confirmed risks; they do not prove what caused that warning.

## Findings and corrections

- Cleanup previously relisted and deleted the first 1,000 objects in an unbounded
  loop. It now stops when a page repeats and caps cleanup at 100 delete batches.
  Unexpected HTML or object-level delete errors stop cleanup. Database records
  are retained on errors.
- Cleanup previously ran during active processing and raced concurrent submissions.
  It now requires an idle backend and worker and holds the shared worker-state
  row lock. Submission and start use that same row to serialize against cleanup.
- Every worker failure previously requeued the job immediately up to five times.
  Permission errors, missing objects and invalid images now end the job. Temporary
  network failures, 429 and 5xx retain bounded retries with 5–60 second backoff.
- Input download errors previously escaped the per-job failure callback. They now
  update the job and allow the run to finish normally.
- HTTP error strings could contain R2 presigned URLs. Stored job errors and worker
  logs now redact URLs. Storage diagnostics record operation, status and request ID.
- Status responses previously returned 30-minute R2 signed links for every completed
  job. They now return authenticated same-origin image URLs. Status refresh does
  not call R2; signing a URL itself was also a local operation.
- The result page previously loaded its initial selection twice when a job query
  parameter was present. It now loads once and retains the original HD resolution.
- A Queue notification failure after storing the image and jobs previously returned
  a submission failure. The durable database jobs now remain usable without forcing
  the user to resubmit and upload the same batch again.

## Expected requests

One submission uploads its original once. Each successful output job performs one
R2 GET and one R2 PUT. Opening a result performs one R2 GET through the authenticated
image proxy, with a five-minute private browser cache. Background changes and PNG
downloads use the browser canvas and do not access R2. Progress refresh accesses
Neon and backend health, without listing, reading or writing R2 objects.

`npm test` mocks R2 responses and verifies normal deletion, no-progress stopping,
invalid responses, object-level errors, a fixed batch cap, and no upload retry on
rate limits. These tests do not access or delete real bucket contents.

Cloudflare documents immediate visibility of writes and deletes in its
[R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/).
A repeated deletion page therefore warrants stopping and investigating, rather
than issuing unlimited requests.

To establish the historical warning's cause, obtain its exact text and compare
R2 operation counts, error codes and source activity for that time window.
The project's S3 storage credentials do not grant access to Cloudflare analytics.
