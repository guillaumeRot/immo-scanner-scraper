import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, insertAnnonceLocation, deleteMissingAnnoncesLocation, getVilleParams } from "../db.js";

const BASE_URL = "https://www.boyer-immobilier.fr";
const BASE_LIST_URL =
  `${BASE_URL}/catalog/advanced_search_result.php?action=update_search` +
  `&C_28_search=EGAL&C_28_type=UNIQUE&C_28=Vente` +
  `&C_27_search=EGAL&C_27_type=TEXT&C_27=2%2C6` +
  `&C_30_search=COMPRIS&C_30_type=NUMBER&C_30_MAX=400000` +
  `&C_65_search=CONTIENT&C_65_type=TEXT&C_65=`;

const BASE_LIST_URL_LOCATION =
  `${BASE_URL}/catalog/advanced_search_result.php?action=update_search` +
  `&C_28_search=EGAL&C_28_type=UNIQUE&C_28=Location` +
  `&C_27_search=EGAL&C_27_type=TEXT&C_27=1` +
  `&C_65_search=CONTIENT&C_65_type=TEXT&C_65=`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder("iso-8859-1").decode(buf);
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = new Set();
  $("#listing_bien a[href*='fiches']").each((_, el) => {
    let href = ($(el).attr("href") || "").split("?")[0];
    href = href.replace(/^\.\.\//, `${BASE_URL}/`);
    if (href.startsWith("http")) links.add(href);
  });

  const nextHref = $("a:contains('Suivante')").attr("href") || null;
  const nextUrl = nextHref
    ? nextHref.startsWith("http") ? nextHref : `${BASE_URL}${nextHref}`
    : null;

  return { links: [...links], nextUrl };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  function getCritere(label) {
    let result = null;
    $(".product-criteres .list-group-item").each((_, el) => {
      const cols = $(el).find(".col-sm-6");
      if (cols.first().text().trim() === label) {
        result = cols.last().find("b").text().trim() || cols.last().text().trim();
        return false;
      }
    });
    return result;
  }

  const prix = parseInt(($(".hono_inclus_price").first().text() || "").replace(/[^0-9]/g, "")) || 0;
  const villeRaw = getCritere("Ville") || "";
  const ville = villeRaw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const type = getCritere("Type de bien") || "Non spécifié";
  const surface = parseInt((getCritere("Surface") || "").match(/\d+/)?.[0] || "0");
  const pieces = parseInt(getCritere("Nombre pièces") || "0") || 0;
  const chambres = parseInt(getCritere("Chambres") || "0") || 0;
  const dpe = getCritere("Consommation énergie primaire") || null;
  const ges = getCritere("Gaz Effet de Serre") || null;
  const description = $(".product-description").first().text().trim();

  const photos = [];
  $("#slider_product .item-slider a[href*='/images/pr_p/']").each((_, el) => {
    let href = ($(el).attr("href") || "").replace(/^\.\.\//, `${BASE_URL}/`);
    if (href.startsWith("http") && !photos.includes(href)) photos.push(href);
  });

  return { prix, ville, type, surface, pieces, chambres, dpe, ges, description, photos };
}

async function scrapeLocationDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  function getCritere(label) {
    let result = null;
    $(".product-criteres .list-group-item").each((_, el) => {
      const cols = $(el).find(".col-sm-6");
      if (cols.first().text().trim() === label) {
        result = cols.last().find("b").text().trim() || cols.last().text().trim();
        return false;
      }
    });
    return result;
  }

  // Widget de conformité loi ALUR (composant partagé par ce CMS, cf. Diard)
  const loyer = parseInt($(".alur_loyer_price").first().text().replace(/[^0-9]/g, "")) || 0;
  // Pas de champ "Ville" dans les critères des annonces de location (juste "Secteur",
  // un quartier) : la ville est en suffixe du h1/title, ex. "Appartement T3 - VITRE"
  const titleText = $("h1").first().text().trim();
  const villeRaw = titleText.split(" - ").pop() || "";
  const ville = villeRaw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const surface = parseInt((getCritere("Surface") || "").match(/\d+/)?.[0] || "0");
  const pieces = parseInt(getCritere("Nombre pièces") || "0") || 0;
  const dpe = getCritere("Consommation énergie primaire") || null;
  const ges = getCritere("Gaz Effet de Serre") || null;
  const description = $(".product-description").first().text().trim();

  const photos = [];
  $("#slider_product .item-slider a[href*='/images/pr_p/']").each((_, el) => {
    let href = ($(el).attr("href") || "").replace(/^\.\.\//, `${BASE_URL}/`);
    if (href.startsWith("http") && !photos.includes(href)) photos.push(href);
  });

  return { loyer, ville, type: "Appartement", surface, pieces, dpe, ges, description, photos };
}

export const boyerLocationScraper = async () => {
  const villeRows = await getVilleParams("boyer");
  if (!villeRows.length) {
    console.warn("⚠️ Boyer (location) - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];

  for (const row of villeRows) {
    let currentUrl = BASE_LIST_URL_LOCATION + row.params.C_65;

    while (currentUrl) {
      console.log(`🔎 Boyer (location) - Page de liste : ${currentUrl}`);
      const { links, nextUrl } = await scrapeListPage(currentUrl);
      console.log(`📌 Boyer (location) - ${links.length} annonces trouvées.`);

      for (const url of links) {
        try {
          console.log(`📄 Boyer (location) - Page détail : ${url}`);
          const data = await scrapeLocationDetailPage(url);

          if (data.ville && data.loyer) {
            await insertAnnonceLocation({
              type: data.type,
              loyer: data.loyer,
              ville: data.ville,
              pieces: data.pieces,
              surface: data.surface,
              description: data.description,
              photos: data.photos,
              dpe: data.dpe,
              ges: data.ges,
              agence: "Boyer Immobilier",
              lien: url,
            });
            liensActuels.push(url);
          } else {
            console.warn(`⚠️ Boyer (location) - Données incomplètes pour ${url}`);
            await insertErreur("Boyer Immobilier (location)", url, "Données incomplètes (ville ou loyer manquant)");
          }
        } catch (err) {
          console.error(`❌ Boyer (location) - Erreur sur ${url}:`, err.message);
          await insertErreur("Boyer Immobilier (location)", url, String(err));
        }
      }

      currentUrl = nextUrl;
    }
  }

  await deleteMissingAnnoncesLocation("Boyer Immobilier", Array.from(new Set(liensActuels)));
  console.log("✅ Boyer (location) - Scraping terminé !");
};

export const boyerScraper = async () => {
  const villeRows = await getVilleParams("boyer");
  if (!villeRows.length) {
    console.warn("⚠️ Boyer - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];

  for (const row of villeRows) {
  let currentUrl = BASE_LIST_URL + row.params.C_65;

  while (currentUrl) {
    console.log(`🔎 Boyer - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Boyer - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Boyer - Page détail : ${url}`);
        const data = await scrapeDetailPage(url);

        if (data.ville && data.prix) {
          await insertAnnonce({
            type: data.type,
            prix: data.prix,
            ville: data.ville,
            pieces: data.pieces,
            chambres: data.chambres,
            surface: data.surface,
            description: data.description,
            photos: data.photos,
            dpe: data.dpe,
            ges: data.ges,
            agence: "Boyer Immobilier",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Boyer - Données incomplètes pour ${url}`);
          await insertErreur("Boyer Immobilier", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Boyer - Erreur sur ${url}:`, err.message);
        await insertErreur("Boyer Immobilier", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }
  } // fin boucle villes

  await deleteMissingAnnonces("Boyer Immobilier", Array.from(new Set(liensActuels)));
  console.log("✅ Boyer - Scraping terminé !");
};
