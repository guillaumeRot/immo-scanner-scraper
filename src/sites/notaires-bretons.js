import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const notairesBretonsScraper = async () => {
  const requestQueue = await RequestQueue.open(`notaires-bretons-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.notaireetbreton.bzh/biens/achat/immeuble%2Cmaison-individuelle/vitre-35500?field_price_value%5Bmax%5D=400000&sort_bef_combine=field_price_value_ASC&display-mode=list",
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
        log.info(`Notaires Bretons - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info("Notaires Bretons - Page chargée.");

        // Attendre que les annonces soient chargées
        await page.waitForSelector('.view-content .node--type-property', { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          '.view-content .node--type-property .node__content > a[href^="/biens/"]',
          (anchors) => anchors.map(a => {
            // Construire l'URL complète
            const baseUrl = window.location.origin;
            const path = a.getAttribute('href');
            return new URL(path, baseUrl).href;
          })
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`Notaires Bretons - ${uniqueLinks.length} annonces uniques trouvées.`);
        
        // Ajouter chaque annonce dans la file pour traitement détaillé
        for (const annonceUrl of uniqueLinks) {
          await requestQueue.addRequest({ 
            url: annonceUrl, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }
      }

      // Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`Notaires Bretons - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Fonction utilitaire pour extraire le texte d'un élément par son libellé
            const getValueByLabel = (label) => {
              const element = Array.from(document.querySelectorAll('.product-criteres .list-group-item'))
                .find(li => li.textContent.includes(label));
              return element?.querySelector('b')?.textContent.trim() || '';
            };

            // Ville (depuis le fil d'Ariane, 5ème élément)
            const cityElement = document.querySelector('nav.breadcrumb li:nth-child(5) span[itemprop="name"]');
            let city = cityElement ? cityElement.textContent.trim() : '';
            // Nettoyer le code postal entre parenthèses si présent (ex: "VITRE (35500)" -> "VITRE")
            city = city.replace(/\(.*\)/g, '').trim();
            
            // Type de bien (depuis le fil d'Ariane)
            const typeElement = document.querySelector('nav.breadcrumb li:nth-child(3) span[itemprop="name"]');
            const type = typeElement ? typeElement.textContent.trim() : 'Autre';
            
            // Prix
            const priceElement = document.querySelector('.field--name-field-price');
            const priceText = priceElement ? priceElement.textContent.trim() : '';
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // Récupération des caractéristiques principales
            const getFieldValue = (fieldName, isNumeric = true) => {
              const element = document.querySelector(`.field--name-${fieldName} .field__item`);
              if (!element) return isNumeric ? 0 : '';
              const text = element.textContent.trim();
              return isNumeric ? parseInt(text.replace(/\D/g, '')) || 0 : text;
            };
            
            // Surface habitable
            const surface = getFieldValue('field-living-space');
            
            // Surface du terrain
            const landSurface = getFieldValue('field-land-space');

            // Photos - Récupération depuis le carrousel
            const photos = Array.from(document.querySelectorAll('.owl-stage .owl-item img[src*="/property/"]')).map(img => {
              // Récupérer l'URL de l'image et nettoyer les paramètres
              const imgUrl = img.getAttribute('src');
              // Supprimer les paramètres de l'URL (après le ?) pour avoir l'image en pleine résolution
              return imgUrl.split('?')[0];
            }).filter((url, index, self) => 
              url && self.indexOf(url) === index // Éliminer les doublons
            ).map(relativeUrl => {
              // Convertir en URL absolue si nécessaire
              return relativeUrl.startsWith('http') ? relativeUrl : `https://www.notaireetbreton.bzh${relativeUrl}`;
            });
            
            // Nombre de chambres - ciblage par l'ID du SVG
            const bedroomsElement = document.querySelector('svg#g5ere_bed')?.closest('.iwp__overview-item')?.querySelector('strong');
            const bedroomsText = bedroomsElement ? bedroomsElement.textContent.trim() : '0';
            const bedrooms = parseInt(bedroomsText) || 0;
            
            // Nombre de salles de bain - ciblage par l'ID du SVG
            const bathroomElement = document.querySelector('svg#g5ere_bath')?.closest('.iwp__overview-item')?.querySelector('strong');
            const bathroomText = bathroomElement ? bathroomElement.textContent.trim() : '0';
            const sdb = parseInt(bathroomText) || 0;
                        
            // Description
            const descriptionElement = document.querySelector('.description-content p');
            const description = descriptionElement ? 
              descriptionElement.textContent
                .replace(/\s+/g, ' ') // Remplacer les espaces multiples par un seul espace
                .trim() 
              : '';
            

            return {
              type,
              price,
              surface,
              landSurface,
              bedrooms,
              pieces: bedrooms + 1, // On suppose que le nombre de pièces = chambres + séjour
              sdb: sdb,
              description,
              city,
              photos,
              url: window.location.href,
              source: 'Notaires et Bretons',
              timestamp: new Date().toISOString()
            };
          });
          
          // Vérifier les données et insérer dans la base de données
          if (property.type && property.price) {
            await insertAnnonce({
              type: property.type,
              prix: property.price,
              ville: property.city,
              pieces: property.pieces,
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Notaires et Bretons",
              lien: request.url,
            });
            liensActuels.push(request.url);
          } else {
            log.warning(`⚠️ Notaires Bretons - Données incomplètes pour ${request.url}`);
            await insertErreur("Notaires et Bretons", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`🚨 Notaires Bretons - Erreur pour ${request.url}: ${err.message}`);
          await insertErreur("Notaires et Bretons", request.url, err.message);
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Notaires Bretons - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Notaires et Bretons", Array.from(new Set(liensActuels)));

  console.log("✅ Notaires Bretons - Scraping terminé !");
};
