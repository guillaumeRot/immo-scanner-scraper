import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.cornier-immobilier.fr";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// Le moteur de recherche du site est 100% JS (plateforme Netty, aucune API de recherche
// trouvée), mais chaque fiche individuelle est servie en HTML complet (React SSR, avec
// un bloc JSON-LD structuré) — le sitemap.xml liste toutes les annonces actives, ce qui
// permet de découvrir les biens sans passer par la recherche.
async function fetchSitemapLinks(slugs) {
  const xml = await fetchHtml(`${BASE_URL}/sitemap.xml`);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return locs.filter(
    (url) =>
      /\/vente\/(maison|immeuble)[a-z0-9-]*,[A-Z]+\d+$/.test(url) &&
      slugs.some((slug) => url.includes(slug))
  );
}

// Certains biens restent en ligne avec leur prix affiché alors qu'ils sont déjà sous
// compromis ou vendus — l'information n'est pas dans un champ structuré dédié mais en
// préfixe de la description libre de l'agent (constaté : "SOUS COMPROMIS - ...").
const OFF_MARKET_MARKERS = /^(SOUS COMPROMIS|VENDU|COMPROMIS SIGN[EÉ]|OFFRE ACCEPT[EÉ]E)/i;
// Textes à ignorer lors de la recherche du bloc "description" le plus long (mentions
// légales/RGPD parfois plus longues que la vraie description du bien).
const EXCLUDED_TEXTBLOCKS = /RGPD|donn[ée]es personnelles|prospection commerciale|Honoraires inclus/i;

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const ldJsonRaw = $('script[type="application/ld+json"]').first().html();
  const ld = ldJsonRaw ? JSON.parse(ldJsonRaw) : null;
  const offer = ld?.offers;
  const item = offer?.itemOffered;

  const prix = offer?.price || 0;
  const ville = item?.address?.addressLocality || "";
  const pieces = item?.numberOfRooms || 0;
  const surface = item?.floorSize?.value || 0;
  const photos = (item?.photo || []).map((p) => p.url);
  const type = /\/immeuble/.test(url) ? "Immeuble" : "Maison";

  let description = "";
  let dpe = null;
  let ges = null;
  $("span.textblock").each((_, el) => {
    const t = $(el).text().trim();
    const m1 = t.match(/Classe énergie\s*([A-G])/i);
    const m2 = t.match(/Classe climat\s*([A-G])/i);
    if (m1) dpe = m1[1].toUpperCase();
    if (m2) ges = m2[1].toUpperCase();
    if (EXCLUDED_TEXTBLOCKS.test(t)) return;
    if (t.length > description.length) description = t;
  });

  const horsMarche = OFF_MARKET_MARKERS.test(description);

  return { type, prix, ville, pieces, surface, dpe, ges, description, photos, horsMarche };
}

export const cornierImmobilierScraper = async () => {
  const villeRows = await getVilleParams("cornier-immobilier");
  if (!villeRows.length) {
    console.warn("⚠️ Cornier Immobilier - Aucune ville configurée en base");
    return;
  }
  const slugs = villeRows.map((r) => r.params.slug);

  let links;
  try {
    links = await fetchSitemapLinks(slugs);
  } catch (err) {
    console.error(`❌ Cornier Immobilier - Erreur sur le sitemap: ${err.message}`);
    await insertErreur("Cornier Immobilier", `${BASE_URL}/sitemap.xml`, String(err));
    return;
  }
  console.log(`📌 Cornier Immobilier - ${links.length} annonces trouvées.`);

  const liensActuels = [];
  let horsMarcheIgnorees = 0;

  for (const url of links) {
    try {
      const data = await scrapeDetailPage(url);
      if (data.horsMarche) {
        horsMarcheIgnorees++;
        continue;
      }
      if (data.ville && data.prix) {
        await insertAnnonce({
          type: data.type,
          prix: data.prix,
          ville: data.ville,
          pieces: data.pieces,
          surface: data.surface,
          description: data.description,
          photos: data.photos,
          dpe: data.dpe,
          ges: data.ges,
          agence: "Cornier Immobilier",
          lien: url,
        });
        liensActuels.push(url);
      } else {
        console.warn(`⚠️ Cornier Immobilier - Données incomplètes pour ${url}`);
        await insertErreur("Cornier Immobilier", url, "Données incomplètes (ville ou prix manquant)");
      }
    } catch (err) {
      console.error(`❌ Cornier Immobilier - Erreur sur ${url}: ${err.message}`);
      await insertErreur("Cornier Immobilier", url, String(err));
    }
  }

  console.log(`ℹ️ Cornier Immobilier - ${horsMarcheIgnorees} annonces hors marché ignorées (sous compromis/vendu).`);
  await deleteMissingAnnonces("Cornier Immobilier", [...new Set(liensActuels)]);
  console.log("✅ Cornier Immobilier - Scraping terminé !");
};
