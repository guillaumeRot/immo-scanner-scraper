import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const acheterLouerScraper = async () => {
  const requestQueue = await RequestQueue.open(`acheter-louer-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://acheter-louer.fr/recherche?categorie=achat&loc=vitre,chateaugiron&prix-min=0&prix-max=400000&type=maison,immeuble&surface-global-min=0&surface-globale-max=100000&cityZip=35500,35410&sort=Date",
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
        log.info(` Acheter-louer - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info(" Acheter-louer - Page chargée.");

        // Attendre que les annonces soient chargées
        await page.waitForSelector(".CardSearchResult", { timeout: 10000 });

        // Faire défiler pour charger toutes les annonces (scroll infini)
        log.info(" Acheter-louer - Chargement des annonces supplémentaires...");
        let previousHeight = 0;
        let currentHeight = await page.evaluate('document.body.scrollHeight');
        const maxScrolls = 10; // Nombre maximum de défilements pour éviter les boucles infinies
        let scrollCount = 0;

        while (previousHeight !== currentHeight && scrollCount < maxScrolls) {
          previousHeight = currentHeight;
          await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
          await page.waitForTimeout(1000); // Attendre le chargement
          currentHeight = await page.evaluate('document.body.scrollHeight');
          scrollCount++;
          log.info(` Acheter-louer - Défilement ${scrollCount}/${maxScrolls} - Hauteur: ${currentHeight}px`);
        }

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          ".CardSearchResult .h3-like[href]",
          (anchors) => anchors.map(a => {
            // Convertir les URLs relatives en absolues si nécessaire
            return a.href.startsWith('http') ? a.href : `https://www.acheter-louer.fr${a.href}`;
          })
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`📌 Acheter-louer - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of uniqueLinks) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Pas de pagination sur ce site
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Acheter-louer - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "networkidle" });
          await page.waitForSelector(".ad-price", { timeout: 10000 });

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Fonction pour nettoyer le texte
            const cleanText = (selector) => 
              document.querySelector(selector)?.textContent.trim() || '';
            
            // Extraction des informations d'adresse et de type de bien
            const addressElement = document.querySelector('.ad-address .fl');
            let ville = '';
            let typeBien = '';
            
            if (addressElement && addressElement.textContent) {
              const addressText = addressElement.textContent.trim();
              // Nettoyage des espaces multiples et sauts de ligne
              const cleanText = addressText.replace(/\s+/g, ' ').replace(/\n/g, ' ').trim();
              const parts = cleanText.split(' ');
              
              // La ville est le 2e élément (index 1) après le code postal
              if (parts.length > 1) {
                ville = parts[1];
                // Si la ville contient des chiffres (ex: code postal), on prend le mot suivant
                if (/\d/.test(ville) && parts.length > 2) {
                  ville = parts[2];
                }
              }
              
              // Le type de bien est généralement le mot après la ville
              // On cherche 'maison' ou 'immeuble' dans le texte
              const lowerText = cleanText.toLowerCase();
              if (lowerText.includes('maison')) {
                typeBien = 'maison';
              } else if (lowerText.includes('appartement') || lowerText.includes('appart')) {
                typeBien = 'appartement';
              } else if (lowerText.includes('immeuble')) {
                typeBien = 'immeuble';
              } else if (parts.length > 2) {
                // Si on n'a pas trouvé de type, on prend le 3e mot
                typeBien = parts[2].toLowerCase();
              }
            }
            
            // Prix
            const priceElement = document.querySelector(".ad-price");
            const priceText = priceElement ? priceElement.textContent.trim() : '';
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // Extraction des informations principales depuis la barre du haut
            const infoItems = document.querySelectorAll('.ad-bar-cont-top .unstyled li');
            
            // Initialisation des variables
            let surface = 0;
            let pieces = 0;
            let chambres = 0;
            
            // Parcours des éléments d'information
            infoItems.forEach((item, index) => {
              const span = item.querySelector('span');
              if (!span) return;
              
              const value = parseInt(span.textContent.trim()) || 0;
              const text = item.textContent.trim().toLowerCase();
              
              // Selon la position et le contenu, on détermine le type d'information
              if (index === 0 || text.includes('pces')) {
                pieces = value;
              } else if (index === 1 || text.includes('chb')) {
                chambres = value;
              } else if (index === 2 || text.includes('m²') || text.includes('m2')) {
                surface = value;
              }
            });
            
            const bedrooms = chambres;
            
            // Extraction de la description complète
            let description = '';
            const descriptionContainer = document.querySelector('.cont-aside .content .ad-bar-cont-top');
            if (descriptionContainer) {
              let currentNode = descriptionContainer.nextElementSibling;
              while (currentNode && !currentNode.classList?.contains('descriptions-legales')) {
                if (currentNode.textContent && currentNode.textContent.trim() !== '') {
                  description += (description ? '\n\n' : '') + currentNode.textContent.trim();
                }
                currentNode = currentNode.nextElementSibling;
              }
            }
            
            // Photos
            const photos = Array.from(document.querySelectorAll('.gallery-top .swiper-slide img[src*="acheter-louer.fr"]'))
              .map(img => img.src)
              .filter((src, index, self) => self.indexOf(src) === index); // Éliminer les doublons
            
            // Construction de l'objet final avec les données extraites
            return {
              title: typeBien,
              ville,
              price,
              surface,
              bedrooms: bedrooms || 0,
              pieces: pieces || 0,
              description,
              photos,
              url: window.location.href,
              source: 'Acheter-louer',
              timestamp: new Date().toISOString()
            };
          });
          
          // Vérifier les données et insérer dans la base de données
          if (property.title && property.price) {
            await insertAnnonce({
              type: property.title.split(' ')[0] || 'Non spécifié',
              prix: property.price,
              ville: property.ville,
              pieces: property.pieces,
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Acheter-louer",
              lien: request.url,
            });
          } else {
            log.warning(`⚠️ Acheter-louer - Données incomplètes pour ${request.url}`);
            await insertErreur("Acheter-louer", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`❌ Acheter-louer - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Acheter-louer", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Acheter-louer - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Supprimer les annonces qui ne sont plus présentes
  await deleteMissingAnnonces("Acheter-louer", liensActuels);

  console.log(" Acheter-louer - Scraping Acheter-louer terminé !");
};
