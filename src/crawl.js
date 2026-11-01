// Site crawler for Cloudflare Workers: fetches up to N pages of one site and
// records SEO facts per page, using the built-in streaming HTMLRewriter.

const UA = "Mozilla/5.0 (compatible; LeBaliseurAudit/1.0; +https://lebaliseur.fr)";
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|ico|css|js|xml|txt)$/i;
const PHONE_RE = /(?:\+33\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}/g;
export const BOOKING_HOSTS = ["doctolib", "zenchef", "thefork", "lafourchette", "calendly", "resalib",
  "planity", "booking.com", "reservit", "amenitiz", "lodgify", "mews", "fresha", "treatwell",
  "funbooker", "crenolib", "maiia", "keldoc", "simplybook", "sumup", "guestonline",
  "cal.com", "calendar.app.google", "calendar.google.com/calendar/appointments", "tidycal", "zcal", "acuityscheduling"];
const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot",
  "Google-Extended", "Bingbot"];

export const normHost = (h) => (h || "").toLowerCase().replace(/^www\./, "");

async function get(url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" },
      signal: AbortSignal.timeout(20000),
      ...opts,
    });
    return { r, ms: Date.now() - t0 };
  } catch (e) {
    return { error: String(e.message || e), ms: Date.now() - t0 };
  }
}

async function getText(url) {
  const { r } = await get(url);
  if (!r || r.status !== 200) return "";
  return (await r.text()).slice(0, 200000);
}

// Parse one HTML response into page facts.
export async function parsePage(resp, city, street = "") {
  const finalUrl = resp.url;
  const host = normHost(new URL(finalUrl).hostname);
  const p = {
    url: finalUrl, status: resp.status, title: "", meta_description: "", h1: [], h2_count: 0,
    canonical: null, noindex: false, lang: null, viewport: false, words: 0, city_mentions: 0,
    phones: [], tel_link: false, schema_types: [], schema: [], images: 0, images_no_alt: 0,
    internal_links: [], external_links: 0, booking: [], has_faq_text: false, mixed_content: false,
    generator: "", has_form: false, mailto: false,
  };
  let text = "", title = "", inTitle = false, h1buf = null, ld = null, lds = [];
  const internal = new Set(), booking = new Set();
  let skipDepth = 0;

  const addLink = (href) => {
    if (!href) return;
    href = href.trim();
    if (href.startsWith("tel:")) { p.tel_link = true; return; }
    if (/^mailto:/i.test(href)) { p.mailto = true; return; }
    if (/^(mailto:|javascript:|#)/i.test(href)) return;
    let u;
    try { u = new URL(href, finalUrl); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = "";
    if (normHost(u.hostname) === host) internal.add(u.toString());
    else {
      p.external_links++;
      if (BOOKING_HOSTS.some((b) => u.hostname.includes(b))) booking.add(u.hostname);
    }
  };

  const rw = new HTMLRewriter()
    .on("html", { element(e) { p.lang = e.getAttribute("lang"); } })
    .on("title", {
      element(e) { inTitle = true; e.onEndTag(() => { inTitle = false; }); },
      text(t) { if (inTitle) title += t.text; },
    })
    .on("meta", {
      element(e) {
        const n = (e.getAttribute("name") || "").toLowerCase();
        const c = e.getAttribute("content") || "";
        if (n === "description") p.meta_description = c.trim();
        if (n === "robots" && /noindex/i.test(c)) p.noindex = true;
        if (n === "viewport") p.viewport = true;
        if (n === "generator") p.generator = c;
      },
    })
    .on("link[rel=canonical]", { element(e) { p.canonical = e.getAttribute("href"); } })
    .on("h1", {
      element(e) { h1buf = ""; e.onEndTag(() => { p.h1.push(h1buf.trim().replace(/\s+/g, " ")); h1buf = null; }); },
      text(t) { if (h1buf !== null) h1buf += t.text; },
    })
    .on("h2", { element() { p.h2_count++; } })
    .on("form", { element() { p.has_form = true; } })
    .on("a[href]", { element(e) { addLink(e.getAttribute("href")); } })
    .on("iframe[src]", {
      element(e) {
        const s = e.getAttribute("src") || "";
        const b = BOOKING_HOSTS.find((h) => s.includes(h));
        if (b) { try { booking.add(new URL(s, finalUrl).hostname); } catch { booking.add(b); } }
      },
    })
    .on("img", {
      element(e) {
        p.images++;
        // alt="" is the correct way to mark a decorative image; only a missing alt is a problem.
        if (e.getAttribute("alt") === null) p.images_no_alt++;
        const src = e.getAttribute("src") || "";
        if (finalUrl.startsWith("https:") && src.startsWith("http:")) p.mixed_content = true;
      },
    })
    .on('script[type="application/ld+json"]', {
      element(e) { ld = ""; e.onEndTag(() => { lds.push(ld); ld = null; }); },
      text(t) { if (ld !== null) ld += t.text; },
    })
    .on('script:not([type="application/ld+json"]), style, noscript, svg', {
      element(e) { skipDepth++; e.onEndTag(() => { skipDepth--; }); },
    })
    .on("body", {
      text(t) { if (!skipDepth && text.length < 300000) text += t.text + (t.lastInTextNode ? " " : ""); },
    });

  await rw.transform(resp).arrayBuffer();

  const decode = (x) => x.replace(/&amp;/g, "&").replace(/&nbsp;|&#160;/g, " ").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&#8217;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  p.title = decode(title).trim().replace(/\s+/g, " ");
  p.meta_description = decode(p.meta_description);
  text = text.replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
  p.words = text ? text.split(" ").length : 0;
  const low = text.toLowerCase();
  if (city) p.city_mentions = low.split(city.toLowerCase()).length - 1;
  p.phones = [...new Set((text.match(PHONE_RE) || []).map((x) => x.replace(/[\s.-]/g, "")))].slice(0, 5);
  const plain = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  p.postcodes = [...new Set(text.match(/\b(?:0[1-9]|[1-8]\d|9[0-5])\d{3}\b/g) || [])].slice(0, 5);
  p.has_street = !!street && plain(text).includes(plain(street));
  p.has_faq_text = /\b(faq|questions fréquentes|questions frequentes|foire aux questions)\b/i.test(low);

  const types = new Set();
  for (const raw of lds) {
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const stack = Array.isArray(data) ? [...data] : [data];
    while (stack.length) {
      const d = stack.pop();
      if (Array.isArray(d)) { stack.push(...d); continue; }
      if (!d || typeof d !== "object") continue;
      if (d["@graph"]) stack.push(...[].concat(d["@graph"]));
      const t = d["@type"];
      if (t) { [].concat(t).forEach((x) => types.add(x)); if (p.schema.length < 6) p.schema.push(d); }
    }
  }
  p.schema_types = [...types].sort();
  p.internal_links = [...internal];
  p.booking = [...booking];
  return p;
}

function robotsBlocks(robots, agent) {
  // True if a group naming `agent` (or * when agent is "*") disallows "/".
  const groups = robots.split(/\n(?=\s*user-agent:)/i);
  for (const g of groups) {
    const agents = [...g.matchAll(/user-agent:\s*(\S+)/gi)].map((m) => m[1].toLowerCase());
    if (!agents.includes(agent.toLowerCase())) continue;
    if (/^\s*disallow:\s*\/\s*$/im.test(g)) return true;
  }
  return false;
}

export async function crawl(startUrl, city = "", maxPages = 25, street = "") {
  const out = { start_url: startUrl, pages: [], errors: [], site: {} };
  const s = out.site;
  let start;
  try { start = new URL(/^https?:\/\//.test(startUrl) ? startUrl : "https://" + startUrl); }
  catch { out.errors.push("Invalid website address"); s.reachable = false; return out; }

  const httpProbe = await get(`http://${start.hostname}/`);
  s.http_redirects_to_https = !!(httpProbe.r && httpProbe.r.url.startsWith("https://"));
  const home = await get(start.toString());
  if (!home.r) { out.errors.push(`Homepage unreachable: ${home.error}`); s.reachable = false; return out; }
  s.reachable = home.r.status < 400;
  s.final_url = home.r.url;
  s.https = home.r.url.startsWith("https://");
  s.home_response_ms = home.ms;
  s.server = home.r.headers.get("server") || "";

  const base = new URL(home.r.url).origin;
  const robots = await getText(base + "/robots.txt");
  s.robots_txt = !!robots;
  s.robots_blocks_all = robotsBlocks(robots, "*");
  s.ai_bots_blocked = AI_BOTS.filter((b) => robotsBlocks(robots, b));
  const smUrl = (robots.match(/sitemap:\s*(\S+)/i) || [])[1] || base + "/sitemap.xml";
  const sm = await getText(smUrl);
  s.sitemap = /<(urlset|sitemapindex)/i.test(sm);
  const llms = await getText(base + "/llms.txt");
  s.llms_txt = !!llms && !/<html/i.test(llms.slice(0, 500));

  const seen = new Set([home.r.url]);
  const queue = [{ url: home.r.url, resp: home.r }];
  while (queue.length && out.pages.length < maxPages) {
    const { url } = queue[0];
    let { resp } = queue.shift();
    if (!resp) {
      const g = await get(url);
      if (!g.r) { out.pages.push({ url, status: 0, error: g.error }); continue; }
      resp = g.r;
    }
    if (resp.status >= 400) { out.pages.push({ url, status: resp.status }); continue; }
    if (!(resp.headers.get("content-type") || "").includes("text/html")) continue;
    const page = await parsePage(resp, city, street);
    if (!s.generator && page.generator) s.generator = page.generator;
    out.pages.push(page);
    for (const link of page.internal_links) {
      const path = new URL(link).pathname;
      if (!seen.has(link) && !SKIP_EXT.test(path)) { seen.add(link); queue.push({ url: link }); }
    }
  }
  s.pages_found = seen.size;
  for (const [name, sig] of [["Wix", "wix"], ["Jimdo", "jimdo"], ["WordPress", "wordpress"],
    ["Squarespace", "squarespace"], ["Webflow", "webflow"]]) {
    if (!s.generator && (s.server.toLowerCase().includes(sig))) s.generator = name;
  }
  return out;
}
