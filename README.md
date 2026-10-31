# Le Baliseur Audit

Private web tool: type a business name, and it finds the business on Google, crawls its website, runs Google PageSpeed, checks the map position against competitors, scores everything out of 100 and writes a prioritised implementation plan. Every client is re-audited automatically about once a month, and each report shows what improved since the last one.

## What it scores

| Area | Points | Checks |
|---|---|---|
| Technical health | 25 | HTTPS, indexable, sitemap, broken pages, mobile, PageSpeed |
| On-page SEO | 25 | titles, uniqueness, meta descriptions, H1, town in title/H1, content depth, image alt text |
| Local & Google profile | 25 | profile found, completeness, reviews, map position, address/phone match, website link |
| AI search readiness | 15 | business schema, FAQ, AI crawlers allowed, llms.txt, service pages |
| Trust & conversion | 10 | legal notice, privacy, click-to-call/contact, booking link |
| Recommended by AI assistants | 15 | named when people ask ChatGPT / Perplexity / Gemini for the service, known by name, own site cited |

The score is out of 100, scaled over the checks that ran.

Checks that can't run (for example without a Google key) are left out, and the score is scaled over what did run; the report shows the coverage.

## Setup (one time)

1. **Cloudflare**: Workers & Pages → Create → Import a repository → pick this repo → Deploy. The database is created automatically on the first deploy.
2. **Secrets** (Worker → Settings → Variables and secrets, type *Secret*):
   - `APP_PASSWORD`: the password to sign in.
   - `GOOGLE_API_KEY`: Google Cloud key with **Places API (New)** and **PageSpeed Insights API** enabled.
3. Optional: add a custom domain such as `audit.lebaliseur.fr` under Settings → Domains & Routes.

## AI assistants check

Each audit asks real AI assistants, with live web search, the questions a customer would ask: three about the activity and town (or up to three custom questions set on the client page) plus one about the business by name. The report shows which assistants named the business and at what position, which map competitors they named, the sites they rely on (where to get listed and reviewed) and every full answer. **Ask the AIs now** on a client page runs only this part without saving, to test keys or new questions.

Add any of these Worker secrets; each one switches its assistant on:

| Secret | Assistant | Model variable (optional) |
|---|---|---|
| `PERPLEXITY_API_KEY` | Perplexity (Agent API, Sonar) | `PERPLEXITY_MODEL`, default `perplexity/sonar` |
| `OPENAI_API_KEY` | ChatGPT (Responses API with web search) | `OPENAI_MODEL`, default `gpt-5.5` |
| `GEMINI_API_KEY` | Gemini (grounded with Google Search) | `GEMINI_MODEL`, default `gemini-3.5-flash` |

The public check asks one question plus the by-name question, of the engines in `AI_PUBLIC_ENGINES` only (default `gemini,perplexity`, comma-separated; ChatGPT is left out because it costs more). Gemini on a project without billing uses Google's free tier, so the AI check can run at no cost. Set `AI_PUBLIC=off` to leave it out of the public check. With no AI key set, this area is simply skipped.

## Schedule

A cron runs every 6 hours and audits the one client whose last audit is 28+ days old, so each client gets a monthly audit while each run stays within the free plan's per-request limits. If audits start failing with a CPU-limit error, switch the account to Workers Paid.

## Local development

```
npm install
echo APP_PASSWORD=test > .dev.vars   # add GOOGLE_API_KEY=... to test Google checks
npx wrangler dev --test-scheduled
```

## Public check (lead magnet)

`/diagnostic` (add `?lang=en` for English, `&embed` inside an iframe) is open to anyone: business name, town, activity, website, first name, email, phone, consent. It runs the full audit, shows the score, the five areas and the top 3 priorities, and saves the person as a lead linked to a *prospect* report in the private app (Leads list on the home screen; "Make client" moves a prospect into monthly tracking). Prospects are not re-audited automatically.

Limits: 3 checks per IP per day, 40 per day in total (`PUBLIC_DAILY_LIMIT` to change). Optional:

| Variable | Use |
|---|---|
| `BREVO_API_KEY` (Secret), `MAIL_FROM`, `MAIL_TO` | email a lead alert to you and the result to the person (same values as the website) |
| `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET` (Secret) | Cloudflare bot check on the form (the widget's hostnames must include this app's domain) |
| `CONTACT_URL`, `CONTACT_URL_EN` | where the "free full audit" button leads |
