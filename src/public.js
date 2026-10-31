// Public visibility check: no login, email required, shows the score and top 3 priorities,
// and records the person as a lead linked to the full report in the private app.

const SECTION_FR = {
  tech: ["Santé technique", "Technical health"],
  onpage: ["Référencement des pages", "On-page SEO"],
  local: ["Fiche Google & local", "Local & Google profile"],
  aeo: ["Visibilité dans les IA", "AI search readiness"],
  trust: ["Confiance & contact", "Trust & conversion"],
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

// deps: { db, audit, saveRun, findBusiness }
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
  const site = (b.site || "").trim().slice(0, 200);
  const lead = await D.prepare(`INSERT INTO leads (date, first_name, email, phone, business, city, category, site, consent, lang, ip_hash, status)
    VALUES (datetime('now'),?,?,?,?,?,?,?,1,?,?,'running')`)
    .bind((b.first_name || "").trim().slice(0, 60), email, (b.phone || "").trim().slice(0, 30), business, city, category, site,
      en ? "en" : "fr", ipHash).run();
  const leadId = lead.meta.last_row_id;

  const found = await deps.findBusiness(business, city, env.GOOGLE_API_KEY);
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
  const run = await deps.saveRun(env, clientId, await deps.audit(env, client));
  await D.prepare("UPDATE leads SET status='done', client_id=?, run_id=?, total=? WHERE id=?")
    .bind(clientId, run.id, run.score.total, leadId).run();

  const top = [...run.plan.now, ...run.plan.month, ...run.plan.quarter]
    .sort((a, b) => b.gain - a.gain).slice(0, 3)
    .map((r) => ({ label: en ? r.label : FR[r.id]?.[0] || r.label, fix: en ? r.fix : FR[r.id]?.[1] || r.fix }));
  return new Response(JSON.stringify({
    business: run.google?.name || business,
    address: run.google?.address || null,
    rating: run.google?.rating ?? null,
    reviews: run.google?.reviews ?? null,
    site: run.site || null,
    total: run.score.total,
    coverage: run.score.coverage,
    sections: Object.entries(run.score.sections).map(([k, s]) => ({ name: SECTION_FR[k][en ? 1 : 0], pct: s.pct })),
    top,
  }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
