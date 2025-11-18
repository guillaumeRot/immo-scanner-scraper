import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const kermarrecScraper = async () => {
  const requestQueue = await RequestQueue.open(`kermarrec-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.kermarrec-habitation.fr/achat/?post_type=achat&false-select=on&1d04ea34=chateaugiron&ville%5B%5D=vitre-35500&ville%5B%5D=chateaugiron-35410&typebien%5B%5D=immeuble&typebien%5B%5D=maison&budget_max=400000&reference=&rayon=0&avec_carte=false&tri=pertinence",
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
        log.info(`🔎 Kermarrec - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info("✅ Kermarrec - Page chargée.");
        
        // Popup cookies
        const cookiePopup = page.locator("#didomi-popup");
        if (await cookiePopup.isVisible({ timeout: 5000 }).catch(() => false)) {
            await page.click("button#didomi-notice-agree-button");
        }

        // Attendre que les annonces soient chargées
        await page.waitForSelector("article.list-bien", { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval("article.list-bien a.link-full", (els) =>
          els.map((a) => a.href)
        );

        log.info(`📌 Kermarrec - ${links.length} annonces trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of links) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Gestion pagination
        const nextButton = page.locator("a.next.page-numbers");
        if ((await nextButton.count()) > 0) {
          const nextUrl = await nextButton.getAttribute("href");
          if (nextUrl) {
            log.info("➡️ Kermarrec - Page suivante détectée, ajout dans la file...");
            await requestQueue.addRequest({ 
              url: nextUrl, 
              userData: { label: "LIST_PAGE" } 
            });
          }
        } else {
          log.info("✅ Kermarrec - Fin de la pagination détectée.");
        }
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Kermarrec - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Gérer la popup cookies si elle apparaît
          const cookiePopup = page.locator("#didomi-popup");
          if (await cookiePopup.isVisible({ timeout: 5000 }).catch(() => false)) {
              await page.click("button#didomi-notice-agree-button");
          }

          // Extraction des informations principales
          const extractData = async (selector) => {
            try {
              const element = await page.$(selector);
              if (!element) return '';
              
              return await page.evaluate(el => {
                const clone = el.cloneNode(true);
                const ico = clone.querySelector('.ico');
                if (ico) ico.remove();
                return clone.textContent.trim().replace(/^[\s\n]+|[\s\n]+$/g, '');
              }, element);
            } catch (e) {
              log.warning(`⚠️ Erreur lors de l'extraction: ${e.message}`);
              return '';
            }
          };

          // Extraire les données
          const [ville, surfaceText, typologie] = await Promise.all([
            extractData('.entry-description-content p:has(.ico[data-ico="ville"])'),
            extractData('.entry-description-content p:has(.ico[data-ico="surface"])'),
            extractData('.entry-description-content p:has(.ico[data-ico="typologie"])')
          ]);

          // Extraire le prix (avec gestion des espaces et du texte HAI)
          let prix = '';
          try {
            const prixElement = await page.$('.entry-price');
            if (prixElement) {
              prix = await page.evaluate(el => {
                return el.textContent.replace(/[^0-9]/g, '');
              }, prixElement);
            }
          } catch (e) {
            log.warning(`⚠️ Impossible d'extraire le prix: ${e.message}`);
          }

          // Extraire la surface (en m²)
          let surface = surfaceText ? surfaceText.replace(/[^0-9,.]/g, '').replace(',', '.') : '';
          
          // Extraire le nombre de pièces et chambres depuis la typologie
          let pieces = '';
          let chambres = '';
          if (typologie) {
            const piecesMatch = typologie.match(/(\d+)\s*pi[èe]ce/i);
            const chambresMatch = typologie.match(/(\d+)\s*ch(?:ambres?)?/i);
            pieces = piecesMatch ? piecesMatch[1] : '';
            chambres = chambresMatch ? chambresMatch[1] : '';
          }

          // Récupérer la description
          let description = '';
          try {
            description = await page.$eval('#description p', 
              el => el.textContent?.trim() || ''
            );
          } catch (e) {
            log.warning(`⚠️ Impossible d'extraire la description: ${e.message}`);
          }

          // Récupérer les photos
          const photos = await page.$$eval('.entry-medias img', 
            imgs => imgs.map(img => img.src).filter(src => src)
          );

          // Récupérer le DPE (lettre de performance énergétique)
          let dpe = '';
          try {
            dpe = await page.$eval('.emission-diagram .diag_selected .diag_letter', 
              el => el.textContent?.trim() || ''
            );
          } catch (e) {
            log.warning(`⚠️ Impossible d'extraire le DPE: ${e.message}`);
          }

          // Récupérer le GES (émissions de CO2)
          let ges = '';
          try {
            ges = await page.$eval('.diag_ges .diag_selected .diag_letter', 
              el => el.textContent?.trim() || ''
            );
          } catch (e) {
            log.warning(`⚠️ Impossible d'extraire le GES: ${e.message}`);
          }

          if (ville && prix) {
            await insertAnnonce({
              type: typologie || 'Non spécifié',
              prix: parseInt(prix) || 0,
              ville: ville,
              pieces: parseInt(pieces) || 0,
              chambres: parseInt(chambres) || 0,
              surface: parseFloat(surface) || 0,
              description: description,
              photos: photos,
              dpe: dpe,
              ges: ges,
              agence: "Kermarrec",
              lien: request.url,
            });
            liensActuels.push(request.url);
          } else {
            log.warning(`⚠️ Kermarrec - Données incomplètes pour ${request.url} (ville ou prix manquant)`);
            await insertErreur("Kermarrec", request.url, "Données incomplètes (ville ou prix manquant)");
          }
        } catch (err) {
          log.error(`❌ Kermarrec - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Kermarrec", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Kermarrec - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Kermarrec", Array.from(new Set(liensActuels)));

  console.log("✅ Kermarrec - Scraping Kermarrec terminé !");
};
