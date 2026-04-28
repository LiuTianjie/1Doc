# Security Policy

## Supported Versions

The project is currently pre-1.0. Security fixes are applied to the main branch.

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Report security issues privately through GitHub Security Advisories for the repository, or contact the maintainer through the contact method listed on the GitHub profile.

Include:

- A clear description of the issue.
- Steps to reproduce.
- Impact and affected routes or components.
- Any suggested mitigation, if available.

## Important Security Notes

1Doc fetches user-submitted URLs. Public deployments should keep SSRF protections enabled and should add rate limits around submission and refresh endpoints.

Never expose these values to browser code:

- `SUPABASE_SERVICE_ROLE_KEY`
- `ARK_API_KEY`
- `VOLC_SECRET_ACCESS_KEY`
- `INNGEST_SIGNING_KEY`

Recommended production controls:

- IP-based rate limiting for `POST /api/sites`.
- Per-site page limits.
- URL allow/deny rules.
- Queue concurrency limits.
- Monitoring for repeated failed jobs.
