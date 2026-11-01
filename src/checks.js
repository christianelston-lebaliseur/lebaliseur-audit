// Scoring rubric (100 points across five sections) and implementation plan.

export const SECTIONS = {
  tech: "Technical health",
  onpage: "On-page SEO",
  local: "Local & Google profile",
  aeo: "AI search readiness",
  trust: "Trust & conversion",
  aivis: "Recommended by AI assistants",
};

export const plain = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const last9 = (p) => (p || "").replace(/\D/g, "").slice(-9);
const sum = (a, f) => a.reduce((n, x) => n + Number(f(x) || 0), 0);
const ratio = (n, d) => (d ? n / d : null);
const LOCAL_TYPES = ["LocalBusiness", "ProfessionalService", "MedicalBusiness", "Physician",
  "Psychologist", "MedicalClinic", "Restaurant", "FoodEstablishment", "Store", "HealthAndBeautyBusiness",
  "DaySpa", "LodgingBusiness", "Hotel", "SportsActivityLocation", "LegalService", "HomeAndConstructionBusiness",
  "AutomotiveBusiness", "EntertainmentBusiness", "TravelAgency", "Organization"];

// Street name from a Google address like "5 Rue Président Favre, 74000 Annecy, France".
export function streetOf(address) {
  const m = (address || "").match(/^\s*\d+[a-z]?\s*(?:bis|ter)?\s*,?\s*([^,]+),/i);
  return m ? m[1].trim() : "";
}
const postcodeOf = (address) => ((address || "").match(/\b\d{5}\b/) || [])[0] || "";

export function runChecks(ctx) {
  const { crawl, pagespeed: psi = {}, google = {}, rank = {} } = ctx;
  const site = crawl.site || {};
  const pages = crawl.pages || [];
  const ok = pages.filter((p) => p.status === 200 && "title" in p);
  // Pages judged on content quality: not hidden from Google on purpose (noindex) and not legal pages,
  // which are short by nature. Falls back to all pages if that leaves nothing.
  const LEGAL = /(mentions|legal|confidential|privacy|rgpd|cgv|cgu|terms|cookies)/i;
  const cq = ok.filter((p) => !p.noindex && !LEGAL.test(p.url)).length ? ok.filter((p) => !p.noindex && !LEGAL.test(p.url)) : ok;
  const home = ok[0] || { title: "", h1: [] };
  const gbp = google.place;
  const city = plain(ctx.city);
  const schema = [...new Set(ok.flatMap((p) => p.schema_types))];
  const sitePhones = new Set(ok.flatMap((p) => p.phones.map(last9)));
  const broken = pages.filter((p) => !p.status || p.status >= 400);
  const links = site.internal_urls || [];
  const like = (words) => [...pages.map((p) => p.url + " " + (p.title || "")), ...links]
    .filter((t) => words.some((w) => plain(t).includes(w)));
  // A page hidden from Google (noindex) is a problem only if it's the homepage or listed in the sitemap;
  // otherwise it was hidden on purpose (demo pages, thank-you pages…).
  const smSet = new Set((site.sitemap_urls || []).map((u) => u.replace(/\/$/, "")));
  const badNoindex = ok.filter((p, i) => p.noindex && (i === 0 || smSet.has(p.url.replace(/\/$/, ""))));
  const imgs = sum(ok.filter((p) => !p.noindex), (p) => p.images), noAlt = sum(ok.filter((p) => !p.noindex), (p) => p.images_no_alt);
  const R = [];

  const add = (id, section, label, points, fn, fix, effort) => {
    let fraction = null, detail = "";
    if (!["local", "aivis"].includes(section) && !site.reachable) detail = "website unreachable";
    else {
      try { [fraction, detail] = fn(); } catch (e) { detail = `could not check (${e.message})`; }
    }
    if (fraction !== null) fraction = Math.max(0, Math.min(1, fraction));
    R.push({ id, section, label, points, fraction, detail, fix, effort,
      earned: fraction === null ? null : +(points * fraction).toFixed(1) });
  };

  // ---------- Technical (25) ----------
  add("https", "tech", "Secure site (HTTPS, http redirects to it)", 4,
    () => [0.5 * site.https + 0.5 * site.http_redirects_to_https,
      `HTTPS ${site.https ? "yes" : "no"}, http→https redirect ${site.http_redirects_to_https ? "yes" : "no"}`],
    "Turn on an SSL certificate and force HTTPS with a permanent redirect.", "S");
  add("indexable", "tech", "Open to Google (no noindex, robots.txt allows)", 4,
    () => [site.robots_blocks_all ? 0 : 1 - ratio(badNoindex.length, ok.length),
      `${badNoindex.length} of ${ok.length} important pages hidden (noindex)` +
      (sum(ok, (p) => p.noindex) > badNoindex.length ? ` (${sum(ok, (p) => p.noindex) - badNoindex.length} hidden on purpose, not counted)` : "") +
      (site.robots_blocks_all ? "; robots.txt blocks everything" : "")],
    "Remove noindex tags and any “Disallow: /” in robots.txt.", "S");
  add("sitemap", "tech", "XML sitemap", 2,
    () => [site.sitemap ? 1 : 0, site.sitemap ? "found" : "no sitemap.xml"],
    "Publish sitemap.xml, list it in robots.txt and submit it in Search Console and Bing.", "S");
  add("broken", "tech", "No broken pages", 4,
    () => [1 - Math.min(1, 3 * ratio(broken.length, pages.length)),
      broken.length ? `${broken.length} broken: ${broken.slice(0, 3).map((p) => p.url).join(", ")}` : `0 of ${pages.length}`],
    "Fix or redirect the broken links.", "S");
  add("mobile", "tech", "Mobile-friendly (viewport)", 3,
    () => [ratio(sum(ok, (p) => p.viewport), ok.length), `${sum(ok, (p) => p.viewport)}/${ok.length} pages`],
    "Make the site responsive and check every page at phone width.", "M");
  add("speed", "tech", "Google PageSpeed, mobile", 8,
    () => psi.scores ? [psi.scores.performance / 100,
      `performance ${psi.scores.performance}/100, largest paint ${psi.lcp_s}s, layout shift ${psi.cls}`]
      : [null, psi.error || "not run"],
    "Compress and resize images, remove heavy scripts and plugins, use fast hosting.", "M");

  // ---------- On-page (25) ----------
  add("titles", "onpage", "Page titles 30–65 characters", 5,
    () => [ratio(sum(cq, (p) => p.title.length >= 30 && p.title.length <= 65), cq.length),
      `${sum(cq, (p) => p.title.length >= 30 && p.title.length <= 65)}/${cq.length} good · home: “${home.title}”`],
    "Write a title per page: service + town + name, under 65 characters.", "S");
  add("unique_titles", "onpage", "Unique titles", 2,
    () => [ratio(new Set(cq.map((p) => p.title)).size, cq.length), `${new Set(cq.map((p) => p.title)).size} unique of ${cq.length}`],
    "Give every page its own title.", "S");
  add("meta", "onpage", "Meta descriptions (70–160 characters)", 4,
    () => [ratio(sum(cq, (p) => p.meta_description.length >= 70 && p.meta_description.length <= 160), cq.length),
      `${sum(cq, (p) => p.meta_description.length >= 70 && p.meta_description.length <= 160)}/${cq.length} pages`],
    "Write a one- or two-sentence description per page that makes people want to click.", "S");
  add("h1", "onpage", "One H1 heading per page", 4,
    () => [ratio(sum(cq, (p) => p.h1.length === 1), cq.length), `${sum(cq, (p) => p.h1.length === 1)}/${cq.length} pages`],
    "Use exactly one main heading per page saying what it offers.", "S");
  add("city_title", "onpage", "Town in homepage title and H1", 4,
    () => {
      const t = plain(home.title).includes(city), h = home.h1.some((x) => plain(x).includes(city));
      return [0.5 * t + 0.5 * h, `title ${t ? "yes" : "no"}, H1 ${h ? "yes" : "no"}`];
    },
    `Put “${ctx.category || "activity"} ${ctx.city}” in the homepage title and main heading.`, "S");
  add("depth", "onpage", "Enough content (300+ words per page)", 3,
    () => [ratio(sum(cq, (p) => p.words >= 300), cq.length),
      `average ${Math.round(sum(cq, (p) => p.words) / Math.max(1, cq.length))} words per page`],
    "Expand thin pages: what you do, for whom, how, where, prices, questions.", "M");
  add("alt", "onpage", "Images described (alt text)", 3,
    () => imgs ? [1 - noAlt / imgs, `${noAlt} of ${imgs} images missing alt text`] : [null, "no images"],
    "Describe each image in its alt text.", "S");

  // ---------- Local (25) ----------
  const noGbp = () => [null, google.error || "no Google profile data"];
  // Searched and not found: that's a real zero, not a check that couldn't run.
  const zeroIfMissing = (msg) => google.notFound ? [0, msg] : noGbp();
  add("gbp", "local", "Google Business Profile found and open", 5,
    () => gbp ? [gbp.status && gbp.status !== "OPERATIONAL" ? 0.3 : 1, `${gbp.name} · ${gbp.category || "no category"}`] : zeroIfMissing("no Google profile found for this business"),
    "Claim or create the Google Business Profile and verify it.", "M");
  add("gbp_complete", "local", "Profile complete (hours, website, photos, description)", 4,
    () => gbp ? [(+gbp.has_hours + +!!gbp.website + Math.min(1, gbp.photos / 10) + +gbp.has_description) / 4,
      `hours ${gbp.has_hours ? "yes" : "no"}, website ${gbp.website ? "yes" : "no"}, photos ${gbp.photos}${gbp.photos >= 10 ? "+" : ""}, description ${gbp.has_description ? "yes" : "no"}`] : noGbp(),
    "Fill every field, add 10+ real photos, write a description with services and town.", "S");
  add("reviews", "local", "Reviews (count and rating)", 5,
    () => gbp ? [0.6 * Math.min(1, gbp.reviews / 50) + 0.4 * Math.max(0, ((gbp.rating || 0) - 3.5) / 1.5),
      `${gbp.rating ?? "–"}★ from ${gbp.reviews} reviews`] : zeroIfMissing("no Google reviews (no profile)"),
    "Ask every client for a review (QR code or short link), never offer anything in return, and reply to every review.", "M");
  add("map_rank", "local", "Position on Google Maps for the main search", 5,
    () => rank.out_of !== undefined ? [rank.rank ? 1 - (rank.rank - 1) / 10 : 0,
      `“${rank.query}”: ${rank.rank ? "position " + rank.rank : "not in top " + rank.out_of}`]
      : google.notFound ? [0, "not on Google Maps (no profile)"] : [null, rank.error || "not checked"],
    "Tighten category, reviews, local content and directory listings to climb the map.", "L");
  add("nap", "local", "Same address and phone on site as on Google", 4,
    () => {
      if (!gbp) return noGbp();
      const phone = !!gbp.phone && sitePhones.has(last9(gbp.phone));
      const pc = postcodeOf(gbp.address), st = streetOf(gbp.address);
      const addr = ok.some((p) => p.has_street) || (!st && ok.some((p) => p.postcodes.includes(pc)));
      return [0.5 * phone + 0.5 * addr,
        `phone ${gbp.phone || "none on Google"} ${phone ? "found" : "not found"} on site; address “${gbp.address}” ${addr ? "found" : "not found"} on site`];
    },
    "Show exactly the Google name, address and phone in the site footer, and match every directory to it.", "S");
  add("site_link", "local", "Profile links to this website", 2,
    () => gbp ? [gbp.website && ctx.siteHost && gbp.website.toLowerCase().includes(ctx.siteHost) ? 1 : 0,
      `profile website: ${gbp.website || "none"}`] : noGbp(),
    "Set the profile's website field to this site's homepage.", "S");

  // ---------- AI search readiness (15) ----------
  add("schema_local", "aeo", "Business structured data (schema.org)", 4,
    () => [schema.some((t) => LOCAL_TYPES.includes(t)) ? 1 : schema.length ? 0.3 : 0, schema.join(", ") || "none"],
    "Add LocalBusiness JSON-LD (right subtype) with address, phone, hours, geo and profile links.", "S");
  add("faq", "aeo", "Questions answered on the site (FAQ)", 3,
    () => schema.includes("FAQPage") ? [1, "FAQ structured data"]
      : ok.some((p) => p.has_faq_text) ? [0.6, "FAQ text, no structured data"] : [0, "none"],
    "Add an FAQ with the real questions clients ask: price, length, access, booking.", "M");
  add("ai_bots", "aeo", "AI assistants and Bing allowed to read the site", 3,
    () => [1 - site.ai_bots_blocked.length / 7, "blocked: " + (site.ai_bots_blocked.join(", ") || "none")],
    "Allow GPTBot, OAI-SearchBot, PerplexityBot, ClaudeBot and Bingbot in robots.txt.", "S");
  add("llms", "aeo", "llms.txt summary for AI", 1,
    () => [site.llms_txt ? 1 : 0, site.llms_txt ? "found" : "none"],
    "Publish /llms.txt: a plain summary of who you are, services, area and contact.", "S");
  add("service_pages", "aeo", "A page per service or topic", 4,
    () => [Math.min(1, Math.max(0, ok.length - 2) / 4), `${ok.length} pages`],
    "Create one page per main service, each answering who, what, where and how much.", "L");

  // ---------- Trust & conversion (10) ----------
  const uk = ctx.country === "GB";
  if (uk) add("legal", "trust", "Business details (terms or legal page)", 3,
    () => like(["legal", "terms", "company"]).length ? [1, "found"] : [0, "not found"],
    "Show the registered business name, address and, for a limited company, the company number on a terms or legal page.", "S");
  else add("legal", "trust", "Legal notice (mentions légales)", 3,
    () => like(["mentions", "legal"]).length ? [1, "found"] : [0, "not found (required in France)"],
    "Publish mentions légales: owner, SIRET, address, host.", "S");
  add("privacy", "trust", "Privacy policy", 2,
    () => like(["confidential", "privacy", "rgpd", "donnees", "cookies"]).length ? [1, "found"] : [0, "not found"],
    uk ? "Add a short privacy page (UK GDPR) covering forms and analytics." : "Add a short privacy page (RGPD) covering forms and analytics.", "S");
  add("contact", "trust", "Click-to-call and contact page", 2,
    () => {
      const t = ok.some((p) => p.tel_link);
      const c = like(["contact"]).length > 0 || ok.some((p) => p.has_form || p.mailto); // a contact form or email link counts
      return [0.5 * t + 0.5 * c, `click-to-call ${t ? "yes" : "no"}, contact form or page ${c ? "yes" : "no"}`];
    },
    "Make the phone number tappable and add a clear contact page.", "S");
  add("booking", "trust", "Online booking link", 3,
    () => {
      const b = [...new Set(ok.flatMap((p) => p.booking))];
      return [b.length ? 1 : 0, b.join(", ") || "none"];
    },
    uk ? "Link the booking tool (Calendly, Fresha, OpenTable…) prominently on every page."
      : "Link the booking tool (Doctolib, Zenchef…) prominently on every page.", "S");

  // ---------- Recommended by AI assistants (15) ----------
  // Real answers from ChatGPT / Perplexity / Gemini with web search (see ai.js).
  const ai = ctx.ai || {};
  const noAi = () => [null, ai.error || "not checked"];
  const engines = Object.values(ai.per_engine || {});
  const doms = (ai.top_domains || []).slice(0, 4).map((d) => d.name);
  add("ai_recommended", "aivis", "Named when people ask AI for this service", 10,
    () => ai.generic_total ? [ai.generic_named / ai.generic_total,
      `named in ${ai.generic_named} of ${ai.generic_total} answers (` +
      engines.filter((e) => e.of).map((e) => `${e.label} ${e.named}/${e.of}`).join(", ") + ")" +
      (ai.competitors_named?.length ? "; competitors named: " + ai.competitors_named.map((c) => `${c.name} ×${c.n}`).join(", ") : "")]
      : noAi(),
    doms.length ? `Get listed, with reviews, on the sites these assistants rely on for this search (${doms.join(", ")}), then answer the same questions on your own site.`
      : "Get listed and reviewed on the main directories for your activity, and answer clients' questions on your own site.", "L");
  add("ai_known", "aivis", "AI assistants know the business when asked by name", 3,
    () => ai.branded_total ? [ai.branded_known / ai.branded_total,
      engines.filter((e) => e.knows !== null).map((e) => `${e.label} ${e.knows ? "knows it" : "doesn't"}`).join(", ")]
      : noAi(),
    "Use exactly the same name, address and description on your site, Google profile and every directory, so assistants can identify you.", "M");
  add("ai_cited", "aivis", "Own website used as a source", 2,
    () => ai.answered ? [Math.min(1, ai.cited_site / Math.max(1, Math.ceil(ai.answered / 2))),
      `cited in ${ai.cited_site} of ${ai.answered} answers`] : noAi(),
    "Answer clients' questions plainly on the site (approach, prices, access, FAQ) so assistants quote it.", "M");
  return R;
}

export function score(results) {
  const sections = {};
  for (const k of Object.keys(SECTIONS)) sections[k] = { earned: 0, possible: 0, max: 0, pct: null };
  for (const r of results) {
    const s = sections[r.section];
    s.max += r.points;
    if (r.fraction !== null) { s.earned += r.points * r.fraction; s.possible += r.points; }
  }
  for (const s of Object.values(sections)) {
    s.pct = s.possible ? Math.round((100 * s.earned) / s.possible) : null;
    s.earned = +s.earned.toFixed(1);
  }
  const earned = Object.values(sections).reduce((n, s) => n + s.earned, 0);
  const possible = Object.values(sections).reduce((n, s) => n + s.possible, 0);
  return {
    total: possible ? Math.round((100 * earned) / possible) : 0,
    coverage: Math.round((100 * possible) / results.reduce((n, r) => n + r.points, 0)),
    sections,
  };
}

// Biggest gains first; quick wins break ties.
export function plan(results) {
  const er = { S: 0, M: 1, L: 2 };
  const todo = results.filter((r) => r.fraction !== null && r.fraction < 0.95)
    .map((r) => ({ ...r, gain: +(r.points * (1 - r.fraction)).toFixed(1) }))
    .sort((a, b) => b.gain / (1 + er[b.effort]) - a.gain / (1 + er[a.effort]));
  return {
    now: todo.filter((r) => r.effort === "S"),
    month: todo.filter((r) => r.effort === "M"),
    quarter: todo.filter((r) => r.effort === "L"),
  };
}

// What changed since the previous run.
export function compare(prev, cur) {
  if (!prev) return null;
  const pm = Object.fromEntries(prev.results.map((r) => [r.id, r]));
  const fixed = [], worse = [];
  for (const r of cur.results) {
    const p = pm[r.id];
    if (!p || p.fraction === null || r.fraction === null) continue;
    if (r.fraction - p.fraction >= 0.2) fixed.push({ label: r.label, from: p.detail, to: r.detail });
    if (p.fraction - r.fraction >= 0.2) worse.push({ label: r.label, from: p.detail, to: r.detail });
  }
  return { total_delta: cur.score.total - prev.score.total, prev_date: prev.date, fixed, worse };
}
