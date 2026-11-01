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
    const r = await fetch(`${PSI}?${q}`, { signal: AbortSignal.timeout(110000) });
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

async function placesSearch(textQuery, key, location, pageSize = 20) {
  if (!key) return { error: "Google API key not set" };
  // Include businesses that hide their address and serve an area (home-based trades, consultants…),
  // which Google leaves out by default.
  const body = { textQuery, languageCode: "fr", regionCode: "FR", pageSize, includePureServiceAreaBusinesses: true };
  if (location) body.locationBias = { circle: { center: location, radius: 8000 } };
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

// Load a known place by id (fresh rating/reviews each month).
export async function placeById(id, key) {
  if (!key) return { error: "Google API key not set" };
  try {
    const r = await fetch(`https://places.googleapis.com/v1/places/${id}`, {
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS.replaceAll("places.", ""),
        "Accept-Language": "fr" },
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
export async function mapRank(placeId, query, key, location) {
  const res = await placesSearch(query, key, location, 20);
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
