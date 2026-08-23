import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

// Agence "Alternative Immobilier", franchisée du réseau national ArthurImmo.com —
// sous-domaine propre à cette agence (Châteaubourg).
const BASE_URL = "https://chateaubourg.arthurimmo.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

async function scrapeListPage(slug) {
  const html = await fetchHtml(`${BASE_URL}/immobilier/achat/immo-${slug}/bien-maison`);
  const $ = cheerio.load(html);
  const links = new Set();
  $("a[href*='/annonces/achat/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.add(href);
  });
  return [...links];
}

// Certains biens restent en ligne avec leur prix affiché alors qu'ils sont déjà sous
// offre/vendus — l'info est en préfixe de la description libre, pas dans un champ dédié
// (constaté : "TROP TARD... CE BIEN EST SOUS OFFRE AU PRIX.").
const OFF_MARKET_MARKERS = /SOUS OFFRE|SOUS COMPROMIS|VENDU|TROP TARD|COMPROMIS SIGN[EÉ]/i;

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Le titre JSON-LD condense tout : "Acheter maison de 5 pièces 152 m² 194 250 € à
  // Vitré (35500) : une annonce Arthurimmo.com"
  const ldRaw = $('script[type="application/ld+json"]').first().html();
  const ld = ldRaw ? JSON.parse(ldRaw) : null;
  const name = ld?.name || "";
  const m = name.match(
    /Acheter\s+(maison|immeuble|appartement)\s+de\s+(\d+)\s*pi[eè]ces?\s+(\d+)\s*m²\s+([\d\s]+?)\s*€\s+à\s+(.+?)\s*\((\d{5})\)/i
  );
  const typeRaw = m?.[1]?.toLowerCase() || "";
  const type = typeRaw === "maison" ? "Maison" : typeRaw === "immeuble" ? "Immeuble" : null;
  const pieces = parseInt(m?.[2]) || 0;
  const surface = parseInt(m?.[3]) || 0;
  const prix = parseInt((m?.[4] || "").replace(/\s/g, "")) || 0;
  const ville = m?.[5]?.trim() || "";

  let chambres = 0;
  $("div.text-gray-900").each((_, el) => {
    if ($(el).text().trim() === "Nombre de chambres") {
      chambres = parseInt($(el).next(".text-gray-900").text()) || 0;
    }
  });

  const description = $('p[x-init*="clamped"]').first().text().replace(/\s+/g, " ").trim();
  const horsMarche = OFF_MARKET_MARKERS.test(description);

  // Les photos embarquent l'id de l'annonce dans leur chemin (pas de risque de mélange
  // avec des biens similaires suggérés ailleurs sur la page).
  const photos = [...new Set(
    $("img[src*='media.studio-net.fr']").map((_, el) => $(el).attr("src")?.split("?")[0]).get()
  )];

  return { type, ville, prix, pieces, surface, chambres, description, photos, horsMarche };
}

export const alternativeImmobilierScraper = async () => {
  const villeRows = await getVilleParams("alternative-immobilier");
  if (!villeRows.length) {
    console.warn("⚠️ Alternative Immobilier - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];
  const liensVus = new Set();
  let horsMarcheIgnorees = 0;

  for (const row of villeRows) {
    let links;
    try {
      links = await scrapeListPage(row.params.slug);
    } catch (err) {
      console.error(`❌ Alternative Immobilier - Erreur sur la page de liste (${row.nom}): ${err.message}`);
      await insertErreur("Alternative Immobilier", row.nom, String(err));
      continue;
    }
    console.log(`📌 Alternative Immobilier - ${row.nom} : ${links.length} annonces trouvées.`);

    for (const url of links) {
      if (liensVus.has(url)) continue; // chevauchement possible entre secteurs voisins
      liensVus.add(url);
      try {
        const data = await scrapeDetailPage(url);
        if (data.horsMarche) {
          horsMarcheIgnorees++;
          continue;
        }
        if (data.ville && data.prix && data.type) {
          await insertAnnonce({
            type: data.type,
            prix: data.prix,
            ville: data.ville,
            pieces: data.pieces,
            chambres: data.chambres,
            surface: data.surface,
            description: data.description,
            photos: data.photos,
            agence: "Alternative Immobilier",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Alternative Immobilier - Données incomplètes pour ${url}`);
          await insertErreur("Alternative Immobilier", url, "Données incomplètes (ville, type ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Alternative Immobilier - Erreur sur ${url}: ${err.message}`);
        await insertErreur("Alternative Immobilier", url, String(err));
      }
    }
  }

  console.log(`ℹ️ Alternative Immobilier - ${horsMarcheIgnorees} annonces hors marché ignorées (sous offre/vendu).`);
  await deleteMissingAnnonces("Alternative Immobilier", [...new Set(liensActuels)]);
  console.log("✅ Alternative Immobilier - Scraping terminé !");
};
