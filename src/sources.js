// External data: Google PageSpeed Insights and Google Places (Business Profile).

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
  const body = { textQuery, languageCode: "fr", regionCode: "FR", pageSize };
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

// Find a business by name; returns the best match plus alternatives.
export async function findBusiness(name, city, key) {
  const res = await placesSearch(`${name} ${city}`.trim(), key, null, 5);
  if (res.error) return res;
  if (!res.places.length) return { error: "Not found on Google Maps" };
  return { place: summarisePlace(res.places[0]), alternatives: res.places.slice(1).map(summarisePlace) };
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
