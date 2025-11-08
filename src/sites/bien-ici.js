import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const bienIciScraper = async () => {
  const requestQueue = await RequestQueue.open(`bien-ici-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.bienici.com/recherche/achat/vitre-35500,chateaugiron-35410/maisonvilla,batiment?prix-max=400000",
    userData: { label: "LIST_PAGE" },
  });

  const liensActuels = [];

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1, // équilibre vitesse / RAM
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 30,
    maxRequestRetries: 1,
    launchContext: {
      launcher: chromium,
      launchOptions: {
        headless: false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
          "--no-zygote",
        ],
      },
    },
    async requestHandler({ page, request, log }) {
      const { label } = request.userData;

      // 🧭 Étape 1 — Pages de liste
      if (label === "LIST_PAGE") {
        log.info(` Bien-ici - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info(" Bien-ici - Page chargée.");

        // Gérer le popup de cookies s'il est présent
        try {
            await page.waitForSelector('#didomi-notice-agree-button', { timeout: 5000 });
            await page.click('#didomi-notice-agree-button');
            log.info("✅ Popup de cookies accepté");
        } catch (error) {
            log.info("ℹ️ Pas de popup de cookies détecté");
        }

        // Attendre que les annonces soient chargées
        await page.waitForSelector(".ads-search-results__search-results-container", { state: "attached", timeout: 20000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          "article.search-results-list__ad-overview a.detailedSheetLink[href]",
          (anchors) => anchors.map(a => {
            // Convertir les URLs relatives en absolues si nécessaire
            return a.href.startsWith('http') ? a.href : `https://www.bienici.com${a.href}`;
          })
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`📌 Bien-ici - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        // for (const url of uniqueLinks) {
        //   await requestQueue.addRequest({ 
        //     url, 
        //     userData: { label: "DETAIL_PAGE" } 
        //   });
        // }

        // Gestion de la pagination
        try {
          // Trouver le bouton de la page courante et récupérer le lien suivant
          const nextPageUrl = await page.evaluate(() => {
            const currentPageBtn = document.querySelector('.pagination__current-page');
            if (!currentPageBtn) return null;
            
            // Trouver le prochain élément frère qui est un lien
            let nextElement = currentPageBtn.nextElementSibling;
            while (nextElement) {
              if (nextElement.tagName === 'A' && nextElement.href) {
                return nextElement.href;
              }
              nextElement = nextElement.nextElementSibling;
            }
            return null;
          });

          if (nextPageUrl) {
            log.info(`➡️ Bien-ici - Page suivante détectée: ${nextPageUrl}`);
            
            // Ajouter la page suivante à la file d'attente
            await requestQueue.addRequest({ 
              url: nextPageUrl,
              userData: { label: "LIST_PAGE" },
            });
          } else {
            log.info("✅ Bien-ici - Dernière page de la pagination atteinte.");
          }
        } catch (error) {
          log.error(`❌ Bien-ici - Erreur lors de la gestion de la pagination: ${error.message}`);
        }
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Bien-ici - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Fonction pour nettoyer le texte
            const cleanText = (selector) => 
              document.querySelector(selector)?.textContent.trim() || '';
            
            // Titre et type de bien
            const titleElement = document.querySelector('.ad-overview-details__ad-title');
            const title = titleElement ? titleElement.textContent.trim() : 'Bien non spécifié';
            
            // Prix
            const priceText = cleanText('.ad-price__the-price');
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // Surface
            const surfaceMatch = title.match(/(\d+)\s*m²/);
            const surface = surfaceMatch ? parseInt(surfaceMatch[1]) : 0;
            
            // Pièces
            const piecesMatch = title.match(/(\d+)\s*pi[èe]ce/);
            const pieces = piecesMatch ? parseInt(piecesMatch[1]) : 0;
            
            // Chambres (on suppose qu'il y a au moins une chambre de moins que le nombre de pièces)
            const bedrooms = Math.max(1, pieces - 1);
            
            // Description
            const description = cleanText('.ad-overview-description');
            
            // Localisation
            const location = cleanText('.ad-overview-details__address-title') || '';
            
            // Référence (on utilise l'ID de l'annonce)
            const reference = window.location.href.split('/').pop() || '';
            
            // Photos
            const photos = Array.from(document.querySelectorAll('.ad-overview-photo__image img'))
              .map(img => img.src)
              .filter(src => src && src.includes('bienici.com'));

            // Extraction des détails supplémentaires
            const details = {};
            
            // On essaie d'extraire les chambres et salles de bain de la description
            const descriptionText = description.toLowerCase();
            const chambresMatch = descriptionText.match(/(\d+)\s*chambre/);
            const sdbMatch = descriptionText.match(/(\d+)\s*(salle (de bain|d'eau)|sdb)/);
            
            if (chambresMatch) details.chambres = parseInt(chambresMatch[1]);
            if (sdbMatch) details.sdb = parseInt(sdbMatch[1]);
            
            // Si on n'a pas trouvé de chambres, on utilise la logique précédente
            if (!details.chambres) details.chambres = bedrooms;
            
            // Si on n'a pas trouvé de salles de bain, on met 1 par défaut
            if (!details.sdb) details.sdb = 1;

            return {
              title,
              price,
              surface,
              landSurface: details.landSurface || null,
              bedrooms: details.chambres || 0,
              pieces: pieces || 0,
              sdb: details.sdb || 0,
              description,
              location,
              reference,
              photos,
              url: window.location.href,
              source: 'Bien-ici',
              timestamp: new Date().toISOString()
            };
          });
          
          // Vérifier les données et insérer dans la base de données
          if (property.title && property.price) {
            await insertAnnonce({
              type: property.title.split(' ')[0] || 'Non spécifié',
              prix: property.price,
              ville: property.location,
              pieces: property.pieces,
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Bien-ici",
              lien: request.url,
            });
          } else {
            log.warning(`⚠️ Diard - Données incomplètes pour ${request.url}`);
            await insertErreur("Diard", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`❌ Diard - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Diard", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Diard - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Diard", Array.from(new Set(liensActuels)));

  console.log("✅ Diard - Scraping Diard terminé !");
};
