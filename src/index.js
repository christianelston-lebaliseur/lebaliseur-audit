// Le Baliseur audit tool — Cloudflare Worker.
// Enter a business name; it finds it on Google, crawls the site, scores it,
// stores the result and re-audits every client monthly.
import { crawl, normHost, normSite } from "./crawl.js";
import { pagespeed, findBusiness, findCandidates, placeById, mapGrid, nameWords, hasWord, countryOf, searchBusinesses, searchSuggestions } from "./sources.js";
import { runChecks, score, plan, compare, streetOf, townOf, SECTIONS } from "./checks.js";
import APP_HTML from "./app.html";
import LOGIN_HTML from "./login.html";
import CHECK_HTML from "./check.html";
import { publicCheck, publicLookup, publicFeedback } from "./public.js";
import { aiPrompts, askAi, analyseAi } from "./ai.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, city TEXT, category TEXT,
    site TEXT, query TEXT, place_id TEXT, notes TEXT, created TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, date TEXT NOT NULL,
    total INTEGER, coverage INTEGER, sections TEXT, data TEXT)`,
  `CREATE INDEX IF NOT EXISTS runs_client ON runs(client_id, date)`,
  `CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, first_name TEXT, email TEXT, phone TEXT,
    business TEXT, city TEXT, category TEXT, site TEXT, consent INTEGER, lang TEXT, ip_hash TEXT,
    status TEXT, client_id INTEGER, run_id INTEGER, total INTEGER)`,
  `CREATE INDEX IF NOT EXISTS leads_date ON leads(date)`,
  `CREATE TABLE IF NOT EXISTS lookups (ip_hash TEXT, date TEXT)`,
  // Research mode: businesses audited to find low scorers. Kept apart from clients and leads,
  // never emailed, never re-audited automatically.
  `CREATE TABLE IF NOT EXISTS research (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, batch TEXT, name TEXT, city TEXT, category TEXT,
    site TEXT, place_id TEXT, phone TEXT, maps_url TEXT, address TEXT, rating REAL, reviews INTEGER,
    total INTEGER, coverage INTEGER, sections TEXT, top TEXT, data TEXT, client_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS research_batch ON research(batch, total)`,
];
let ready = false;
async function db(env) {
  if (!ready) {
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    // Added after first release: prospects (from the public check) are kept apart from clients.
    try { await env.DB.prepare("ALTER TABLE clients ADD COLUMN prospect INTEGER DEFAULT 0").run(); } catch { /* exists */ }
    // Custom questions to ask the AI assistants, one per line.
    try { await env.DB.prepare("ALTER TABLE clients ADD COLUMN ai_prompts TEXT").run(); } catch { /* exists */ }
    // How the person says customers search for them (optional field on the public check).
    try { await env.DB.prepare("ALTER TABLE leads ADD COLUMN search TEXT").run(); } catch { /* exists */ }
    // Feedback left on the public result: 1 useful, 0 not useful, plus an optional comment.
    try { await env.DB.prepare("ALTER TABLE leads ADD COLUMN fb_useful INTEGER").run(); } catch { /* exists */ }
    try { await env.DB.prepare("ALTER TABLE leads ADD COLUMN fb_comment TEXT").run(); } catch { /* exists */ }
    // Research rows: a warning when the site couldn't be read, so a partial score isn't mistaken for a low one.
    try { await env.DB.prepare("ALTER TABLE research ADD COLUMN warn TEXT").run(); } catch { /* exists */ }
    ready = true;
  }
  return env.DB;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const html = (body, status = 200, headers = {}) => new Response(body, {
  status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-robots-tag": "noindex", ...headers } });

async function token(env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.APP_PASSWORD || ""),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("lebaliseur-audit"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function authed(req, env) {
  if (!env.APP_PASSWORD) return false;
  const t = await token(env);
  const cookie = req.headers.get("cookie") || "";
  return cookie.split(/;\s*/).includes(`lba=${t}`) || req.headers.get("x-audit-token") === t;
}

// ---- The audit itself ----
// opts.public: the public check asks fewer questions of cheaper engines (AI_PUBLIC_ENGINES).
function aiPlan(env, client, place, opts = {}, country = "FR") {
  if (opts.public && env.AI_PUBLIC === "off") return { prompts: [], skip: "AI check off for the public check" };
  if (opts.noAi) return { prompts: [], skip: "AI check not run (research mode)" };
  const ask = country === "GB" || opts.lang === "en"
    ? `Who would you recommend for "${opts.aiQuery}"? Give me a few names.`
    : `Qui me recommandes-tu pour « ${opts.aiQuery} » ? Donne-moi quelques noms.`;
  const c = opts.aiQuery ? { ...client, ai_prompts: ask } : client;
  return {
    prompts: aiPrompts(c, place, opts.public ? 1 : 3, country),
    only: opts.public ? (env.AI_PUBLIC_ENGINES || "gemini,perplexity").split(",").map((x) => x.trim()) : null,
  };
}
function aiContext(client, place, site, rank) {
  return { names: [client.name, place?.name], siteHost: normSite(site) ? normHost(new URL(normSite(site)).hostname) : "",
    city: client.city || "", category: client.category || place?.category || "", competitors: rank?.competitors || [] };
}

const SOCIAL = /(^|\.)(instagram\.com|facebook\.com|fb\.com|fb\.me|linktr\.ee|tiktok\.com|linkedin\.com|x\.com|twitter\.com|youtube\.com|wa\.me)$/i;

export async function audit(env, client, opts = {}) {
  const key = env.GOOGLE_API_KEY;
  const google = opts.noProfile ? { error: "No Google profile (confirmed by the business)", notFound: true }
    : client.place_id ? await placeById(client.place_id, key)
    : await findBusiness(client.name, client.city, key, { strict: true, site: client.site });
  // UK business: reload its profile in English (category, address) and search from the UK.
  const country = countryOf(google.place, client.site);
  if (country === "GB" && google.place?.id) {
    const en = await placeById(google.place.id, key, "GB");
    if (en.place) google.place = en.place;
  }
  const place = google.place;
  const rawSite = normSite(client.site) || normSite(place?.website);
  // A social profile or link page isn't a website: score it as "no website" instead of crawling a login wall.
  const social = rawSite && SOCIAL.test(new URL(rawSite).hostname);
  const site = social ? "" : rawSite;
  const query = client.query || [client.category, client.city].filter(Boolean).join(" ");
  // Map position: plain keywords (never the business's name) searched from a grid of points.
  // Client audits: 9 points × 2 searches. Public check and research: 5 points × 1 search, to keep costs down.
  // Only Google is called here; the AI assistants (Perplexity…) are asked separately, once per audit.
  const light = opts.public || opts.research;
  const trade = (client.category || place?.category || "").toLowerCase().trim();
  const brand = nameWords(client.name || place?.name, [trade, client.city].join(" "));
  const keywords = [...new Set([query, trade].map((k) => (k || "").trim()).filter((k) => k && !hasWord(k, brand)))]
    .slice(0, light ? 1 : +(env.MAP_KEYWORDS || 2));
  const gridOpts = { points: light ? 5 : +(env.MAP_GRID_POINTS || 9), km: +(env.MAP_GRID_KM || 1.5) };
  const ap = aiPlan(env, client, place, opts, country);
  const [crawlRes, psi, rank, aiRaw] = await Promise.all([
    site ? // Pages read per audit. Kept low for the free Cloudflare plan (10 ms of processing per request);
    // on Workers Paid set the CRAWL_PAGES variable to 25 for fuller reports.
    crawl(site, client.city, opts.maxPages || Math.min(+env.CRAWL_PAGES || 10, opts.public ? 12 : 25), streetOf(place?.address), townOf(place?.address))
      : { site: { reachable: false, none: true, social: social ? rawSite : null }, pages: [],
          errors: [social ? "Only a social profile, no website" : "No website known"] },
    site ? pagespeed(site, key) : { error: "no website" },
    place ? mapGrid(place.id, keywords, key, place.location, country, gridOpts) : { error: "no profile" },
    ap.skip ? { error: ap.skip } : askAi(env, ap.prompts, client.city, { only: ap.only, country }),
  ]);
  // What people search for this trade (Google suggestions), for the private report only. Asked after
  // everything else, so if the plan's limit on outside requests is reached only this part is lost.
  const searches = await searchSuggestions(trade || query, client.city || townOf(place?.address) || "", country, brand, light)
    .catch((e) => ({ error: String(e.message || e) }));
  const ai = analyseAi(aiRaw, aiContext(client, place, site, rank));
  const ctx = { crawl: crawlRes, pagespeed: psi, google, rank, city: client.city || "", country,
    category: client.category || "", siteHost: site ? normHost(new URL(site).hostname) : "", ai };
  const results = runChecks(ctx);
  const sc = score(results);
  const pages = crawlRes.pages.map((p) => ({ url: p.url, status: p.status, throttled: p.throttled || undefined, title: p.title, words: p.words,
    h1: p.h1, meta: !!p.meta_description, schema: p.schema_types, noindex: p.noindex }));
  const sf = crawlRes.site || {};
  const warning = !site ? null
    : sf.reachable === false ? "The website didn't respond, so only the Google profile was scored."
    : sf.readable === false && sf.throttled ? "The website asked us to slow down (too many requests), so its pages weren't checked this time. Re-run the audit in 10 to 15 minutes."
    : sf.readable === false ? "The website answered but couldn't be read (" + (sf.home_error || "refused") + "), so its pages weren't checked. The score covers the Google profile and speed only."
    : null;
  return {
    date: new Date().toISOString(), site, social_profile: social ? rawSite : null, query, country, score: sc, results, plan: plan(results), warning,
    google: place || null, google_error: google.error || null, rank, pagespeed: psi,
    site_facts: crawlRes.site, crawl_errors: crawlRes.errors, pages, ai, searches,
  };
}

async function saveRun(env, clientId, run) {
  const D = await db(env);
  const prevRow = await D.prepare("SELECT data FROM runs WHERE client_id=? ORDER BY date DESC LIMIT 1")
    .bind(clientId).first();
  run.changes = compare(prevRow ? JSON.parse(prevRow.data) : null, run);
  const r = await D.prepare("INSERT INTO runs (client_id, date, total, coverage, sections, data) VALUES (?,?,?,?,?,?)")
    .bind(clientId, run.date, run.score.total, run.score.coverage, JSON.stringify(run.score.sections), JSON.stringify(run)).run();
  if (run.google?.id) {
    await D.prepare("UPDATE clients SET place_id=COALESCE(place_id, ?), site=COALESCE(NULLIF(site,''), ?) WHERE id=?")
      .bind(run.google.id, run.site || null, clientId).run();
  }
  run.id = r.meta.last_row_id;
  return run;
}

async function runClient(env, id) {
  const D = await db(env);
  const client = await D.prepare("SELECT * FROM clients WHERE id=?").bind(id).first();
  if (!client) return { error: "client not found" };
  return saveRun(env, id, await audit(env, client));
}

// ---- HTTP routes ----
async function api(req, env, url) {
  const D = await db(env);
  const path = url.pathname, m = req.method;
  let mm;

  if (path === "/api/clients" && m === "GET") {
    const { results } = await D.prepare(`
      SELECT c.*, r.total, r.date AS last_date,
        (SELECT total FROM runs r2 WHERE r2.client_id=c.id AND r2.date<r.date ORDER BY date DESC LIMIT 1) AS prev_total
      FROM clients c LEFT JOIN runs r ON r.id=(SELECT id FROM runs WHERE client_id=c.id ORDER BY date DESC LIMIT 1)
      WHERE COALESCE(c.prospect,0)=0 ORDER BY c.name COLLATE NOCASE`).all();
    return json(results);
  }
  if (path === "/api/leads" && m === "GET") {
    const { results } = await D.prepare(`SELECT l.*, COALESCE(c.prospect,0) AS prospect FROM leads l
      LEFT JOIN clients c ON c.id=l.client_id ORDER BY l.date DESC LIMIT 300`).all();
    return json(results);
  }
  if ((mm = path.match(/^\/api\/leads\/(\d+)$/)) && m === "DELETE") {
    await D.prepare("DELETE FROM leads WHERE id=?").bind(+mm[1]).run();
    return json({ ok: true });
  }
  if ((mm = path.match(/^\/api\/clients\/(\d+)\/convert$/)) && m === "POST") {
    await D.prepare("UPDATE clients SET prospect=0 WHERE id=?").bind(+mm[1]).run();
    return json({ ok: true });
  }
  // ---- Research mode: audit any business, see the score, nothing emailed, not a client ----
  if (path === "/api/research/find" && m === "POST") {
    const b = await req.json();
    const q = [b.activity, b.city].map((x) => (x || "").trim()).filter(Boolean).join(" ");
    if (!q) return json({ error: "Type an activity and a town" }, 400);
    const r = await searchBusinesses(q, env.GOOGLE_API_KEY, b.country === "GB" ? "GB" : "FR");
    if (r.error) return json({ error: r.error }, 502);
    // Flag businesses already researched in the last 30 days, so they aren't paid for twice.
    const ids = r.places.map((p) => p.id);
    const seen = {};
    if (ids.length) {
      const { results } = await D.prepare(`SELECT place_id, id, total FROM research WHERE place_id IN (${ids.map(() => "?").join(",")})
        AND date > datetime('now','-30 days') ORDER BY date`).bind(...ids).all();
      for (const x of results) seen[x.place_id] = { id: x.id, total: x.total };
    }
    return json({ query: q, places: r.places.map((p) => ({ ...p, seen: seen[p.id] || null })) });
  }
  if (path === "/api/research/audit" && m === "POST") {
    const b = await req.json();
    if (!b.name?.trim() && !b.place_id) return json({ error: "Name is required" }, 400);
    const client = { name: (b.name || "").trim(), city: (b.city || "").trim(), category: (b.category || "").trim(),
      site: (b.site || "").trim(), place_id: b.place_id || null, query: "" };
    const run = await audit(env, client, { noAi: !b.ai, maxPages: 8, research: true });
    const g = run.google || {};
    const top = [...run.plan.now, ...run.plan.month, ...run.plan.quarter].sort((x, y) => y.gain - x.gain).slice(0, 3)
      .map((x) => ({ label: x.label, gain: x.gain }));
    const r = await D.prepare(`INSERT INTO research (date, batch, name, city, category, site, place_id, phone, maps_url, address,
      rating, reviews, total, coverage, sections, top, data, warn) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(run.date, (b.batch || "").trim() || null, g.name || client.name, client.city, client.category || g.category || "",
        run.site || null, g.id || null, g.phone || null, g.maps_url || null, g.address || null, g.rating ?? null, g.reviews ?? null,
        run.score.total, run.score.coverage, JSON.stringify(run.score.sections), JSON.stringify(top), JSON.stringify(run), run.warning ? (run.site_facts?.reachable === false ? "unreachable" : "unreadable") : null).run();
    return json({ id: r.meta.last_row_id, name: g.name || client.name, total: run.score.total });
  }
  if (path === "/api/research" && m === "GET") {
    const { results } = await D.prepare(`SELECT id, date, batch, name, city, category, site, place_id, phone, maps_url, address,
      rating, reviews, total, coverage, sections, top, client_id, warn FROM research ORDER BY date DESC LIMIT 1000`).all();
    return json(results.map((x) => ({ ...x, sections: JSON.parse(x.sections || "{}"), top: JSON.parse(x.top || "[]") })));
  }
  if (path === "/api/research" && m === "DELETE") {
    const batch = url.searchParams.get("batch");
    if (batch === null) return json({ error: "batch required" }, 400);
    await D.prepare("DELETE FROM research WHERE COALESCE(batch,'')=?").bind(batch).run();
    return json({ ok: true });
  }
  if ((mm = path.match(/^\/api\/research\/(\d+)$/))) {
    if (m === "GET") {
      const r = await D.prepare("SELECT * FROM research WHERE id=?").bind(+mm[1]).first();
      return r ? json({ row: { ...r, data: undefined }, run: JSON.parse(r.data), sectionNames: SECTIONS }) : json({ error: "not found" }, 404);
    }
    if (m === "DELETE") {
      await D.prepare("DELETE FROM research WHERE id=?").bind(+mm[1]).run();
      return json({ ok: true });
    }
  }
  // Move a researched business into the private app as a prospect (full report, no re-audit).
  if ((mm = path.match(/^\/api\/research\/(\d+)\/prospect$/)) && m === "POST") {
    const r = await D.prepare("SELECT * FROM research WHERE id=?").bind(+mm[1]).first();
    if (!r) return json({ error: "not found" }, 404);
    if (r.client_id) return json({ id: r.client_id });
    const c = await D.prepare("INSERT INTO clients (name, city, category, site, query, place_id, notes, prospect) VALUES (?,?,?,?,?,?,?,1)")
      .bind(r.name, r.city || "", r.category || "", r.site || "", "", r.place_id, "From research" + (r.batch ? ": " + r.batch : "")).run();
    const cid = c.meta.last_row_id;
    await saveRun(env, cid, JSON.parse(r.data));
    await D.prepare("UPDATE research SET client_id=? WHERE id=?").bind(cid, r.id).run();
    return json({ id: cid });
  }
  if (path === "/api/lookup" && m === "POST") {
    const b = await req.json();
    return json(await findBusiness(b.name || "", b.city || "", env.GOOGLE_API_KEY));
  }
  if (path === "/api/clients" && m === "POST") {
    const b = await req.json();
    if (!b.name?.trim()) return json({ error: "Name is required" }, 400);
    const r = await D.prepare("INSERT INTO clients (name, city, category, site, query, place_id, notes) VALUES (?,?,?,?,?,?,?)")
      .bind(b.name.trim(), b.city?.trim() || "Annecy", b.category?.trim() || "", b.site?.trim() || "",
        b.query?.trim() || "", b.place_id || null, b.notes || "").run();
    return json({ id: r.meta.last_row_id });
  }
  if ((mm = path.match(/^\/api\/clients\/(\d+)$/))) {
    const id = +mm[1];
    if (m === "GET") {
      const client = await D.prepare("SELECT * FROM clients WHERE id=?").bind(id).first();
      const { results: runs } = await D.prepare(
        "SELECT id, date, total, coverage, sections FROM runs WHERE client_id=? ORDER BY date").bind(id).all();
      const latest = await D.prepare("SELECT data FROM runs WHERE client_id=? ORDER BY date DESC LIMIT 1").bind(id).first();
      return json({ client, runs: runs.map((r) => ({ ...r, sections: JSON.parse(r.sections) })),
        latest: latest ? JSON.parse(latest.data) : null, sectionNames: SECTIONS });
    }
    if (m === "PUT") {
      const b = await req.json();
      await D.prepare("UPDATE clients SET name=?, city=?, category=?, site=?, query=?, notes=? WHERE id=?")
        .bind(b.name, b.city, b.category, b.site, b.query, b.notes || "", id).run();
      return json({ ok: true });
    }
    if (m === "DELETE") {
      await D.batch([D.prepare("DELETE FROM runs WHERE client_id=?").bind(id),
        D.prepare("DELETE FROM clients WHERE id=?").bind(id)]);
      return json({ ok: true });
    }
  }
  if ((mm = path.match(/^\/api\/clients\/(\d+)\/ai-prompts$/)) && m === "PUT") {
    const b = await req.json();
    const lines = String(b.ai_prompts || "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 6);
    await D.prepare("UPDATE clients SET ai_prompts=? WHERE id=?").bind(lines.join("\n"), +mm[1]).run();
    return json({ ok: true });
  }
  // Ask the AI assistants only (no crawl, nothing saved): to test keys or try new questions.
  if ((mm = path.match(/^\/api\/clients\/(\d+)\/ai$/)) && m === "POST") {
    const client = await D.prepare("SELECT * FROM clients WHERE id=?").bind(+mm[1]).first();
    if (!client) return json({ error: "client not found" }, 404);
    const last = await D.prepare("SELECT data FROM runs WHERE client_id=? ORDER BY date DESC LIMIT 1").bind(client.id).first();
    const L = last ? JSON.parse(last.data) : {};
    const place = L.google || null;
    const country = countryOf(place, client.site);
    const ap = aiPlan(env, client, place, {}, country);
    const ai = analyseAi(await askAi(env, ap.prompts, client.city, { country }), aiContext(client, place, normSite(L.site) || normSite(client.site), L.rank));
    return json({ ai, test: true });
  }
  if ((mm = path.match(/^\/api\/clients\/(\d+)\/audit$/)) && m === "POST") {
    return json(await runClient(env, +mm[1]));
  }
  if ((mm = path.match(/^\/api\/runs\/(\d+)$/)) && m === "GET") {
    const r = await D.prepare("SELECT data, client_id FROM runs WHERE id=?").bind(+mm[1]).first();
    return r ? json({ ...JSON.parse(r.data), client_id: r.client_id, sectionNames: SECTIONS }) : json({ error: "not found" }, 404);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n");
    // Public visibility check (no login), embeddable on lebaliseur.fr.
    if (url.pathname === "/diagnostic" || url.pathname === "/check") {
      const ENGINE_KEYS = { chatgpt: "OPENAI_API_KEY", perplexity: "PERPLEXITY_API_KEY", gemini: "GEMINI_API_KEY" };
      const aiOn = env.AI_PUBLIC !== "off" && (env.AI_PUBLIC_ENGINES || "gemini,perplexity").split(",")
        .some((e) => env[ENGINE_KEYS[e.trim()]]);
      const page = (aiOn ? CHECK_HTML : CHECK_HTML.replace(/<li data-fr="Ce que les IA[^\n]*<\/li>\n?/, ""))
        .replace("{{CONTACT_URL}}", env.CONTACT_URL || "https://lebaliseur.fr/#diagnostic")
        .replace("{{CONTACT_URL_EN}}", env.CONTACT_URL_EN || "https://lebaliseur.fr/en/#audit")
        .replace("{{TS_SCRIPT}}", env.TURNSTILE_SITEKEY ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : "")
        .replace("{{TS_WIDGET}}", env.TURNSTILE_SITEKEY ? `<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITEKEY}" style="margin-top:12px"></div>` : "");
      return html(page, 200, { "content-security-policy":
        "frame-ancestors 'self' https://lebaliseur.fr https://www.lebaliseur.fr https://lebaliseur.com https://www.lebaliseur.com https://*.workers.dev " + (env.FRAME_EXTRA || "") });
    }
    if (url.pathname === "/public/feedback" && req.method === "POST") {
      try { return await publicFeedback(req, env, { db }); }
      catch (e) { console.error("feedback failed", e && e.stack || e); return json({ ok: false }, 500); }
    }
    if (url.pathname === "/public/lookup" && req.method === "POST") {
      try { return await publicLookup(req, env, { db, findCandidates }); }
      catch (e) { console.error("public lookup failed", e && e.stack || e); return json({ candidates: [], best: -1 }); }
    }
    if (url.pathname === "/public/check" && req.method === "POST") {
      try { return await publicCheck(req, env, { db, audit, saveRun, findBusiness, placeById }); }
      catch (e) {
        console.error("public check failed", e && e.stack || e);
        try {
          await env.DB.prepare("UPDATE leads SET status=? WHERE id=(SELECT MAX(id) FROM leads WHERE status='running')")
            .bind("error: " + String(e && e.message || e).slice(0, 150)).run();
        } catch { /* ignore */ }
        return json({ error: "Le diagnostic n'a pas pu aboutir cette fois. Réessayez dans quelques minutes, ou écrivez-moi à chris@lebaliseur.fr." }, 500);
      }
    }
    if (url.pathname === "/login" && req.method === "POST") {
      const f = await req.formData();
      if (env.APP_PASSWORD && f.get("password") === env.APP_PASSWORD) {
        return new Response(null, { status: 303, headers: { location: "/",
          "set-cookie": `lba=${await token(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` } });
      }
      return html(LOGIN_HTML.replace("<!--ERR-->", "<p class=err>Wrong password.</p>"), 401);
    }
    if (url.pathname === "/logout") {
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "lba=; Path=/; Max-Age=0" } });
    }
    if (!(await authed(req, env))) {
      if (url.pathname.startsWith("/api/")) return json({ error: "login required" }, 401);
      return html(LOGIN_HTML.replace("<!--ERR-->", env.APP_PASSWORD ? "" :
        "<p class=err>APP_PASSWORD secret is not set yet.</p>"));
    }
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); }
      catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    return html(APP_HTML);
  },

  // Runs every 6 hours and audits the one client most overdue (last audit 28+ days ago),
  // so each client is re-audited monthly while staying inside free-plan limits.
  async scheduled(_event, env) {
    const D = await db(env);
    const due = await D.prepare(`
      SELECT c.id, MAX(r.date) AS last FROM clients c LEFT JOIN runs r ON r.client_id=c.id
      WHERE COALESCE(c.prospect,0)=0 GROUP BY c.id HAVING last IS NULL OR last < datetime('now', '-28 days')
      ORDER BY last LIMIT 1`).first();
    if (due) await runClient(env, due.id);
  },
};
