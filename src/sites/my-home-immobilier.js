import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://myhomeimmobilier.fr";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// search_status=10 : "A vendre" (9 = à louer, 81 = location saisonnière).
// search_type : 11 = Maison, 53 = Immeuble (valeurs internes au site, vues dans le <select> du formulaire).
const TYPES = [
  { search_type: 11, label: "Maison" },
  { search_type: 53, label: "Immeuble" },
];

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const links = new Set();
  // Un lien "/biens/" sans slug après (la page d'accueil des biens elle-même) ne doit pas
  // être pris pour une fiche détail.
  $("a[href^='https://myhomeimmobilier.fr/biens/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href && /\/biens\/[^/]+\/?$/.test(href)) links.add(href);
  });
  return [...links];
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const kd = {};
  $(".pxp-sp-key-details-item").each((_, el) => {
    const label = $(el).find(".pxp-sp-kd-item-label").text().trim();
    const value = $(el).find(".pxp-sp-kd-item-value").text().trim();
    if (label) kd[label] = value;
  });

  const type = /immeuble/i.test(kd["Type"] || "") ? "Immeuble" : "Maison";
  const pieces = parseInt(kd["Nbr de pièces"]) || 0;

  const prix = parseInt($(".pxp-sp-top-price").first().text().replace(/[^\d]/g, "")) || 0;

  // ".pxp-sp-top-feat" concatène chambres et surface dans un seul texte (ex: "3 CH73.86 M²") :
  // on isole la partie surface par regex plutôt que par un simple parseFloat.
  const surfaceMatch = $(".pxp-sp-top-feat").first().text().match(/([\d.,]+)\s*M²/i);
  const surface = surfaceMatch ? parseFloat(surfaceMatch[1].replace(",", ".")) : 0;

  const description = $(".pxp-single-property-section")
    .filter((_, el) => /Vue d.ensemble/i.test($(el).find("h3").text()))
    .find(".mt-3.mt-md-4")
    .first()
    .text()
    .replace(/\s+/g, " ")
    .trim();

  // DPE/GES apparaissent en texte libre dans le bloc légal ("Classe énergie E, Classe climat E"),
  // pas dans un élément dédié.
  const dpe = html.match(/Classe\s+[ée]nergie\s+([A-G])\b/)?.[1] || null;
  const ges = html.match(/Classe\s+climat\s+([A-G])\b/)?.[1] || null;

  // Les photos existent en plusieurs tailles ("...-1920x1280.jpg", "...-800x600.jpg") en plus
  // de l'originale ("..._original.jpg") : ne garder que cette dernière.
  const photos = [
    ...new Set(
      [...html.matchAll(/https:\/\/myhomeimmobilier\.fr\/wp-content\/uploads\/\d{4}\/\d{2}\/[^"'<>\s]+_original\.(?:jpg|jpeg|webp|png)/g)].map(
        (m) => m[0]
      )
    ),
  ];

  return { type, prix, pieces, surface, description, photos, dpe, ges };
}

export const myHomeImmobilierScraper = async () => {
  const villeRows = await getVilleParams("my-home-immobilier");
  if (!villeRows.length) {
    console.warn("⚠️ My Home Immobilier - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];

  for (const row of villeRows) {
    for (const { search_type, label } of TYPES) {
      const listUrl = `${BASE_URL}/rechercher-bien/?search_status=10&search_type=${search_type}&search_city=${row.params.slug}`;
      console.log(`🔎 My Home Immobilier - Page de liste (${label}) : ${listUrl}`);

      let links;
      try {
        links = await scrapeListPage(listUrl);
      } catch (err) {
        console.error(`❌ My Home Immobilier - Erreur sur la page de liste ${listUrl}:`, err.message);
        await insertErreur("My Home Immobilier", listUrl, String(err));
        continue;
      }
      console.log(`📌 My Home Immobilier - ${links.length} annonces trouvées pour ${row.nom} (${label}).`);

      for (const url of links) {
        try {
          const data = await scrapeDetailPage(url);
          if (data.prix) {
            await insertAnnonce({
              type: data.type,
              prix: data.prix,
              ville: row.nom,
              pieces: data.pieces,
              surface: data.surface,
              description: data.description,
              photos: data.photos,
              dpe: data.dpe,
              ges: data.ges,
              agence: "My Home Immobilier",
              lien: url,
            });
            liensActuels.push(url);
          } else {
            console.warn(`⚠️ My Home Immobilier - Données incomplètes pour ${url}`);
            await insertErreur("My Home Immobilier", url, "Données incomplètes (prix manquant)");
          }
        } catch (err) {
          console.error(`❌ My Home Immobilier - Erreur sur ${url}:`, err.message);
          await insertErreur("My Home Immobilier", url, String(err));
        }
      }
    }
  }

  await deleteMissingAnnonces("My Home Immobilier", [...new Set(liensActuels)]);
  console.log("✅ My Home Immobilier - Scraping terminé !");
};
