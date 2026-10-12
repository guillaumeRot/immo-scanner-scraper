import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.alcimmobilier.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// Les pages de recherche par ville renvoient aussi des liens de navigation génériques
// (catégories de la barre de recherche, ex. "/vente-maison-3-pieces.html") sans rapport
// avec la ville demandée — seules les vraies fiches ont un identifiant d'offre en fin
// d'URL (ex: "...-1-1045v721m.html").
const DETAIL_RE = /-\d+-\d+v\d+[a-z]\.html$/;

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const links = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && DETAIL_RE.test(href)) {
      links.add(href.startsWith("http") ? href : `${BASE_URL}${href}`);
    }
  });
  return [...links];
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);

  // Champ JS interne (pré-rempli pour le formulaire de contact) bien plus fiable que les
  // sélecteurs visuels de la page : donne type, pièces et surface en une seule chaîne
  // ("Vente maison - 72610 Arçonnay - 4 pièces - 91,45 m² -  296 000 €").
  const resumeMatch = html.match(
    /resumeannonce:\s*"(?:Vente|Professionnel)\s+(maison|immeuble)\s+-\s+\d{5}\s+.+?\s+-\s+(\d+)\s+pi[eè]ces?\s+-\s+([\d,]+)\s*m²/
  );
  const type = resumeMatch?.[1] === "immeuble" ? "Immeuble" : "Maison";
  const pieces = resumeMatch ? parseInt(resumeMatch[2]) : 0;
  const surface = resumeMatch ? parseFloat(resumeMatch[3].replace(",", ".")) : 0;

  // Le même champ existe ailleurs sur la page formaté pour l'affichage ("296 000 &euro;") :
  // on ne garde que l'occurrence purement numérique.
  const prix = parseInt(html.match(/\bprix:\s*"(\d+)"/)?.[1]) || 0;

  const $ = cheerio.load(html);
  const description = $(".detail-offre-descriptif").first().text().replace(/\s+/g, " ").trim();

  // Le DPE/GES n'est pas toujours renseigné (ex. biens professionnels) : l'image pointe
  // alors vers "dpe-ID.svg" (classe inconnue), qui ne matche pas [A-G] et reste null.
  const dpe = html.match(/dpeges\/fr\/dpe-([A-G])\.svg/)?.[1] || null;
  const ges = html.match(/dpeges\/fr\/ges-([A-G])\.svg/)?.[1] || null;

  const photos = [
    ...new Set(
      [...html.matchAll(/https:\/\/medias\.twimmopro\.com\/photooffre\/[^"'<>\s]+-photo-hd\.webp/g)].map((m) => m[0])
    ),
  ];

  return { type, prix, pieces, surface, description, photos, dpe, ges };
}

export const alcImmobilierScraper = async () => {
  const villeRows = await getVilleParams("alc-immobilier");
  if (!villeRows.length) {
    console.warn("⚠️ ALC Immobilier - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];

  for (const row of villeRows) {
    const villeEncoded = encodeURIComponent(row.nom);
    const listUrls = [
      `${BASE_URL}/immobilier/vente-type/maison-categorie/${villeEncoded}-ville/`,
      `${BASE_URL}/immobilier/professionnel-type/immeuble-categorie/${villeEncoded}-ville/`,
    ];

    for (const listUrl of listUrls) {
      console.log(`🔎 ALC Immobilier - Page de liste : ${listUrl}`);
      let links;
      try {
        links = await scrapeListPage(listUrl);
      } catch (err) {
        console.error(`❌ ALC Immobilier - Erreur sur la page de liste ${listUrl}:`, err.message);
        await insertErreur("ALC Immobilier", listUrl, String(err));
        continue;
      }
      console.log(`📌 ALC Immobilier - ${links.length} annonces trouvées pour ${row.nom}.`);

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
              agence: "ALC Immobilier",
              lien: url,
            });
            liensActuels.push(url);
          } else {
            console.warn(`⚠️ ALC Immobilier - Données incomplètes pour ${url}`);
            await insertErreur("ALC Immobilier", url, "Données incomplètes (prix manquant)");
          }
        } catch (err) {
          console.error(`❌ ALC Immobilier - Erreur sur ${url}:`, err.message);
          await insertErreur("ALC Immobilier", url, String(err));
        }
      }
    }
  }

  await deleteMissingAnnonces("ALC Immobilier", [...new Set(liensActuels)]);
  console.log("✅ ALC Immobilier - Scraping terminé !");
};
