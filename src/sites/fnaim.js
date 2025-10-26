import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const fnaimScraper = async () => {
  const requestQueue = await RequestQueue.open(`fnaim-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.fnaim.fr/17-acheter.htm?localites=%5B%7B%22id%22%3A%2220583%22%2C%22label%22%3A%22VITRE+%2835500%29%22%2C%22type%22%3A%223%22%2C%22code%22%3A%2235500%22%2C%22insee%22%3A%2235360%22%2C%22value%22%3A%22VITRE+%2835500%29%22%7D%2C%7B%22id%22%3A%2231189%22%2C%22label%22%3A%22CHATEAUGIRON+%2835410%29%22%2C%22type%22%3A%223%22%2C%22code%22%3A%2235410%22%2C%22insee%22%3A%2235069%22%2C%22value%22%3A%22CHATEAUGIRON+%2835410%29%22%7D%5D&PRIX_MAX=400000&TYPE%5B%5D=2&TYPE%5B%5D=9&idtf=17&TRANSACTION=1&submit=Rechercher",
    userData: { label: "LIST_PAGE" },
  });

  const liensActuels = [];

  // Configuration du crawler avec plus de tolérance
  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1, // Limiter à 1 requête à la fois
    requestHandlerTimeoutSecs: 300, // 5 minutes de timeout
    navigationTimeoutSecs: 60000, // 60 secondes pour la navigation
    maxRequestRetries: 3,
    launchContext: {
      launcher: chromium,
      launchOptions: {
        headless: true,
        slowMo: 100,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
          "--no-zygote",
          "--disable-blink-features=AutomationControlled",
        ],
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
      },
    },
    async requestHandler({ page, request, log }) {
      // Ajout d'un délai aléatoire entre les requêtes (entre 1 et 3 secondes)
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));

      const { label } = request.userData;

      // 🧭 Étape 1 — Pages de liste
      if (label === "LIST_PAGE") {
        log.info(`FNAIM - Page de liste : ${request.url}`);

        try {
          await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));

          await page.setExtraHTTPHeaders({
            'Accept-Language': 'fr-FR,fr;q=0.9',
            'Referer': 'https://www.google.com/',
            'Connection': 'keep-alive'
          });
          await page.goto(request.url, { 
            waitUntil: 'load',
            timeout: 60000 // 60 secondes de timeout
          });
          log.info("FNAIM - Page chargée.");
        } catch (error) {
          log.error(`Erreur lors du chargement de la page 1 : ${error.message}`);
          throw error; // Relancer l'erreur pour la gestion des réessais
        }

        // Attendre que les annonces soient chargées
        await page.waitForSelector('.liste .item', { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          '.liste .item a.linkAnnonce[href^="/annonce-immobiliere/"]',
          (anchors) => {
            // Créer un Set pour éliminer les doublons basés sur l'URL
            const uniqueUrls = new Set();
            anchors.forEach(a => {
              // Construire l'URL complète
              const baseUrl = window.location.origin;
              const path = a.getAttribute('href');
              uniqueUrls.add(new URL(path, baseUrl).href);
            });
            return Array.from(uniqueUrls);
          }
        );

        log.info(`FNAIM - ${links.length} annonces uniques trouvées.`);
        
        // Ajouter chaque annonce dans la file pour traitement détaillé
        for (const annonceUrl of links) {
          // await requestQueue.addRequest({ 
          //   url: annonceUrl, 
          //   userData: { label: "DETAIL_PAGE" },
          // });
          liensActuels.push(annonceUrl);
        }

        // Vérifier s'il y a une page suivante
        const hasNextPage = await page.evaluate(() => {
          const nextButton = document.querySelector('.regletteNavigation .next a');
          return nextButton !== null;
        });

        if (hasNextPage) {
          // Récupérer l'URL de la page suivante
          const nextPageUrl = await page.evaluate(() => {
            const nextButton = document.querySelector('.regletteNavigation .next a');
            return nextButton ? nextButton.href : null;
          });
          
          if (nextPageUrl) {
            log.info(`FNAIM - Passage à la page ${nextPageUrl}`);
            await requestQueue.addRequest({
              url: nextPageUrl,
              userData: { label: 'LIST_PAGE' }
            });
          }
        }
      }

      // Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`FNAIM - Page détail : ${request.url}`);
          
          // Ajout d'un délai aléatoire entre 2 et 5 secondes
          await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));

          try {
            await page.goto(request.url, { 
              waitUntil: 'domcontentloaded', // Chargement plus rapide que 'networkidle'
              timeout: 120000, // 120 secondes de timeout
              // Désactiver le cache pour éviter les problèmes
              headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
              }
            });
            
            // Attendre que la page soit complètement chargée
            await page.waitForLoadState('networkidle', { timeout: 30000 });
            
          } catch (error) {
            log.error(`Erreur lors du chargement de la page 2 : ${error.message}`);
            // Ajouter un délai plus long en cas d'échec
            await new Promise(resolve => setTimeout(resolve, 10000));
            throw error; // Relancer l'erreur pour la gestion des réessais
          }

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Ville (depuis l'adresse)
            const cityElement = document.querySelector('div[itemprop="address"] span:first-child');
            let city = cityElement ? cityElement.textContent.trim() : '';
            // Nettoyer le code postal entre parenthèses (ex: "VITRE (35500)" -> "VITRE")
            city = city.replace(/\s*\([^)]*\)/g, '').trim();
            
            // Type de bien (depuis le 2ème élément du fil d'Ariane)
            const typeElement = document.querySelector('.ariane span:nth-child(2) span[itemprop="title"]');
            let type = 'Autre';
            if (typeElement) {
              // Enlever 'ACHAT ' du début du texte si présent
              type = typeElement.textContent.trim().replace(/^ACHAT\s+/i, '');
              // Mettre en majuscule la première lettre
              type = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
            }
            
            // Prix
            const priceElement = document.querySelector('.annonce_price span[itemprop="price"]');
            const priceText = priceElement ? priceElement.textContent.trim() : '';
            // Supprimer les espaces dans le nombre (ex: "215 250" -> "215250") avant conversion
            const price = parseInt(priceText.replace(/\s+/g, '')) || 0;
            
            // Surface habitable
            let surface = 0;
            const surfaceElement = Array.from(document.querySelectorAll('.caracteristique li'))
              .find(li => li.textContent.includes('Surface totale'));
            if (surfaceElement) {
              const surfaceText = surfaceElement.textContent.replace(/[^0-9]/g, '');
              surface = parseInt(surfaceText) || 0;
            }

            // Photos - Récupération depuis les liens imageAnnonce
            const photos = Array.from(document.querySelectorAll('a.imageAnnonce[href*="imagesv2.fnaim.fr"]'))
              .map(link => {
                // Récupérer l'URL de l'image depuis l'attribut href
                const imgUrl = link.getAttribute('href');
                // Nettoyer l'URL si nécessaire
                return imgUrl ? imgUrl.split('?')[0] : null;
              })
              .filter((url, index, self) => url && self.indexOf(url) === index); // Éliminer les doublons
                        
            // Description
            const descriptionElement = document.querySelector('#description p[itemprop="description"]');
            let description = '';
            if (descriptionElement) {
              // Cloner l'élément pour éviter de modifier le DOM
              const clone = descriptionElement.cloneNode(true);
              // Supprimer les iframes et autres éléments indésirables
              const elementsToRemove = clone.querySelectorAll('iframe, script, style, noscript');
              elementsToRemove.forEach(el => el.remove());
              // Récupérer le texte nettoyé
              description = clone.textContent
                .replace(/\s+/g, ' ') // Remplacer les espaces multiples par un seul espace
                .trim();
            }
            

            return {
              type,
              price,
              surface,
              description,
              city,
              photos,
              url: window.location.href,
              source: 'FNAIM',
              timestamp: new Date().toISOString()
            };
          });
          
          // Vérifier les données et insérer dans la base de données
          if (property.type && property.price) {
            await insertAnnonce({
              type: property.type,
              prix: property.price,
              ville: property.city,
              pieces: 1,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "FNAIM",
              lien: request.url,
            });
          } else {
            log.warning(`⚠️ FNAIM - Données incomplètes pour ${request.url}`);
            await insertErreur("FNAIM", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`🚨 FNAIM - Erreur pour ${request.url}: ${err.message}`);
          await insertErreur("FNAIM", request.url, err.message);
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 FNAIM - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("FNAIM", Array.from(new Set(liensActuels)));

  console.log("✅ FNAIM - Scraping terminé !");
};
