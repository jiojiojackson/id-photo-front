# AI ID Photo Web

Mobile-friendly Next.js frontend for a HivisionIDPhotos API hosted on Lightning Inference.

## Vercel environment variables

Set:

- `LIGHTNING_API_URL`
- `LIGHTNING_API_KEY`
- `ADMIN_USERNAME` (The administrative account username, defaults to `admin` if not configured)
- `ADMIN_PASSWORD` (The administrative account password, defaults to `admin` if not configured)

Do not use `NEXT_PUBLIC_` for the API key, username, or password. These variables are only used by the Vercel server route and middleware.

## Local

```bash
npm install
npm run dev
```

## Deploy

Import this repository into Vercel and set the environment variables.
