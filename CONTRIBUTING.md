# Contributing to 1Doc

Thanks for taking the time to improve 1Doc.

## Local Development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Before opening a pull request, run:

```bash
npm run typecheck
npm run build
```

## Database

Run `supabase/schema.sql` in your Supabase SQL editor. Do not commit `.env.local` or any service role keys.

## Pull Requests

- Keep changes focused.
- Include screenshots for UI changes.
- Update README files when changing setup, environment variables, or public behavior.
- Avoid unrelated refactors in feature or bug-fix PRs.
- Do not commit generated build output, `.next`, `node_modules`, or local cache files.

## Security-Sensitive Areas

Please be extra careful when changing:

- URL fetching and discovery.
- SSRF protection.
- Supabase service-role access.
- Translation provider credentials.
- Public submission endpoints.

If you find a security issue, do not open a public issue. See `SECURITY.md`.
