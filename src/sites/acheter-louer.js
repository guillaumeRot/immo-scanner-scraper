import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.acheter-louer.fr";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": BASE_URL,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

const API_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Origin": BASE_URL,
  "Referer": `${BASE_URL}/`,
};

async function fetchHtml(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 2000 * i));
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) {
      const text = await res.text();
      if (text.length > 5000) return text;
    }
  }
  throw new Error(`HTTP fetch failed for ${url}`);
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const links = new Set();
  $(".CardSearchResult a[href*='/annonces-immobilier/achat/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href && !href.includes("?q=")) {
      links.add(href.startsWith("http") ? href : `${BASE_URL}${href}`);
    }
  });
  return [...links];
}

async function fetchApi(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 2000 * i));
    const res = await fetch(url, { headers: API_HEADERS });
    if (res.ok) return res.json();
  }
  throw new Error(`API fetch failed for ${url}`);
}

function decodeBuffer(v) {
  if (typeof v === "string") return v;
  if (v?.type === "Buffer") return Buffer.from(v.data).toString("latin1");
  return "";
}

async function scrapeDetailPage(url) {
  const annonceId = url.match(/-(\d+)$/)?.[1];
  if (!annonceId) throw new Error(`No annonce ID in URL: ${url}`);

  const type = url.match(/\/achat\/\d+-[^/]+\/([^/]+)\//)?.[1] || "maison";

  const json = await fetchApi(`https://api-v5.acheter-louer.fr/pa?Num=${annonceId}`);
  const obj = json.data?.[0];
  if (!obj) throw new Error(`No API data for annonce ${annonceId}`);

  const prix = obj.Prix || 0;
  const surface = parseFloat(obj.SurfaceH) || 0;
  const chambres = obj.Nb_chambres || 0;
  const ville = obj.Ville ? obj.Ville.charAt(0) + obj.Ville.slice(1).toLowerCase() : "";
  const photoCount = (obj.Photos || obj.photos || 0);
  const description = decodeBuffer(obj.Descriptif).replace(/<BR>/gi, "\n").replace(/<[^>]+>/g, "").trim();

  let photos = [];
  if (photoCount > 0) {
    const photosJson = await fetchApi(
      `https://api-v5.acheter-louer.fr/photos?IdAnnonce=${annonceId}&$limit=50&$sort[Priority]=1`
    );
    photos = (photosJson.data || [])
      .filter(p => p.original_url)
      .map(p => decodeBuffer(p.original_url));
  }

  return { type, prix, ville, surface, pieces: 0, chambres, description, photos, dpe: null, ges: null };
}

export const acheterLouerScraper = async () => {
  const villeRows = await getVilleParams("acheter-louer");
  if (!villeRows.length) {
    console.warn("⚠️ Acheter-louer - Aucune ville configurée en base");
    return;
  }
  const locs     = villeRows.map(r => r.params.loc).join(",");
  const cityZips = villeRows.map(r => r.params.cityZip).join(",");
  const LIST_URL =
    `${BASE_URL}/recherche?categorie=achat&loc=${locs}` +
    `&prix-min=0&prix-max=400000&type=maison,immeuble` +
    `&surface-global-min=0&surface-globale-max=100000&cityZip=${cityZips}&sort=Date`;

  const liensActuels = [];

  const links = await scrapeListPage(LIST_URL);
  console.log(`📌 Acheter-louer - ${links.length} annonces trouvées.`);

  for (const url of links) {
    try {
      console.log(`📄 Acheter-louer - Page détail : ${url}`);
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
          agence: "Acheter-louer",
          lien: url,
        });
        liensActuels.push(url);
      } else {
        console.warn(`⚠️ Acheter-louer - Données incomplètes pour ${url}`);
        await insertErreur("Acheter-louer", url, "Données incomplètes (ville ou prix manquant)");
      }
    } catch (err) {
      console.error(`❌ Acheter-louer - Erreur sur ${url}: ${err.message}`);
      await insertErreur("Acheter-louer", url, String(err));
    }
    await new Promise(r => setTimeout(r, 500));
  }

  await deleteMissingAnnonces("Acheter-louer", [...new Set(liensActuels)]);
  console.log("✅ Acheter-louer - Scraping terminé !");
};
