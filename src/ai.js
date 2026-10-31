// AI visibility: asks real AI assistants (with live web search) the questions a customer would ask,
// then records whether the business is named, which competitors are, and which sites they cite.
// Each engine runs only if its API key is set, so you can start with one and add the others later.

import { plain } from "./checks.js";

const T = 90000; // per-call timeout (AI answers with web search take 10-40 s)

export const ENGINES = {
  chatgpt: { label: "ChatGPT", key: "OPENAI_API_KEY", run: openai },
  perplexity: { label: "Perplexity", key: "PERPLEXITY_API_KEY", run: perplexity },
  gemini: { label: "Gemini", key: "GEMINI_API_KEY", run: gemini },
};

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const looksDomain = (s) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s || "");
const src = (url, title) => {
  // Gemini returns Google redirect links with the real domain as the title.
  let domain = host(url);
  if ((!domain || domain.includes("vertexaisearch") || domain.includes("google.")) && looksDomain(title)) domain = title.toLowerCase().replace(/^www\./, "");
  return { url, title: (title || "").slice(0, 120), domain };
};
const dedupe = (sources) => {
  const seen = new Set();
  return sources.filter((s) => s.domain && !seen.has(s.url) && seen.add(s.url)).slice(0, 12);
};
async function post(url, headers, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(T) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.detail || j.error || `HTTP ${r.status}`);
  return j;
}
// Text of the assistant message in a Responses-style output array (OpenAI, Perplexity Agent API).
function outputText(j) {
  if (typeof j.output_text === "string" && j.output_text) return j.output_text;
  return (j.output || []).filter((o) => o.type === "message")
    .flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("\n");
}
const annotations = (j) => (j.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || [])
  .flatMap((c) => c.annotations || []).filter((a) => a.url).map((a) => src(a.url, a.title));

// ChatGPT: OpenAI Responses API with its web search tool (the same search ChatGPT uses).
async function openai(env, q, city) {
  const j = await post("https://api.openai.com/v1/responses", { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, {
    model: env.OPENAI_MODEL || "gpt-5.5",
    tools: [{ type: "web_search", user_location: { type: "approximate", country: "FR", city } }],
    input: q,
  });
  return { text: outputText(j), sources: dedupe(annotations(j)) };
}

// Perplexity: Agent API with Perplexity's own Sonar model and web search.
async function perplexity(env, q, city) {
  const j = await post("https://api.perplexity.ai/v1/agent", { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, {
    model: env.PERPLEXITY_MODEL || "perplexity/sonar",
    input: q,
    max_output_tokens: 1500,
    tools: [{ type: "web_search", user_location: { country: "FR", city } }],
  });
  let text = outputText(j);
  const results = (j.output || []).filter((o) => o.type === "search_results").flatMap((o) => o.results || []).concat(j.results || []);
  // Keep the results the answer actually cites ([web:3] markers); otherwise everything it read.
  const cited = new Set([...text.matchAll(/\[web:(\d+)\]/g)].map((m) => +m[1]));
  const used = cited.size ? results.filter((r) => cited.has(r.id)) : results;
  text = text.replace(/\s*\[web:\d+\]/g, "");
  return { text, sources: dedupe([...annotations(j), ...used.filter((r) => r.url).map((r) => src(r.url, r.title))]) };
}

// Gemini: generateContent grounded with Google Search (closest to Google's AI answers).
async function gemini(env, q) {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash";
  const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { "x-goog-api-key": env.GEMINI_API_KEY },
    { contents: [{ role: "user", parts: [{ text: q }] }], tools: [{ google_search: {} }] });
  const cand = j.candidates?.[0] || {};
  const text = (cand.content?.parts || []).map((p) => p.text || "").join("");
  const chunks = cand.groundingMetadata?.groundingChunks || [];
  return { text, sources: dedupe(chunks.filter((c) => c.web?.uri).map((c) => src(c.web.uri, c.web.title))) };
}

// "Caroline Lillaz - Psychologue Annecy" → "Caroline Lillaz" (Google names often carry keywords after a dash).
export const cleanName = (n) => (n || "").split(/\s+[-–—|]\s+/)[0].trim();

// ---- Questions ----
// Custom questions (one per line on the client) replace the default non-branded ones.
// The last question is always about the business itself, to see whether the AI knows it.
export function aiPrompts(client, place, limit = 3) {
  const city = client.city || "Annecy";
  const cat = (client.category || place?.category || "").trim().toLowerCase();
  const name = cleanName(place?.name || client.name);
  const custom = (client.ai_prompts || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const generic = custom.length ? custom : cat ? [
    `Quel est le meilleur ${cat} à ${city} ? Donne-moi quelques noms.`,
    `Je cherche un ${cat} à ${city}. Lequel me recommandes-tu ?`,
    `Can you recommend a good ${cat} in ${city}?`,
  ] : [];
  return [...generic.slice(0, limit).map((q) => ({ q, branded: false })),
    { q: `Que sais-tu de « ${name} » à ${city} ? Est-ce une bonne adresse ?`, branded: true }];
}

// opts.only: engine ids to use (the public check uses a cheaper subset).
export async function askAi(env, prompts, city, opts = {}) {
  const engines = Object.keys(ENGINES).filter((id) => env[ENGINES[id].key] && (!opts.only || opts.only.includes(id)));
  if (!engines.length) return { error: "no AI API key set" };
  const jobs = engines.flatMap((engine) => prompts.map((p) => ({ engine, ...p })));
  const answers = await Promise.all(jobs.map(async (a) => {
    try {
      const r = await ENGINES[a.engine].run(env, a.q, city || "Annecy");
      if (!r.text) throw new Error("empty answer");
      return { ...a, text: r.text.slice(0, 3000), sources: r.sources };
    } catch (e) {
      return { ...a, error: String(e.message || e).slice(0, 200) };
    }
  }));
  return { engines, answers };
}

// ---- Analysis ----
const STOP = new Set(("le la les des du de et au aux en sur pour par une un the and of chez sarl sas sasu eurl " +
  "cabinet centre center maison atelier studio boutique restaurant hotel france haute savoie coaching consulting conseil " +
  "services formation therapie therapy holistic holistique massage institut salon agence brasserie bistrot pizzeria " +
  "traiteur cafe psychologue psychologist").split(" "));

// The word that identifies a name: the last distinctive word once the town, the activity and common words
// are dropped. "Caroline Lillaz – Psychologue Annecy" → "lillaz"; "L'Estaminet" → "estaminet";
// "Mercy Sandryne - Holistic Massage" → "sandryne". A business is "named" when that word appears.
export function nameKey(name, city, category) {
  const skip = new Set([...plain(city).split(" "), ...plain(category).split(" ")]);
  const near = (t) => [...skip].some((k) => k.length >= 4 && (t.startsWith(k) || k.startsWith(t))); // coach ≈ coaching
  const words = plain(cleanName(name)).split(" ").filter((t) => t.length >= 4 && !STOP.has(t) && !near(t));
  return words[words.length - 1] || "";
}
const has = (text, key) => !!key && new RegExp(`\\b${key}\\b`).test(text);

// Position when the answer is a numbered list: the number of the item that names the business.
function listPosition(raw, key) {
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:#+\s*)?(\d{1,2})[.)]\s/);
    if (m && has(plain(line), key)) return +m[1];
  }
  return null;
}

const NO_INFO = /(aucune information|pas d.information|pas trouv|je ne (?:trouve|dispose|connais)|introuvable|no (?:specific )?information|couldn.t find|could not find|unable to find|not able to find|no results)/i;

export function analyseAi(raw, { names, siteHost, city, category, competitors = [] }) {
  if (!raw || raw.error) return { error: raw?.error || "not run" };
  const keys = [...new Set(names.filter(Boolean).map((n) => nameKey(n, city, category)).filter(Boolean))];
  const comp = competitors.map((c) => ({ name: c.name, key: nameKey(c.name, city, category) })).filter((c) => c.key);
  const answers = raw.answers.map((a) => {
    if (a.error) return a;
    const t = plain(a.text);
    const key = keys.find((k) => has(t, k));
    const cites_site = !!siteHost && a.sources.some((s) => s.domain === siteHost || s.domain.endsWith("." + siteHost));
    const named = !!key || (!!siteHost && a.text.toLowerCase().includes(siteHost));
    return { ...a, named, cites_site, position: key ? listPosition(a.text, key) : null,
      knows: a.branded ? named && !NO_INFO.test(a.text) : undefined,
      competitors_named: comp.filter((c) => has(t, c.key)).map((c) => c.name) };
  });
  const ok = answers.filter((a) => !a.error);
  const generic = ok.filter((a) => !a.branded), branded = ok.filter((a) => a.branded);
  const per_engine = Object.fromEntries(raw.engines.map((e) => {
    const g = generic.filter((a) => a.engine === e);
    return [e, { label: ENGINES[e].label, named: g.filter((a) => a.named).length, of: g.length,
      knows: branded.find((a) => a.engine === e)?.knows ?? null,
      errors: answers.filter((a) => a.engine === e && a.error).length }];
  }));
  const count = (list) => Object.entries(list.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  return {
    engines: raw.engines, per_engine, answers,
    generic_total: generic.length, generic_named: generic.filter((a) => a.named).length,
    branded_total: branded.length, branded_known: branded.filter((a) => a.knows).length,
    answered: ok.length, cited_site: ok.filter((a) => a.cites_site).length,
    // Sites the assistants rely on for the non-branded questions: where to get listed and reviewed.
    top_domains: count(generic.flatMap((a) => [...new Set(a.sources.map((s) => s.domain))])
      .filter((d) => d !== siteHost)).slice(0, 8),
    competitors_named: count(generic.flatMap((a) => a.competitors_named)),
    errors: answers.filter((a) => a.error).map((a) => `${ENGINES[a.engine].label}: ${a.error}`).slice(0, 3),
  };
}
