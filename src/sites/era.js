import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

const BASE_URL = "https://www.eraimmobilier.com";
const LIST_URL =
  `${BASE_URL}/acheter/Chateaugiron-c15629,Vitre-c27606` +
  `?page=1&prix_to=400000&type_bien=maison,immeuble&display=list`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

function extractNgState(html) {
  const match = html.match(/<script id="ng-state" type="application\/json">([^<]+)<\/script>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = [...new Set(
    $("app-annonce-card a[href^='/annonces/']")
      .map((_, el) => BASE_URL + $(el).attr("href"))
      .get()
  )];

  const nextHref = $("a.nav").filter((_, el) => $(el).find(".icon-arrow-right").length > 0).attr("href");
  const nextUrl = nextHref ? BASE_URL + nextHref : null;

  return { links, nextUrl };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const state = extractNgState(html);

  if (state) {
    // Chercher la clé ng-state qui contient l'objet annonce (pas un tableau)
    for (const key of Object.keys(state)) {
      const val = state[key]?.b?.data;
      if (val && !Array.isArray(val) && val.surface_habitable !== undefined) {
        const photos = (val.images?.big || val.photo || []);
        return {
          type: val.type_bien || "Non spécifié",
          prix: val.prix || 0,
          ville: val.ville || "",
          surface: val.surface_habitable || 0,
          pieces: val.nb_pieces || 0,
          chambres: val.nb_chambres || 0,
          description: val.descriptif || "",
          photos: Array.isArray(photos) ? photos : [],
          dpe: val.bilan_dpe || "",
          ges: val.bilan_ges || "",
        };
      }
    }
  }

  // Fallback HTML si ng-state absent
  const $ = cheerio.load(html);
  const title = $("h1 .display-h1").first().text().trim();
  const prix = parseInt($(".title-price-number").first().text().replace(/\s+/g, "").replace("€*", "")) || 0;
  const ville = $(".city").first().text().trim();
  const description = $(".description p.whitespace-pre-wrap").first().text().trim();
  const photos = $(".block-image-item-img").map((_, el) => $(el).attr("src")).get().filter(Boolean);
  const dpe = $(".performance.dpe li.on").first().text().trim();
  const ges = $(".performance.ges li.on").first().text().trim();

  return { type: title.replace("Vente", "").trim(), prix, ville, surface: 0, pieces: 0, chambres: 0, description, photos, dpe, ges };
}

export const eraScraper = async () => {
  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 ERA - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 ERA - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 ERA - Page détail : ${url}`);
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
            agence: "ERA",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ ERA - Données incomplètes pour ${url}`);
          await insertErreur("ERA", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ ERA - Erreur sur ${url}:`, err.message);
        await insertErreur("ERA", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("ERA", Array.from(new Set(liensActuels)));
  console.log("✅ ERA - Scraping terminé !");
};
