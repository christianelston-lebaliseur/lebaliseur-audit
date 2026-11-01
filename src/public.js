import { normSite } from "./crawl.js";

// Public visibility check: no login, email required, shows the score and top 3 priorities,
// and records the person as a lead linked to the full report in the private app.

const SECTION_FR = {
  tech: ["Santé technique", "Technical health"],
  onpage: ["Référencement des pages", "On-page SEO"],
  local: ["Fiche Google & local", "Local & Google profile"],
  aeo: ["Visibilité dans les IA", "AI search readiness"],
  trust: ["Confiance & contact", "Trust & conversion"],
  aivis: ["Recommandé par les IA", "Recommended by AI"],
};

// French wording for each check: [label, fix]. English comes from checks.js.
const FR = {
  https: ["Site sécurisé (HTTPS)", "Activer le certificat SSL et rediriger tout le site en HTTPS."],
  indexable: ["Site ouvert à Google", "Retirer les balises noindex et tout blocage dans robots.txt."],
  sitemap: ["Plan du site (sitemap)", "Publier un sitemap.xml et le déclarer à Google et Bing."],
  broken: ["Aucune page cassée", "Corriger ou rediriger les liens qui mènent à des pages introuvables."],
  mobile: ["Adapté au mobile", "Rendre le site lisible et utilisable sur téléphone."],
  speed: ["Vitesse sur mobile (Google)", "Alléger les images et les scripts, choisir un hébergement rapide."],
  titles: ["Titres de pages efficaces", "Un titre par page : service + ville + nom, en moins de 65 caractères."],
  unique_titles: ["Titres uniques", "Donner à chaque page son propre titre."],
  meta: ["Descriptions dans Google", "Écrire pour chaque page une description qui donne envie de cliquer."],
  h1: ["Un titre principal par page", "Un seul titre principal (H1) par page, qui dit ce qu'elle propose."],
  city_title: ["Votre ville dans le titre", "Mettre « activité + ville » dans le titre et le titre principal de l'accueil."],
  depth: ["Contenu suffisant", "Étoffer les pages : quoi, pour qui, comment, où, à quel prix."],
  alt: ["Images décrites", "Décrire chaque image (texte alternatif)."],
  gbp: ["Fiche Google Business", "Revendiquer, compléter et valider votre fiche Google."],
  gbp_complete: ["Fiche Google complète", "Horaires, site, description et au moins 10 vraies photos."],
  reviews: ["Avis Google", "Demander un avis à chaque client satisfait et répondre à tous les avis."],
  map_rank: ["Position sur Google Maps", "Travailler catégorie, avis, contenu local et annuaires pour remonter sur la carte."],
  nap: ["Adresse et téléphone cohérents", "Afficher exactement la même adresse et le même numéro que sur Google, partout."],
  site_link: ["Fiche reliée au site", "Indiquer l'adresse du site dans la fiche Google."],
  schema_local: ["Données structurées", "Ajouter les données structurées « entreprise locale » au site."],
  faq: ["Réponses aux questions (FAQ)", "Ajouter une FAQ avec les vraies questions de vos clients."],
  ai_bots: ["Lisible par ChatGPT & co", "Autoriser les robots des assistants IA et de Bing."],
  llms: ["Fichier llms.txt", "Publier un résumé simple de votre activité pour les IA."],
  service_pages: ["Une page par service", "Créer une page dédiée à chaque service principal."],
  legal: ["Mentions légales", "Publier les mentions légales obligatoires."],
  privacy: ["Politique de confidentialité", "Ajouter une page confidentialité (RGPD)."],
  contact: ["Appel en un clic & contact", "Rendre le numéro cliquable et ajouter une page contact claire."],
  booking: ["Réservation en ligne", "Mettre le lien de réservation (Doctolib, Zenchef…) sur chaque page."],
  ai_recommended: ["Cité quand on demande à une IA", "Être présent et bien noté sur les sites que ChatGPT et Perplexity consultent pour votre activité, et répondre aux mêmes questions sur votre site."],
  ai_known: ["Connu des IA sous votre nom", "Utiliser exactement le même nom, la même adresse et la même description partout : site, fiche Google, annuaires."],
  ai_cited: ["Votre site cité comme source", "Répondre clairement sur votre site aux questions de vos clients (approche, tarifs, accès, FAQ)."],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function hashIp(ip, salt) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((salt || "") + ip));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function turnstileOk(env, tokenValue, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST", body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: tokenValue || "", remoteip: ip }),
  });
  return (await r.json()).success === true;
}

// Step 1 of the public check: show the person the Google profiles found for the name they typed,
// so they confirm which one is theirs. No lead is recorded here.
// deps: { db, findCandidates }
export async function publicLookup(req, env, deps) {
  const b = await req.json().catch(() => ({}));
  const business = (b.business || "").trim().slice(0, 120);
  const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (!business || !env.GOOGLE_API_KEY) return out({ candidates: [], best: -1 });
  const D = await deps.db(env);
  const ipHash = await hashIp(req.headers.get("cf-connecting-ip") || "unknown", env.APP_PASSWORD);
  const perIp = await D.prepare("SELECT COUNT(*) n FROM lookups WHERE ip_hash=? AND date > datetime('now','-1 day')").bind(ipHash).first();
  const perDay = await D.prepare("SELECT COUNT(*) n FROM lookups WHERE date > datetime('now','-1 day')").first();
  // Over the limit: skip the confirmation step; the check itself still runs (and has its own limits).
  if (perIp.n >= 20 || perDay.n >= 300) return out({ candidates: [], best: -1, skipped: true });
  await D.prepare("INSERT INTO lookups (ip_hash, date) VALUES (?, datetime('now'))").bind(ipHash).run();
  await D.prepare("DELETE FROM lookups WHERE date < datetime('now','-2 days')").run();
  const city = (b.city || "").trim().slice(0, 60) || "Annecy";
  const r = await deps.findCandidates(business, city, env.GOOGLE_API_KEY, normSite((b.site || "").slice(0, 200)));
  if (r.error) return out({ candidates: [], best: -1 });
  return out({ best: r.best, candidates: r.candidates.map((p) => ({ id: p.id, name: p.name, address: p.address,
    rating: p.rating, reviews: p.reviews, category: p.category, website: p.website })) });
}

const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

// deps: { db, audit, saveRun, findBusiness, placeById }
export async function publicCheck(req, env, deps) {
  const b = await req.json().catch(() => ({}));
  const en = b.lang === "en";
  const t = (fr, enText) => (en ? enText : fr);
  const fail = (fr, enText, status = 400) => new Response(JSON.stringify({ error: t(fr, enText) }),
    { status, headers: { "content-type": "application/json" } });

  const business = (b.business || "").trim().slice(0, 120);
  const email = (b.email || "").trim().slice(0, 160);
  if (!business) return fail("Indiquez le nom de votre entreprise.", "Enter your business name.");
  if (!EMAIL_RE.test(email)) return fail("Indiquez une adresse e-mail valide.", "Enter a valid email address.");
  if (!b.consent) return fail("Merci de cocher la case d'accord.", "Please tick the consent box.");

  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  if (!(await turnstileOk(env, b.ts, ip))) return fail("Vérification anti-robot échouée, réessayez.", "Bot check failed, please try again.");
  const D = await deps.db(env);
  const ipHash = await hashIp(ip, env.APP_PASSWORD);
  const perIp = await D.prepare("SELECT COUNT(*) n FROM leads WHERE ip_hash=? AND date > datetime('now','-1 day')").bind(ipHash).first();
  const perDay = await D.prepare("SELECT COUNT(*) n FROM leads WHERE date > datetime('now','-1 day')").first();
  if (perIp.n >= 3) return fail("Vous avez atteint la limite de 3 diagnostics par jour.", "You've reached the limit of 3 checks per day.", 429);
  if (perDay.n >= +(env.PUBLIC_DAILY_LIMIT || 40)) return fail("Trop de demandes aujourd'hui, réessayez demain.", "Too many checks today, please try tomorrow.", 429);

  const city = (b.city || "").trim().slice(0, 60) || "Annecy";
  const category = (b.category || "").trim().slice(0, 60);
  const site = normSite((b.site || "").slice(0, 200));
  // Optional: how customers search for them, in their words. Used as the AI question.
  const search = (b.search || "").replace(/[«»"<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  const lead = await D.prepare(`INSERT INTO leads (date, first_name, email, phone, business, city, category, site, consent, lang, ip_hash, status, search)
    VALUES (datetime('now'),?,?,?,?,?,?,?,1,?,?,'running',?)`)
    .bind((b.first_name || "").trim().slice(0, 60), email, (b.phone || "").trim().slice(0, 30), business, city, category, site,
      en ? "en" : "fr", ipHash, search || null).run();
  const leadId = lead.meta.last_row_id;

  // The person confirmed their Google profile (or that they have none) in step 1; otherwise search as before.
  const noProfile = b.no_profile === true;
  let found = null;
  if (!noProfile && PLACE_ID_RE.test(b.place_id || "")) {
    found = await deps.placeById(b.place_id, env.GOOGLE_API_KEY);
    if (!found.place) found = null; // unusable id: fall back to the normal search
  }
  if (noProfile) found = { error: "No Google profile (confirmed by the business)", notFound: true };
  if (!found) found = await deps.findBusiness(business, city, env.GOOGLE_API_KEY, { strict: true, site });
  if (!found.place && !site) {
    await D.prepare("UPDATE leads SET status='not_found' WHERE id=?").bind(leadId).run();
    return fail("Nous n'avons pas trouvé cette entreprise sur Google. Ajoutez votre site web ou précisez le nom.",
      "We couldn't find this business on Google. Add your website or a more precise name.", 404);
  }

  // Reuse an existing client/prospect for the same Google listing, otherwise create a prospect.
  let clientId = found.place ? (await D.prepare("SELECT id FROM clients WHERE place_id=?").bind(found.place.id).first())?.id
    : (await D.prepare("SELECT id FROM clients WHERE site=? AND place_id IS NULL").bind(site).first())?.id;
  if (!clientId) {
    const c = await D.prepare("INSERT INTO clients (name, city, category, site, query, place_id, notes, prospect) VALUES (?,?,?,?,?,?,?,1)")
      .bind(found.place?.name || business, city, category, site, "", found.place?.id || null, `Lead: ${email}`).run();
    clientId = c.meta.last_row_id;
  }
  const client = await D.prepare("SELECT * FROM clients WHERE id=?").bind(clientId).first();
  const run = await deps.saveRun(env, clientId, await deps.audit(env, client, { public: true, noProfile, aiQuery: search || null }));
  await D.prepare("UPDATE leads SET status='done', client_id=?, run_id=?, total=? WHERE id=?")
    .bind(clientId, run.id, run.score.total, leadId).run();

  const top = [...run.plan.now, ...run.plan.month, ...run.plan.quarter]
    .sort((a, b) => b.gain - a.gain).slice(0, 3)
    .map((r) => ({ label: en ? r.label : FR[r.id]?.[0] || r.label, fix: en ? r.fix : FR[r.id]?.[1] || r.fix }));
  await notify(env, { leadId, en, business: run.google?.name || business, city, email, search,
    first_name: (b.first_name || "").trim(), phone: (b.phone || "").trim(), site: run.site, total: run.score.total, top, clientId, reqUrl: req.url });
  return new Response(JSON.stringify({
    business: run.google?.name || business,
    address: run.google?.address || null,
    rating: run.google?.rating ?? null,
    reviews: run.google?.reviews ?? null,
    site: run.site || null,
    total: run.score.total,
    coverage: run.score.coverage,
    // The AI area only appears once it has actually run (an AI key is set).
    sections: Object.entries(run.score.sections).filter(([k, s]) => k !== "aivis" || s.pct != null).map(([k, s]) => ({ name: (SECTION_FR[k] || [k, k])[en ? 1 : 0], pct: s.pct })),
    top,
  }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// Optional emails through Brevo (same account as the website form):
// a lead alert to MAIL_TO, and the person's own result. Failures never block the check.
async function notify(env, d) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM || !env.MAIL_TO) return;
  const e = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const send = (payload) => fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
  const origin = new URL(d.reqUrl).origin;
  const list = d.top.map((p) => `<li><strong>${e(p.label)}</strong><br>${e(p.fix)}</li>`).join("");
  await send({
    sender: { name: "Le Baliseur (diagnostic)", email: env.MAIL_FROM },
    to: [{ email: env.MAIL_TO }],
    replyTo: { email: d.email, name: d.first_name || d.business },
    subject: `Diagnostic en ligne : ${d.business} · ${d.total}/100`,
    htmlContent: `<h2>Nouveau diagnostic en ligne</h2><p><strong>${e(d.business)}</strong> (${e(d.city)}) · score <strong>${d.total}/100</strong></p>
      <p>${e(d.first_name)} · ${e(d.email)}${d.phone ? " · " + e(d.phone) : ""}<br>Site : ${e(d.site || "aucun")}${d.search ? "<br>Recherche indiquée : « " + e(d.search) + " »" : ""}</p>
      <ol>${list}</ol><p><a href="${origin}/#/c/${d.clientId}">Ouvrir le rapport complet</a></p>`,
  });
  const en = d.en;
  await send({
    sender: { name: "Chris Elston · Le Baliseur", email: env.MAIL_FROM },
    to: [{ email: d.email, name: d.first_name || undefined }],
    replyTo: { email: env.MAIL_TO, name: "Chris Elston" },
    subject: en ? `Your visibility score: ${d.total}/100` : `Votre score de visibilité : ${d.total}/100`,
    htmlContent: (en
      ? `<p>Hello${d.first_name ? " " + e(d.first_name) : ""},</p><p>Thanks for running the Le Baliseur visibility check for <strong>${e(d.business)}</strong>. Your score: <strong>${d.total}/100</strong>.</p><p>Your three priorities:</p><ol>${list}</ol><p>The full report covers around thirty checks, your exact map position against three competitors and a step-by-step plan. Just reply to this email if you'd like me to go through it with you, free and with no commitment.</p><p>Chris Elston<br>Le Baliseur · Annecy</p>`
      : `<p>Bonjour${d.first_name ? " " + e(d.first_name) : ""},</p><p>Merci d'avoir fait le diagnostic de visibilité du Baliseur pour <strong>${e(d.business)}</strong>. Votre score : <strong>${d.total}/100</strong>.</p><p>Vos trois priorités :</p><ol>${list}</ol><p>Le rapport complet comprend une trentaine de points, votre position exacte face à trois concurrents et un plan étape par étape. Répondez simplement à cet e-mail si vous souhaitez que je vous le présente, gratuitement et sans engagement.</p><p>Chris Elston<br>Le Baliseur · Annecy</p>`),
  });
}
