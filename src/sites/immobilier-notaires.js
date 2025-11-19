import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

// Fonction pour extraire les URLs d'une page donnée
const extractAnnoncesFromPage = async (page) => {
  // Attendre que les annonces soient chargées
  await page.waitForSelector('.container_criteres_description', { timeout: 10000 });
  
  // Récupérer les liens des annonces de la page
  const pageLinks = await page.$$eval(
    '.container_criteres_description',
    (anchors) => {
      const uniqueLinks = new Set();
      anchors.forEach(a => {
        const href = a.getAttribute('href');
        if (href) {
          const fullUrl = new URL(href, window.location.origin).href;
          uniqueLinks.add(fullUrl);
        }
      });
      return Array.from(uniqueLinks);
    }
  );
  
  return pageLinks;
};

// Fonction pour extraire toutes les URLs d'annonces en gérant la pagination
const extractAllAnnonces = async (page, startUrl) => {
  const allAnnonces = new Set();
  let currentUrl = startUrl;
  let pageNumber = 1;
  
  try {
    while (true) {
      console.log(`Traitement de la page ${pageNumber}: ${currentUrl}`);
      
      // Aller à la page courante
      await page.goto(currentUrl, { waitUntil: 'networkidle' });
      
      // Extraire les annonces de la page courante
      const pageAnnonces = await extractAnnoncesFromPage(page);
      pageAnnonces.forEach(url => allAnnonces.add(url));
      
      console.log(`Trouvé ${pageAnnonces.length} annonces sur cette page (total: ${allAnnonces.size})`);
      
      // Vérifier s'il y a une page suivante
      const hasNextPage = await page.evaluate(() => {
        return document.querySelector('li.pagination-next:not(.disabled)') !== null;
      });
      
      if (!hasNextPage) break;
      
      // Incrémenter le numéro de page pour la prochaine itération
      pageNumber++;
      currentUrl = updatePageNumberInUrl(currentUrl, pageNumber);
    }
    
    console.log(`Total des annonces uniques trouvées: ${allAnnonces.size}`);
    return Array.from(allAnnonces);
    
  } catch (error) {
    console.error('Erreur lors de l\'extraction des annonces:', error);
    return Array.from(allAnnonces); // Retourner ce qu'on a pu récupérer
  }
};

// Fonction utilitaire pour mettre à jour le numéro de page dans l'URL
const updatePageNumberInUrl = (url, pageNumber) => {
  const urlObj = new URL(url);
  urlObj.searchParams.set('page', pageNumber);
  return urlObj.toString();
};

export const immobilierNotairesScraper = async () => {
  const requestQueue = await RequestQueue.open(`immobilier-notaires-${Date.now()}`);
  const liensActuels = []; // Initialisation de la variable liensActuels
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
    ],
  });
  
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // URL de départ
    const startUrl = "https://www.immobilier.notaires.fr/fr/annonces-immobilieres-liste?page=1&parPage=12&prixMax=400000&localite=16149,15867&typeTransaction=VENTE,VNI,VAE&typeBien=MAI,IMM";
    
    // Extraire toutes les URLs d'annonces
    const allAnnonces = await extractAllAnnonces(page, startUrl);
    
    // Ajouter toutes les annonces à la file d'attente
    for (const annonceUrl of allAnnonces) {
      await requestQueue.addRequest({
        url: annonceUrl,
        userData: { label: "DETAIL_PAGE" },
        uniqueKey: annonceUrl
      });
    }
    
    console.log(`Total des annonces ajoutées à la file d'attente: ${allAnnonces.length}`);
    
  } catch (error) {
    console.error('Erreur lors du scraping:', error);
  } finally {
    await browser.close();
  }

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
        log.info(`Immobilier Notaires - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info("Immobilier Notaires - Page chargée.");

        // Attendre que les annonces soient chargées
        await page.waitForSelector('.container_criteres_description', { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          '.container_criteres_description',
          (anchors) => {
            // Créer un Set pour éliminer les doublons
            const uniqueLinks = new Set();
            anchors.forEach(a => {
              const href = a.getAttribute('href');
              uniqueLinks.add(href);
            });
            return Array.from(uniqueLinks);
          }
        );

        log.info(`Immobilier Notaires - ${links.length} annonces uniques trouvées.`);
        
        // Ajouter chaque annonce dans la file pour traitement détaillé
        for (const annonceUrl of links) {
          if (liensActuels.includes(annonceUrl)) continue; // Éviter les doublons
          
          liensActuels.push(annonceUrl);
          
          // await requestQueue.addRequest({ 
          //   url: annonceUrl, 
          //   userData: { label: "DETAIL_PAGE" } 
          // });
        }
        
        // Vérifier s'il y a une page suivante
        const hasNextPage = await page.evaluate(() => {
          const nextButton = document.querySelector('li.pagination-next:not(.disabled)');
          return nextButton !== null;
        });
        
        if (hasNextPage) {
          // Cliquer sur le bouton suivant
          await page.click('li.pagination-next:not(.disabled) a');
          
          // Attendre le chargement de la page suivante
          await page.waitForLoadState('networkidle');
          
          // Ajouter la même URL à la file d'attente pour traiter la page suivante
          // avec un identifiant unique pour éviter les doublons
          const nextPageUrl = page.url() + `&t=${Date.now()}`;
          await requestQueue.addRequest({
            url: nextPageUrl,
            userData: { label: "LIST_PAGE" },
            uniqueKey: `page-${Date.now()}`
          });
          
          // Sortir de la fonction actuelle pour éviter le traitement en double
          return;
        }
      }

      // Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`Immobilier Notaires - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "networkidle" });
          
          // Attendre un peu pour le chargement des images
          await page.waitForTimeout(2000);
          
          // Extraire les URLs des images
          const photos = await page.evaluate(() => {
            const images = [];
            // Essayer de trouver les images dans le carrousel
            const carouselImages = document.querySelectorAll('.ng-image-slider-container img[src*="media.immobilier.notaires.fr"]');
            if (carouselImages.length > 0) {
              carouselImages.forEach(img => {
                if (img.src && img.src.includes('media.immobilier.notaires.fr')) {
                  images.push(img.src);
                }
              });
            }
            return images;
          });

          // Extraction des autres informations
          const property = await page.evaluate(() => {
            // Type de bien - on prend le 2ème span dans le h1
            const typeElement = document.querySelector('inotr-titre-annonce h1 span:nth-child(2)');
            const type = typeElement ? typeElement.innerText.trim() : 'Inconnu';
            
            // Prix
            const priceElement = document.querySelector('[data-prix-prioritaire]');
            const priceText = priceElement ? priceElement.textContent.trim() : '';
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // Surface habitable (en m²)
            const surfaceElement = document.getElementById('data-description-surfaceHabitable');
            const surfaceText = surfaceElement ? surfaceElement.textContent.trim() : '';
            const surface = surfaceText ? parseInt(surfaceText.replace(/[^0-9]/g, '')) || 0 : 0;
            
            // Surface du terrain
            const landSurfaceElement = document.querySelector('[data-description-surfaceterrain]');
            const landSurfaceText = landSurfaceElement ? landSurfaceElement.textContent.trim() : '0';
            const landSurface = landSurfaceText ? parseInt(landSurfaceText.replace(/[^0-9]/g, '')) || 0 : 0;
            
            // Ville - on extrait le texte entre les deux tirets
            const locationElement = document.querySelector('inotr-titre-annonce h1 .localisation');
            const locationText = locationElement ? locationElement.textContent.trim() : '';
            const cityMatch = locationText.match(/-\s*([^-]+?)\s*-/);
            const city = cityMatch ? cityMatch[1] : '';
            
            // Nombre de pièces
            const piecesElement = document.getElementById('data-description-nbPieces.texte');
            const pieces = piecesElement ? parseInt(piecesElement.textContent.trim()) || 0 : 0;
            
            // Nombre de chambres
            const chambresElement = document.getElementById('data-description-nbChambres');
            const chambres = chambresElement ? parseInt(chambresElement.textContent.trim()) || 0 : 0;

            // Les photos sont déjà extraites avant cette évaluation
            
            // Nombre de salles de bain - ciblage par l'ID du SVG
            const bathroomElement = document.querySelector('svg#g5ere_bath')?.closest('.iwp__overview-item')?.querySelector('strong');
            const bathroomText = bathroomElement ? bathroomElement.textContent.trim() : '0';
            const sdb = parseInt(bathroomText) || 0;
                        
            // Description
            const descriptionElement = document.querySelector('inotr-description p');
            const description = descriptionElement ? 
              descriptionElement.textContent
                .replace(/\s+/g, ' ') // Remplacer les espaces multiples par un seul espace
                .trim() 
              : '';
            
            // DPE - extraire l'attribut "letter" de l'élément avec classe "lettres"
            const dpeElement = document.querySelector('.col_dpe .lettres[letter]');
            const dpe = dpeElement ? dpeElement.getAttribute('letter') : '';
            
            // GES - extraire l'attribut "letter" de l'élément avec classe "lettres" dans le conteneur "col_ges"
            const gesElement = document.querySelector('.col_ges .lettres[letter]');
            const ges = gesElement ? gesElement.getAttribute('letter') : '';

            return {
              type,
              price,
              surface,
              landSurface: landSurface,
              chambres: chambres,
              pieces: pieces, // On suppose que le nombre de pièces = chambres + séjour
              sdb: sdb,
              description,
              dpe,
              ges,
              city,
              url: window.location.href,
              source: 'Immobilier Notaires',
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
              chambres: property.chambres,
              surface: property.surface,
              description: property.description,
              dpe: property.dpe,
              ges: property.ges,
              photos: photos,
              agence: "Immobilier Notaires",
              lien: request.url,
            });
          } else {
            log.warning(`⚠️ Immobilier Notaires - Données incomplètes pour ${request.url}`);
            await insertErreur("Immobilier Notaires", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`🚨 Immobilier Notaires - Erreur pour ${request.url}: ${err.message}`);
          await insertErreur("Immobilier Notaires", request.url, err.message);
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
