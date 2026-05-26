import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = new Set();
  $(".js-the-list-of-properties-list-property a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").split("?")[0];
    if (href.includes("/trouver_logement")) {
      links.add(href.startsWith("http") ? href : `https://www.century21.fr${href}`);
    }
  });

  // Century21 ne pagine pas sur cette recherche — une seule page
  return { links: [...links], nextUrl: null };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const typeRaw = $("h1 > span:first-child").text().trim();
  const type = typeRaw.split(" ")[0] || "Non spécifié";

  const criteresText = $("h1 > span:nth-child(2)").text().trim();
  const pieces = parseInt(criteresText.match(/(\d+)\s*pièces?/i)?.[1] || "0") || 0;
  const surface = parseFloat((criteresText.match(/(\d+[\.,]?\d*)\s*m/i)?.[1] || "0").replace(",", ".")) || 0;

  const villeRaw = $("h1 > span:nth-child(3)").text().trim();
  const ville = villeRaw.split("-")[0].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  const prix = parseInt($(".c-the-property-abstract__price").first().text().replace(/[^0-9]/g, "")) || 0;

  const ref = $(".c-the-property-abstract").text().match(/Ref\s*:\s*(\S+)/i)?.[1] || "";

  // Chambres = nombre de li commençant par "Chambre"
  const chambres = $("li").filter((_, el) => /^Chambre/i.test($(el).text().trim())).length;

  const description = $(".c-the-property-detail-description .has-formated-text").first().text().trim();

  // Photos : src + data-src filtrés par ref et taille haute résolution (_8_)
  const photos = new Set();
  $("img[src*='imagesBien'], img[data-src*='imagesBien']").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || "";
    if (src.includes(`_${ref}_8_`)) {
      photos.add(src.startsWith("http") ? src : `https://www.century21.fr${src}`);
    }
  });

  return { type, pieces, surface, ville, prix, chambres, description, photos: [...photos] };
}

export const centuryScraper = async () => {
  const villeRows = await getVilleParams("century");
  if (!villeRows.length) {
    console.warn("⚠️ Century 21 - Aucune ville configurée en base");
    return;
  }
  // Century21 exige l'ordre : segments "v-*" avant "cpv-*"
  const sorted   = [...villeRows].sort((a, b) => a.params.segment.startsWith("v-") ? -1 : 1);
  const segments = sorted.map(r => r.params.segment).join("/");
  const cibleRow  = villeRows.find(r => r.params.cible) || villeRows[0];
  const LIST_URL  =
    `https://www.century21.fr/annonces/f/achat-maison-immeuble-ancien/${segments}/s-0-/st-0-/b-0-400000/?cible=${cibleRow.params.segment}`;

  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Century 21 - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Century 21 - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Century 21 - Page détail : ${url}`);
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
            agence: "Century 21",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Century 21 - Données incomplètes pour ${url}`);
          await insertErreur("Century 21", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Century 21 - Erreur sur ${url}:`, err.message);
        await insertErreur("Century 21", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("Century 21", Array.from(new Set(liensActuels)));
  console.log("✅ Century 21 - Scraping terminé !");
};
