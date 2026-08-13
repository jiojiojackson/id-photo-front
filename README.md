# AI ID Photo Web

Mobile-friendly Next.js frontend for a HivisionIDPhotos API hosted on Lightning Inference.

## Vercel environment variables

Set:

- `LIGHTNING_API_URL`
- `LIGHTNING_API_KEY`

Do not use `NEXT_PUBLIC_` for the API key. The key is only used by the Vercel server route.

## Local

```bash
npm install
npm run dev
```

## Deploy

Import this repository into Vercel and set the two environment variables.
