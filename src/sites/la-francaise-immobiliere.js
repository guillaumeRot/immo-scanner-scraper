import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.la-francaise-immobiliere.fr";
const AJAX_URL = `${BASE_URL}/wp-admin/admin-ajax.php`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

function extractType(url) {
  if (/\/vente-maison-/.test(url)) return "Maison";
  if (/\/vente-(immeuble|ensemble)-/.test(url)) return "Immeuble";
  return null;
}

// Site WordPress + plugin de recherche "wia" (admin-ajax.php, action=load_search_results).
// Catégories internes : 23 = Maison, 30 = Ensemble Immobilier (l'équivalent le plus proche
// de notre "immeuble") — trouvées dans le <select name="categorie[]"> du formulaire.
async function scrapeListPage(zoneId) {
  const url =
    `${AJAX_URL}?action=load_search_results&post_types=achat` +
    `&categorie%5B%5D=23&categorie%5B%5D=30&zone%5B%5D=${zoneId}&prix_max=400000`;
  const data = await fetchJson(url);
  const $ = cheerio.load(data.html || "");

  const cards = [];
  $("article").each((_, el) => {
    const href = $(el).find("a[href*='/achat/vente-']").first().attr("href");
    if (!href) return;
    const type = extractType(href);
    if (!type) return; // ni maison ni immeuble (ex: appartement) : hors périmètre

    // Le site affiche encore certains biens déjà vendus, avec "VENDU" à la place du prix :
    // parseInt() renvoie 0 dans ce cas, ce qui les fait rejeter par le contrôle standard
    // "ville && prix" au moment de l'insertion, comme n'importe quelle annonce incomplète.
    const prix = parseInt(($(el).find(".prix").first().text() || "").replace(/[^\d]/g, "")) || 0;
    const surface = parseInt(($(el).find(".surface").first().text().match(/(\d+)/) || [])[1] || "0") || 0;
    const pieces = parseInt((href.match(/-t(\d+)-/) || [])[1] || "0") || 0;
    const chambres = parseInt($(el).find(".fa-bed").parent().text().trim()) || 0;

    cards.push({ lien: href, type, prix, surface, pieces, chambres });
  });
  return cards;
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const description = $('meta[itemprop="description"]').first().attr("content") || "";

  // Photos servies en plusieurs résolutions (ex: "...a.jpg" et "...a.jpg.red.jpg") : on ne
  // garde que la version de base pour éviter les doublons.
  const photos = [...new Set(
    $("img")
      .map((_, el) => $(el).attr("data-lazy") || $(el).attr("src"))
      .get()
      .filter((src) => src && src.includes("media.immo-facile.com") && !src.endsWith(".red.jpg"))
  )];

  return { description, photos };
}

export const laFrancaiseImmobiliereScraper = async () => {
  const villeRows = await getVilleParams("la-francaise-immobiliere");
  if (!villeRows.length) {
    console.warn("⚠️ La Française Immobilière - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];

  for (const row of villeRows) {
    console.log(`🔎 La Française Immobilière - Recherche : ${row.nom}`);
    let cards;
    try {
      cards = await scrapeListPage(row.params.zone_id);
    } catch (err) {
      console.error(`❌ La Française Immobilière - Erreur sur la page de liste (${row.nom}): ${err.message}`);
      await insertErreur("La Française Immobilière", row.nom, String(err));
      continue;
    }
    console.log(`📌 La Française Immobilière - ${row.nom} : ${cards.length} annonces trouvées.`);

    for (const card of cards) {
      try {
        if (!card.prix) {
          console.warn(`⚠️ La Française Immobilière - Données incomplètes pour ${card.lien}`);
          await insertErreur("La Française Immobilière", card.lien, "Données incomplètes (prix manquant, probablement vendu)");
          continue;
        }
        const { description, photos } = await scrapeDetailPage(card.lien);
        await insertAnnonce({
          type: card.type,
          prix: card.prix,
          ville: row.nom,
          pieces: card.pieces,
          chambres: card.chambres,
          surface: card.surface,
          description,
          photos,
          dpe: null,
          ges: null,
          agence: "La Française Immobilière",
          lien: card.lien,
        });
        liensActuels.push(card.lien);
      } catch (err) {
        console.error(`❌ La Française Immobilière - Erreur sur ${card.lien}: ${err.message}`);
        await insertErreur("La Française Immobilière", card.lien, String(err));
      }
    }
  }

  await deleteMissingAnnonces("La Française Immobilière", [...new Set(liensActuels)]);
  console.log("✅ La Française Immobilière - Scraping terminé !");
};
