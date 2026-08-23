import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

// Efficity : réseau de mandataires indépendants (catalogue national unique, pas un site
// par consultant).
const BASE_URL = "https://www.efficity.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// Les fiches individuelles ont un identifiant à 6 chiffres ou plus en suffixe d'URL — les
// liens vers des communes suggérées par la recherche à rayon large se terminent eux par
// le seul code postal (5 chiffres), d'où cette distinction (sinon on récupère des liens
// de catégorie au lieu de vraies annonces).
async function scrapeListPage(slug) {
  const html = await fetchHtml(`${BASE_URL}/achat-immobilier/maison_${slug}/`);
  const $ = cheerio.load(html);
  const links = new Set();
  $("a[href*='/achat-immobilier/maison_']").each((_, el) => {
    const href = $(el).attr("href");
    if (href && /_\d{6,}\/?$/.test(href)) {
      links.add(href.startsWith("http") ? href : `${BASE_URL}${href}`);
    }
  });
  return [...links];
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Le <title> condense tout : "Achat maison 130 m2 Vitré (35500), 1 pièce - 199 000 €"
  const title = $("title").first().text();
  const m = title.match(
    /Achat\s+(maison|immeuble|appartement)\s+(\d+)\s*m2\s+(.+?)\s*\((\d{5})\),\s*(\d+)\s*pi[eè]ces?\s*-\s*([\d\s ]+?)\s*€/i
  );
  const typeRaw = m?.[1]?.toLowerCase() || "";
  const type = typeRaw === "maison" ? "Maison" : typeRaw === "immeuble" ? "Immeuble" : null;
  const surface = parseInt(m?.[2]) || 0;
  const ville = m?.[3]?.trim() || "";
  const pieces = parseInt(m?.[5]) || 0;
  const prix = parseInt((m?.[6] || "").replace(/[\s ]/g, "")) || 0;

  // Description tronquée par défaut ("...") : la version complète est dans .moar-content.
  const description =
    $(".moar-content p").first().text().trim() ||
    $("p:contains('Description du bien')").first().text().trim();

  const dpe = $(".energy-class-item-container.active .dpe-item").first().text().trim() || null;
  const ges = $(".climate-class-item-container.active .dpe-item").first().text().trim() || null;

  const propId = url.match(/_(\d+)\/?$/)?.[1];
  const photos = propId
    ? [...new Set($(`img[src*="/house/${propId}/"]`).map((_, el) => $(el).attr("src")).get())]
    : [];

  return { type, ville, prix, pieces, surface, dpe, ges, description, photos };
}

export const efficityScraper = async () => {
  const villeRows = await getVilleParams("efficity");
  if (!villeRows.length) {
    console.warn("⚠️ Efficity - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];
  const liensVus = new Set();

  for (const row of villeRows) {
    let links;
    try {
      links = await scrapeListPage(row.params.slug);
    } catch (err) {
      console.error(`❌ Efficity - Erreur sur la page de liste (${row.nom}): ${err.message}`);
      await insertErreur("Efficity", row.nom, String(err));
      continue;
    }
    console.log(`📌 Efficity - ${row.nom} : ${links.length} annonces trouvées.`);

    for (const url of links) {
      if (liensVus.has(url)) continue; // recherche par rayon : chevauchement entre villes voisines
      liensVus.add(url);
      try {
        const data = await scrapeDetailPage(url);
        if (data.ville && data.prix && data.type) {
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
            agence: "Efficity",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Efficity - Données incomplètes pour ${url}`);
          await insertErreur("Efficity", url, "Données incomplètes (ville, type ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Efficity - Erreur sur ${url}: ${err.message}`);
        await insertErreur("Efficity", url, String(err));
      }
    }
  }

  await deleteMissingAnnonces("Efficity", [...new Set(liensActuels)]);
  console.log("✅ Efficity - Scraping terminé !");
};
