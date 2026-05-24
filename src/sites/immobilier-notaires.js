import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

const BASE_API = "https://www.immobilier.notaires.fr/pub-services/inotr-www-annonces/v1/annonces";
// localites: 16149=Vitré 35500, 15867=Châteaugiron 35410
const LIST_URL =
  `${BASE_API}?parPage=100&prixMax=400000&localites=16149,15867` +
  `&typeTransaction=VENTE,VNI,VAE&typeBien=MAI,IMM`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://www.immobilier.notaires.fr/",
};

const TYPE_LABELS = { MAI: "Maison", IMM: "Immeuble", APP: "Appartement" };

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

async function fetchDetailData(annonceId) {
  const data = await fetchJson(`${BASE_API}/${annonceId}`);
  const bienData = data.bien?.immeuble || data.bien?.maison || data.bien?.appartement || {};
  const dpe = bienData.consommationClasse || null;
  const ges = bienData.emissionGesClasse || null;
  const photos = (data.vente?.multimedias || [])
    .map(m => m.urlHighestResolution)
    .filter(Boolean);
  return { dpe, ges, photos };
}

export const immobilierNotairesScraper = async () => {
  const liensActuels = [];

  console.log(`🔎 Immobilier Notaires - Récupération des annonces...`);
  let allAnnonces = [];
  let page = 1;

  while (true) {
    const data = await fetchJson(`${LIST_URL}&page=${page}`);
    const annonces = data.annonceResumeDto || [];
    allAnnonces = allAnnonces.concat(annonces);
    if (page >= data.nbPages) break;
    page++;
  }

  // Filter client-side: only MAI/IMM ventes (API filters are unreliable)
  const filtered = allAnnonces.filter(a =>
    ["VENTE", "VNI", "VAE"].includes(a.typeTransaction) && ["MAI", "IMM"].includes(a.typeBien)
  );
  console.log(`📌 Immobilier Notaires - ${filtered.length} annonces retenues (sur ${allAnnonces.length} totales).`);

  for (const a of filtered) {
    const url = a.urlDetailAnnonceFr;
    try {
      console.log(`📄 Immobilier Notaires - Détail : ${url}`);
      const { dpe, ges, photos } = await fetchDetailData(a.annonceId);

      const ville = a.communeNom || "";
      const prix = a.prixTotal || 0;

      if (ville && prix) {
        await insertAnnonce({
          type: TYPE_LABELS[a.typeBien] || a.typeBien,
          prix,
          ville,
          pieces: a.nbPieces || 0,
          chambres: a.nbChambres || 0,
          surface: a.surface || 0,
          description: (a.descriptionFr || "").replace(/<[^>]+>/g, "").trim(),
          photos,
          dpe,
          ges,
          agence: "Immobilier Notaires",
          lien: url,
        });
        liensActuels.push(url);
      } else {
        console.warn(`⚠️ Immobilier Notaires - Données incomplètes pour ${url}`);
        await insertErreur("Immobilier Notaires", url, "Données incomplètes (ville ou prix manquant)");
      }
    } catch (err) {
      console.error(`❌ Immobilier Notaires - Erreur sur ${url}:`, err.message);
      await insertErreur("Immobilier Notaires", url, String(err));
    }
  }

  await deleteMissingAnnonces("Immobilier Notaires", Array.from(new Set(liensActuels)));
  console.log("✅ Immobilier Notaires - Scraping terminé !");
};
