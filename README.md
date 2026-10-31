# Le Baliseur Audit

Private web tool: type a business name, and it finds the business on Google, crawls its website, runs Google PageSpeed, checks the map position against competitors, scores everything out of 100 and writes a prioritised implementation plan. Every client is re-audited automatically about once a month, and each report shows what improved since the last one.

## What it scores (100 points)

| Area | Points | Checks |
|---|---|---|
| Technical health | 25 | HTTPS, indexable, sitemap, broken pages, mobile, PageSpeed |
| On-page SEO | 25 | titles, uniqueness, meta descriptions, H1, town in title/H1, content depth, image alt text |
| Local & Google profile | 25 | profile found, completeness, reviews, map position, address/phone match, website link |
| AI search readiness | 15 | business schema, FAQ, AI crawlers allowed, llms.txt, service pages |
| Trust & conversion | 10 | legal notice, privacy, click-to-call/contact, booking link |

Checks that can't run (for example without a Google key) are left out, and the score is scaled over what did run; the report shows the coverage.

## Setup (one time)

1. **Cloudflare**: Workers & Pages → Create → Import a repository → pick this repo → Deploy. The database is created automatically on the first deploy.
2. **Secrets** (Worker → Settings → Variables and secrets, type *Secret*):
   - `APP_PASSWORD`: the password to sign in.
   - `GOOGLE_API_KEY`: Google Cloud key with **Places API (New)** and **PageSpeed Insights API** enabled.
3. Optional: add a custom domain such as `audit.lebaliseur.fr` under Settings → Domains & Routes.

## Schedule

A cron runs every 6 hours and audits the one client whose last audit is 28+ days old, so each client gets a monthly audit while each run stays within the free plan's per-request limits. If audits start failing with a CPU-limit error, switch the account to Workers Paid.

## Local development

```
npm install
echo APP_PASSWORD=test > .dev.vars   # add GOOGLE_API_KEY=... to test Google checks
npx wrangler dev --test-scheduled
```
