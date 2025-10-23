import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const boyerScraper = async () => {
  const requestQueue = await RequestQueue.open(`boyer-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.boyer-immobilier.fr/catalog/advanced_search_result.php?action=update_search&search_id=&map_polygone=&C_28_search=EGAL&C_28_type=UNIQUE&C_28=Vente&C_27_search=EGAL&C_27_type=TEXT&C_27=2%2C6&C_27_tmp=2&C_27_tmp=6&C_34_MIN=&C_34_search=COMPRIS&C_34_type=NUMBER&C_30_search=COMPRIS&C_30_type=NUMBER&C_30_MAX=400000&C_65_search=CONTIENT&C_65_type=TEXT&C_65=35500+VITRE&C_65_tmp=35500+VITRE&keywords=&C_33_MAX=&C_30_MIN=&C_38_MIN=&C_38_search=COMPRIS&C_38_type=NUMBER&C_38_MAX=",
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
        log.info(`Boyer - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info("Boyer - Page chargée.");

        // Attendre que les annonces soient chargées
        await page.waitForSelector("#listing_bien", { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          "#listing_bien a[href*='/fiches/']",
          (anchors) => anchors.map(a => a.href)
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`Boyer - ${uniqueLinks.length} annonces uniques trouvées.`);
        
        // Ajouter chaque annonce dans la file pour traitement détaillé
        for (const annonceUrl of uniqueLinks) {
          if (liensActuels.includes(annonceUrl)) continue; // Éviter les doublons
          
          liensActuels.push(annonceUrl);
          
          await requestQueue.addRequest({ 
            url: annonceUrl, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }
      }

      // Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`Boyer - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Fonction utilitaire pour extraire le texte d'un élément par son libellé
            const getValueByLabel = (label) => {
              const element = Array.from(document.querySelectorAll('.product-criteres .list-group-item'))
                .find(li => li.textContent.includes(label));
              return element?.querySelector('b')?.textContent.trim() || '';
            };

            // Ville
            const city = getValueByLabel('Ville');
            
            // Type de bien
            const type = getValueByLabel('Type de bien') || 'Autre';
            
            // Prix
            const priceText = getValueByLabel('Prix') || '';
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // Surface
            const surfaceText = getValueByLabel('Surface') || '';
            const surface = parseInt(surfaceText) || 0;

            // Photos - Récupération depuis le slider
            const photos = Array.from(document.querySelectorAll('#slider_product .item-slider a[href*="/images/pr_p/"]')).map(link => {
              // Construire l'URL complète en partant de l'URL de base du site
              const baseUrl = window.location.origin;
              const imgPath = link.getAttribute('href').replace(/^\.\.\//, ''); // Enlever les ../ du début
              return `${baseUrl}/${imgPath}`;
            }).filter((url, index, self) => 
              url && self.indexOf(url) === index // Éliminer les doublons
            );
            
            // Nombre de chambres - ciblage par l'ID du SVG
            const bedroomsElement = document.querySelector('svg#g5ere_bed')?.closest('.iwp__overview-item')?.querySelector('strong');
            const bedroomsText = bedroomsElement ? bedroomsElement.textContent.trim() : '0';
            const bedrooms = parseInt(bedroomsText) || 0;
            
            // Nombre de salles de bain - ciblage par l'ID du SVG
            const bathroomElement = document.querySelector('svg#g5ere_bath')?.closest('.iwp__overview-item')?.querySelector('strong');
            const bathroomText = bathroomElement ? bathroomElement.textContent.trim() : '0';
            const sdb = parseInt(bathroomText) || 0;
            
            // Surface du terrain - ciblage par l'ID du SVG
            const landElement = document.querySelector('svg#g5ere_interface')?.closest('.iwp__overview-item')?.querySelector('strong');
            const landText = landElement ? landElement.textContent.match(/\d+/)?.[0] || '0' : '0';
            const landSurface = parseInt(landText) || null;
            
            // Description
            const descriptionElement = document.querySelector('.product-description');
            let description = '';
            
            if (descriptionElement) {
              // Récupérer uniquement le texte direct du parent, sans les enfants
              const textNodes = [];
              const walker = document.createTreeWalker(
                descriptionElement,
                NodeFilter.SHOW_TEXT,
                { 
                  acceptNode: function(node) {
                    // Ne prendre que les nœuds de texte qui sont des enfants directs
                    if (node.parentNode === descriptionElement) {
                      return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_REJECT;
                  }
                }
              );
              
              let node;
              while (node = walker.nextNode()) {
                const text = node.textContent.trim();
                if (text) {
                  textNodes.push(text);
                }
              }
              
              description = textNodes.join('\n\n')
                .replace(/\s+/g, ' ') // Remplacer les espaces multiples par un seul espace
                .trim();
            }
            

            return {
              type,
              price,
              surface,
              landSurface: landSurface,
              bedrooms: bedrooms,
              pieces: bedrooms + 1, // On suppose que le nombre de pièces = chambres + séjour
              sdb: sdb,
              description,
              city,
              photos,
              url: window.location.href,
              source: 'Boyer Immobilier',
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
              agence: "Boyer Immobilier",
              lien: request.url,
            });
          } else {
            log.warning(`⚠️ Boyer - Données incomplètes pour ${request.url}`);
            await insertErreur("Boyer Immobilier", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`🚨 Boyer - Erreur pour ${request.url}: ${err.message}`);
          await insertErreur("Boyer Immobilier", request.url, err.message);
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Boyer - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Boyer Immobilier", Array.from(new Set(liensActuels)));

  console.log("✅ Boyer - Scraping Boyer Immobilier terminé !");
};
