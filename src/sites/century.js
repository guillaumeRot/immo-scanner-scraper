import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const centuryScraper = async () => {
  const requestQueue = await RequestQueue.open(`century-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.century21.fr/annonces/f/achat-maison-immeuble-ancien/v-chateaugiron/cpv-35500_vitre/s-0-/st-0-/b-0-400000/?cible=cpv-35500_vitre",
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
        headless: true,
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
        log.info(` Century 21 - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info(" Century 21 - Page chargée.");

        // Attendre que les annonces soient chargées
        await page.waitForSelector(".js-the-list-of-properties-list-property", { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          ".js-the-list-of-properties-list-property a",
          (anchors) => {
            return anchors
              .map(a => {
                let url = a.href.split('?')[0]; // Enlever les paramètres d'URL
                if (!url.startsWith('http')) {
                  url = `https://www.century21.fr${url.startsWith('/') ? '' : '/'}${url}`;
                }
                return url;
              });
          }
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`📌 Century 21 - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of uniqueLinks) {
          liensActuels.push(url);
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Pas de pagination nécessaire - une seule page à traiter
        log.info("ℹ️ Century 21 - Traitement de la page unique terminé.");
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Century 21 - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Fonction pour nettoyer le texte
            const cleanText = (selector) => 
              document.querySelector(selector)?.textContent.trim() || '';
            
            // Titre et type de bien
            const title = document.querySelector('h1 > span:first-child')?.textContent.trim() || 'Bien non spécifié';
            
            // Ville
            const locationSpan = document.querySelector('h1 > span:nth-child(3)');
            const locationText = locationSpan?.textContent.trim() || '';
            const city = locationText ? locationText.substring(0, locationText.length - 5).trim() : '';
            
            // Prix
            const priceText = cleanText('.c-the-property-abstract__price');
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // Surface habitable
            const surfaceText = Array.from(document.querySelectorAll('.list-container .item .name'))
              .find(el => el.textContent.trim() === 'Surface')
              ?.closest('.item')
              ?.querySelector('.value')
              ?.textContent
              .replace(/[^0-9]/g, '') || '0';
            const surface = parseInt(surfaceText) || 0;

            // Photos
            const photos = Array.from(document.querySelectorAll('.c-the-detail-images__items-container img')).map(img => 
              "https://www.century21.fr/" + img.getAttribute('src')
            );
            
            // Pièces et chambres
            const roomsText = cleanText('.field--name-field-realty-rooms .field__item');
            const bedrooms = parseInt(roomsText) || 0;
            
            // Description
            const descriptionElement = document.querySelector('.c-the-property-detail-description .has-formated-text');
            const description = descriptionElement ? descriptionElement.textContent.trim() : '';
            
            // Localisation (on prend le texte du premier strong et on enlève les 6 premiers caractères)
            const location = cleanText('.content-container p strong')?.substring(6) || '';
            
            // Référence
            const reference = cleanText('.field--name-field-realty-reference .field__item');

            // Extraction des détails supplémentaires
            const details = {};
            document.querySelectorAll('.field--name-field-realty-features .field__item').forEach(item => {
              const text = item.textContent.trim();
              if (text.includes('Pièce(s)')) details.pieces = parseInt(text) || 0;
              if (text.includes('Chambre(s)')) details.chambres = parseInt(text) || 0;
              if (text.includes('Salle(s) de bain')) details.sdb = parseInt(text) || 0;
              if (text.includes('Surface terrain')) {
                const landSurface = parseInt(text.replace(/[^0-9]/g, ''));
                if (!isNaN(landSurface)) details.landSurface = landSurface;
              }
            });

            return {
              title,
              price,
              surface,
              landSurface: details.landSurface || null,
              bedrooms: details.chambres || bedrooms,
              pieces: details.pieces || bedrooms + 1, // On suppose que le nombre de pièces = chambres + séjour
              sdb: details.sdb || 0,
              description,
              location,
              reference,
              photos,
              url: window.location.href,
              source: 'Century 21',
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
              agence: "Century 21",
              lien: request.url,
            });
          } else {
            log.warning(`⚠️ Century 21 - Données incomplètes pour ${request.url}`);
            await insertErreur("Century 21", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`🚨 Century 21 - Erreur pour ${request.url}: ${err.message}`);
          await insertErreur("Century 21", request.url, err.message);
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Century 21 - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Century 21", Array.from(new Set(liensActuels)));

  console.log("✅ Century 21 - Scraping Century 21 terminé !");
};
