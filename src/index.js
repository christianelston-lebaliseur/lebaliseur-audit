// Le Baliseur audit tool — Cloudflare Worker.
// Enter a business name; it finds it on Google, crawls the site, scores it,
// stores the result and re-audits every client monthly.
import { crawl, normHost } from "./crawl.js";
import { pagespeed, findBusiness, placeById, mapRank } from "./sources.js";
import { runChecks, score, plan, compare, streetOf, SECTIONS } from "./checks.js";
import APP_HTML from "./app.html";
import LOGIN_HTML from "./login.html";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, city TEXT, category TEXT,
    site TEXT, query TEXT, place_id TEXT, notes TEXT, created TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, date TEXT NOT NULL,
    total INTEGER, coverage INTEGER, sections TEXT, data TEXT)`,
  `CREATE INDEX IF NOT EXISTS runs_client ON runs(client_id, date)`,
];
let ready = false;
async function db(env) {
  if (!ready) { await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))); ready = true; }
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
export async function audit(env, client) {
  const key = env.GOOGLE_API_KEY;
  const google = client.place_id ? await placeById(client.place_id, key)
    : await findBusiness(client.name, client.city, key);
  const place = google.place;
  let site = client.site || place?.website || "";
  if (site && !/^https?:\/\//.test(site)) site = "https://" + site;
  const query = client.query || [client.category, client.city].filter(Boolean).join(" ");
  const [crawlRes, psi, rank] = await Promise.all([
    site ? crawl(site, client.city, 25, streetOf(place?.address))
      : { site: { reachable: false }, pages: [], errors: ["No website known"] },
    site ? pagespeed(site, key) : { error: "no website" },
    place && query ? mapRank(place.id, query, key, place.location) : { error: place ? "no search set" : "no profile" },
  ]);
  const ctx = { crawl: crawlRes, pagespeed: psi, google, rank, city: client.city || "",
    category: client.category || "", siteHost: site ? normHost(new URL(site).hostname) : "" };
  const results = runChecks(ctx);
  const sc = score(results);
  const pages = crawlRes.pages.map((p) => ({ url: p.url, status: p.status, title: p.title, words: p.words,
    h1: p.h1, meta: !!p.meta_description, schema: p.schema_types, noindex: p.noindex }));
  return {
    date: new Date().toISOString(), site, query, score: sc, results, plan: plan(results),
    google: place || null, google_error: google.error || null, rank, pagespeed: psi,
    site_facts: crawlRes.site, crawl_errors: crawlRes.errors, pages,
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
      ORDER BY c.name COLLATE NOCASE`).all();
    return json(results);
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
      GROUP BY c.id HAVING last IS NULL OR last < datetime('now', '-28 days')
      ORDER BY last LIMIT 1`).first();
    if (due) await runClient(env, due.id);
  },
};
