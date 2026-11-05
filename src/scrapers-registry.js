// Registre centralisé des scrapers pilotables (tous fetch+cheerio, compatibles serverless
// ET GitHub Actions). Importé à la fois par src/app.js (routes HTTP, conservées comme filet
// de secours manuel) et scripts/scrape.js (exécution planifiée via GitHub Actions).
import { immonotScraper } from './sites/immonot.js';
import { kermarrecScraper, kermarrecLocationScraper } from './sites/kermarrec.js';
import { eraScraper, eraLocationScraper } from './sites/era.js';
import { blotScraper } from './sites/blot.js';
import { carnotScraper, carnotLocationScraper } from './sites/carnot.js';
import { diardScraper, diardLocationScraper } from './sites/diard.js';
import { pennScraper } from './sites/penn.js';
import { centuryScraper } from './sites/century.js';
import { bretilimmoScraper, bretilimmoLocationScraper } from './sites/bretilimmo.js';
import { boyerScraper, boyerLocationScraper } from './sites/boyer.js';
import { notairesBretonsScraper, notairesBretonsLocationScraper } from './sites/notaires-bretons.js';
import { immobilierNotairesScraper } from './sites/immobilier-notaires.js';
import { acheterLouerScraper, acheterLouerLocationScraper } from './sites/acheter-louer.js';
import { bienIciScraper, bienIciLocationScraper } from './sites/bien-ici.js';
import { fnaimScraper } from './sites/fnaim.js';
import { laforetScraper } from './sites/laforet.js';
import { squareHabitatScraper } from './sites/square-habitat.js';
import { laFrancaiseImmobiliereScraper } from './sites/la-francaise-immobiliere.js';
import { nestennScraper } from './sites/nestenn.js';
import { cornierImmobilierScraper } from './sites/cornier-immobilier.js';
import { ajpImmobilierScraper } from './sites/ajp-immobilier.js';
import { alternativeImmobilierScraper } from './sites/alternative-immobilier.js';
import { iadFranceScraper } from './sites/iad-france.js';
import { efficityScraper } from './sites/efficity.js';
import { alcImmobilierScraper } from './sites/alc-immobilier.js';
import { myHomeImmobilierScraper } from './sites/my-home-immobilier.js';

// Figaro Immobilier, Logic-immo et Ouest-France Immo sont désactivés : ils nécessitent
// Playwright (protections anti-bot Cloudflare/DataDome/challenge maison), incompatible
// avec un déploiement serverless Vercel ou un runner GitHub Actions standard. Leurs
// fichiers restent dans src/sites/ pour référence mais ne sont plus importés ici.

export const SCRAPERS = {
  "kermarrec": { fn: kermarrecScraper, displayName: "Kermarrec" },
  "era": { fn: eraScraper, displayName: "ERA" },
  "blot": { fn: blotScraper, displayName: "Blot" },
  "carnot": { fn: carnotScraper, displayName: "Carnot" },
  "penn": { fn: pennScraper, displayName: "Penn" },
  "diard": { fn: diardScraper, displayName: "Diard" },
  "century": { fn: centuryScraper, displayName: "Century 21" },
  "bretilimmo": { fn: bretilimmoScraper, displayName: "Bretil'Immo" },
  "boyer": { fn: boyerScraper, displayName: "Boyer Immobilier" },
  "notaires-bretons": { fn: notairesBretonsScraper, displayName: "Notaires et Bretons" },
  "immobilier-notaires": { fn: immobilierNotairesScraper, displayName: "Immobilier Notaires" },
  "acheter-louer": { fn: acheterLouerScraper, displayName: "Acheter-louer" },
  "bien-ici": { fn: bienIciScraper, displayName: "Bien-ici" },
  "immonot": { fn: immonotScraper, displayName: "Immonot" },
  "fnaim": { fn: fnaimScraper, displayName: "FNAIM" },
  "laforet": { fn: laforetScraper, displayName: "Laforêt" },
  "square-habitat": { fn: squareHabitatScraper, displayName: "Square Habitat" },
  "la-francaise-immobiliere": { fn: laFrancaiseImmobiliereScraper, displayName: "La Française Immobilière" },
  "nestenn": { fn: nestennScraper, displayName: "Nestenn" },
  "cornier-immobilier": { fn: cornierImmobilierScraper, displayName: "Cornier Immobilier" },
  "ajp-immobilier": { fn: ajpImmobilierScraper, displayName: "AJP Immobilier" },
  "alternative-immobilier": { fn: alternativeImmobilierScraper, displayName: "Alternative Immobilier" },
  "iad-france": { fn: iadFranceScraper, displayName: "iad France" },
  "efficity": { fn: efficityScraper, displayName: "Efficity" },
  "alc-immobilier": { fn: alcImmobilierScraper, displayName: "ALC Immobilier" },
  "my-home-immobilier": { fn: myHomeImmobilierScraper, displayName: "My Home Immobilier" },

  // Location (appartements et maisons) — mêmes agences, quand elles proposent de la location.
  // Century 21, Immobilier Notaires, Immonot, FNAIM et Penn n'ont pas de recherche
  // location exploitable trouvée (cf. DEPLOY.md) et n'ont donc pas d'équivalent ici.
  // Blot (location) existe dans src/sites/blot.js mais n'est pas branché ici : sans
  // filtre serveur fiable pour les biens déjà loués côté location (clean_vendus ne
  // fonctionne que pour la vente), la recherche remonte ~180 fiches "VENDU/LOUE" pour
  // 0 résultat utile en ~2min30 — cf. DEPLOY.md.
  "kermarrec-location": { fn: kermarrecLocationScraper, displayName: "Kermarrec (location)" },
  "era-location": { fn: eraLocationScraper, displayName: "ERA (location)" },
  "carnot-location": { fn: carnotLocationScraper, displayName: "Carnot (location)" },
  "diard-location": { fn: diardLocationScraper, displayName: "Diard (location)" },
  "bretilimmo-location": { fn: bretilimmoLocationScraper, displayName: "Bretil'Immo (location)" },
  "boyer-location": { fn: boyerLocationScraper, displayName: "Boyer Immobilier (location)" },
  "notaires-bretons-location": { fn: notairesBretonsLocationScraper, displayName: "Notaires et Bretons (location)" },
  "acheter-louer-location": { fn: acheterLouerLocationScraper, displayName: "Acheter-louer (location)" },
  "bien-ici-location": { fn: bienIciLocationScraper, displayName: "Bien-ici (location)" },
};

// Scrapers dont les données viennent directement de la liste (pas de fiche détail, donc pas
// de cache LienVu) : déjà à jour à chaque run, inutile de les rafraîchir à part.
export const SANS_RAFRAICHISSEMENT = new Set(["bien-ici", "bien-ici-location", "immobilier-notaires"]);
