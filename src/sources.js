// External data: Google PageSpeed Insights and Google Places (Business Profile).

import { plain } from "./checks.js";
import { nameKey } from "./ai.js";

const PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PLACES = "https://places.googleapis.com/v1/places:searchText";
const FIELDS = ["id", "displayName", "formattedAddress", "nationalPhoneNumber", "websiteUri",
  "rating", "userRatingCount", "primaryTypeDisplayName", "regularOpeningHours", "googleMapsUri",
  "photos", "businessStatus", "editorialSummary", "location"].map((f) => "places." + f).join(",");

export async function pagespeed(url, key) {
  const q = new URLSearchParams({ url, strategy: "mobile" });
  for (const c of ["performance", "seo", "accessibility", "best-practices"]) q.append("category", c);
  if (key) q.set("key", key);
  try {
    // Ask only for the fields used: the full Lighthouse report is several MB and costly to read.
    const f = new URLSearchParams(q);
    f.set("fields", "error,lighthouseResult/categories/*/score,lighthouseResult/audits/largest-contentful-paint/numericValue," +
      "lighthouseResult/audits/cumulative-layout-shift/numericValue,lighthouseResult/audits/total-blocking-time/numericValue");
    let r = await fetch(`${PSI}?${f}`, { signal: AbortSignal.timeout(110000) });
    if (r.status === 400) r = await fetch(`${PSI}?${q}`, { signal: AbortSignal.timeout(110000) }); // fields rejected: full report
    const j = await r.json();
    if (!r.ok) return { error: j.error?.message?.slice(0, 200) || `HTTP ${r.status}` };
    const lh = j.lighthouseResult, a = lh.audits;
    const scores = {};
    for (const [k, v] of Object.entries(lh.categories)) scores[k] = Math.round((v.score || 0) * 100);
    return {
      scores,
      lcp_s: +(a["largest-contentful-paint"].numericValue / 1000).toFixed(1),
      cls: +a["cumulative-layout-shift"].numericValue.toFixed(3),
      tbt_ms: Math.round(a["total-blocking-time"].numericValue),
    };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

// Country of a business: from its Google address ("…, Royaume-Uni" / "…, UK"), else its website domain.
// Decides the search language and region, the AI questions and the legal checks. France unless clearly UK.
export function countryOf(place, site) {
  const a = (place?.address || "").trim();
  if (/(royaume-uni|united kingdom|\buk)$/i.test(a)) return "GB";
  if (/france$/i.test(a)) return "FR";
  if (/\.uk$/i.test(hostOf(site || "") || hostOf(place?.website || ""))) return "GB";
  return "FR";
}
const langOf = (country) => (country === "GB" ? "en" : "fr");

async function placesSearch(textQuery, key, location, pageSize = 20, country = "FR", radius = 8000) {
  if (!key) return { error: "Google API key not set" };
  // Include businesses that hide their address and serve an area (home-based trades, consultants…),
  // which Google leaves out by default.
  const body = { textQuery, languageCode: langOf(country), regionCode: country, pageSize, includePureServiceAreaBusinesses: true };
  if (location) body.locationBias = { circle: { center: location, radius } };
  try {
    const r = await fetch(PLACES, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (!r.ok) return { error: j.error?.message?.slice(0, 200) || `HTTP ${r.status}` };
    return { places: j.places || [] };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export function summarisePlace(p) {
  return {
    id: p.id,
    name: p.displayName?.text,
    address: p.formattedAddress,
    phone: p.nationalPhoneNumber || null,
    website: p.websiteUri || null,
    rating: p.rating ?? null,
    reviews: p.userRatingCount || 0,
    category: p.primaryTypeDisplayName?.text || null,
    has_hours: !!p.regularOpeningHours,
    photos: (p.photos || []).length,
    has_description: !!p.editorialSummary,
    status: p.businessStatus || null,
    maps_url: p.googleMapsUri,
    location: p.location || null,
  };
}

// Does a Google result really belong to the business that was asked for? Google always returns its
// closest matches, even for a business with no profile ("Le Baliseur" → an unrelated shop), so a result
// counts only if its website is the business's site or the names share their distinctive word.
const compact = (s) => plain(s).replace(/ /g, "");
const hostOf = (u) => { try { return new URL(/^https?:/.test(u) ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const siteMatch = (p, site) => !!site && !!p.website && !!hostOf(site) && hostOf(site) === hostOf(p.website);
export function sameBusiness(p, name, city, site) {
  if (siteMatch(p, site)) return true;
  const q = compact(name), r = compact(p.name);
  const qk = compact(nameKey(name, city, "")), rk = compact(nameKey(p.name, city, ""));
  // Strong: the distinctive word of what was typed appears in Google's name ("lillaz" in "Caroline Lillaz – Psychologue").
  if (qk && r.includes(qk)) return true;
  // Weak: Google's distinctive word appears in what was typed. Only when it is nearly the whole name
  // ("estaminet" in "lestaminet"), never a fragment ("colony" in "wearecolony"), and never when the
  // person gave a website that differs from the profile's.
  const different = !!site && !!p.website && !siteMatch(p, site);
  return !!rk && rk.length >= 5 && q.includes(rk) && q.length - rk.length <= 3 && !different;
}

// Find a business by name; returns the best match plus alternatives.
// opts.strict: only accept a result that is clearly this business (public check and audits without a
// confirmed profile); otherwise notFound is set so the report scores "no Google profile".
export async function findBusiness(name, city, key, opts = {}) {
  const res = await placesSearch(`${name} ${city}`.trim(), key, null, 5);
  if (res.error) return res;
  const all = res.places.map(summarisePlace);
  if (opts.strict) {
    const hit = all.find((p) => siteMatch(p, opts.site)) || all.find((p) => sameBusiness(p, name, city, opts.site));
    if (!hit) return { error: "No Google profile found for this business", notFound: true, alternatives: all.slice(0, 3) };
    return { place: hit, alternatives: all.filter((p) => p !== hit) };
  }
  if (!all.length) return { error: "Not found on Google Maps", notFound: true };
  return { place: all[0], alternatives: all.slice(1) };
}

// Up to 4 Google results to show the person, best match first (or -1 when none clearly matches).
export async function findCandidates(name, city, key, site) {
  const res = await placesSearch(`${name} ${city}`.trim(), key, null, 5);
  if (res.error) return res;
  const all = res.places.map(summarisePlace);
  let best = all.findIndex((p) => siteMatch(p, site));
  if (best < 0) best = all.findIndex((p) => sameBusiness(p, name, city, site));
  const list = best > 0 ? [all[best], ...all.filter((_, i) => i !== best)] : all;
  return { candidates: list.slice(0, 4), best: best >= 0 ? 0 : -1 };
}

// Research mode: list businesses for a search such as "restaurant Annecy" (up to 20, Google's order).
export async function searchBusinesses(query, key, country = "FR") {
  const res = await placesSearch(query, key, null, 20, country);
  if (res.error) return res;
  return { places: res.places.map(summarisePlace).filter((p) => p.status !== "CLOSED_PERMANENTLY") };
}

// Load a known place by id (fresh rating/reviews each month).
export async function placeById(id, key, country = "FR") {
  if (!key) return { error: "Google API key not set" };
  try {
    const r = await fetch(`https://places.googleapis.com/v1/places/${id}`, {
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS.replaceAll("places.", ""),
        "Accept-Language": langOf(country) },
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (!r.ok) return { error: j.error?.message?.slice(0, 200) || `HTTP ${r.status}` };
    return { place: summarisePlace(j) };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

// Position in Google's local results for a non-branded search, plus top competitors.
export async function mapRank(placeId, query, key, location, country = "FR") {
  const res = await placesSearch(query, key, location, 20, country);
  if (res.error) return res;
  const ids = res.places.map((p) => p.id);
  const pos = ids.indexOf(placeId);
  return {
    query,
    rank: pos >= 0 ? pos + 1 : null,
    out_of: ids.length,
    competitors: res.places.filter((p) => p.id !== placeId).slice(0, 3).map(summarisePlace),
  };
}

// ---- Map position from several points ----
// A single search from the business's own doorstep flatters it (Google favours what's closest, and a
// profile name containing the search words ranks first). Like a real customer, we search with plain
// keywords from a grid of points around the business and report how often it shows in the top 3.

const STOP = new Set(("le la les de des du d l et en au aux un une sur pour chez the and of a an sarl sas eurl " +
  "cabinet").split(" "));
const words = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]{4,}/g) || [];

// Distinctive words of the business name (not its trade or town, which profile names often repeat:
// "Caroline Lillaz psychologue Annecy" → caroline, lillaz), to keep branded searches out.
export function nameWords(name, generic = "") {
  const g = new Set(words(generic));
  return words(name).filter((w) => !STOP.has(w) && !g.has(w));
}
export const hasWord = (text, list) => { const t = new Set(words(text)); return list.some((w) => t.has(w)); };

// Points around a centre: 9 = 3×3 grid, 5 = centre plus north, south, east and west. dx/dy in steps.
export function gridPoints(center, n, km) {
  const steps = n >= 9 ? [[-1, 1], [0, 1], [1, 1], [-1, 0], [0, 0], [1, 0], [-1, -1], [0, -1], [1, -1]]
    : [[0, 1], [-1, 0], [0, 0], [1, 0], [0, -1]];
  const dLat = km / 111.32, dLng = km / (111.32 * Math.cos(center.latitude * Math.PI / 180));
  return steps.map(([dx, dy]) => ({ dx, dy, latitude: center.latitude + dy * dLat, longitude: center.longitude + dx * dLng }));
}

export async function mapGrid(placeId, keywords, key, center, country = "FR", { points = 9, km = 1.5 } = {}) {
  if (!center) return { error: "no location on the Google profile" };
  if (!keywords.length) return { error: "no search set" };
  const pts = gridPoints(center, points, km);
  const jobs = [];
  keywords.forEach((q, qi) => pts.forEach((p, pi) => jobs.push({ q, qi, pi, p })));
  const out = new Array(jobs.length);
  for (let i = 0; i < jobs.length; i += 6) {   // a few at a time, to stay gentle on Google's quota
    await Promise.all(jobs.slice(i, i + 6).map(async (j, k) => {
      out[i + k] = await placesSearch(j.q, key, { latitude: j.p.latitude, longitude: j.p.longitude }, 20, country, Math.max(1000, km * 1000));
    }));
  }
  const errors = out.filter((r) => r.error);
  if (errors.length === out.length) return { error: errors[0].error };
  const cells = [];
  let competitors = [];
  jobs.forEach((j, i) => {
    const r = out[i];
    if (r.error) return cells.push({ qi: j.qi, pi: j.pi, rank: undefined });
    const pos = r.places.findIndex((p) => p.id === placeId);
    cells.push({ qi: j.qi, pi: j.pi, rank: pos >= 0 ? pos + 1 : null });
    if (j.qi === 0 && j.p.dx === 0 && j.p.dy === 0)
      competitors = r.places.filter((p) => p.id !== placeId).slice(0, 3).map(summarisePlace);
  });
  const done = cells.filter((c) => c.rank !== undefined);
  const found = done.filter((c) => c.rank);
  const top3 = found.filter((c) => c.rank <= 3).length;
  const ranks = found.map((c) => c.rank);
  const avg = ranks.length ? Math.round(ranks.reduce((a, b) => a + b, 0) / ranks.length * 10) / 10 : null;
  return {
    query: keywords[0], queries: keywords, km, out_of: 20,
    points: pts.map((p, pi) => ({ dx: p.dx, dy: p.dy, ranks: keywords.map((_, qi) => cells.find((c) => c.qi === qi && c.pi === pi)?.rank ?? null) })),
    cells: done.length, found: found.length, top3, avg,
    best: ranks.length ? Math.min(...ranks) : null,
    worst: found.length === done.length && ranks.length ? Math.max(...ranks) : null,   // null = missing from some points
    // Kept for older screens: a rounded average, never the flattering doorstep position.
    rank: avg ? Math.round(avg) : null,
    competitors,
  };
}
