# Déploiement Vercel + planification automatique

## Ce qui a changé dans le code

- **3 scrapers désactivés** (Figaro, Logic-immo, Ouest-France) : nécessitent Playwright,
  incompatible avec une fonction serverless. Code conservé dans `src/sites/` mais plus
  importé par `src/app.js`.
- **`db.js`** : le pool Postgres n'est plus tenu ouvert via un client unique — chaque
  requête passe par `pool.query()`, adapté aux invocations serverless (froides/chaudes).
- **`package.json`** : `playwright`, `crawlee`, `playwright-extra`, `puppeteer-extra-plugin-stealth`
  retirés (plus utilisés) — build Vercel plus rapide, pas de téléchargement de Chromium.
- **Auth** : `/run-scrapers` est protégé par un secret partagé (header `x-cron-secret` ou
  `?secret=`). Sans `CRON_SECRET` défini, la vérification est ignorée (pratique en local).
- **`api/index.js` + `vercel.json`** : point d'entrée serverless, toutes les routes sont
  réécrites vers cette fonction, `maxDuration: 60` (plafond du plan Hobby).
- **Bugs corrigés en cours de route** (remontés en testant chaque scraper contre la limite
  de 60s) :
  - `diard.js` scrapait la France entière sans filtre de ville (126s, plusieurs erreurs) →
    ajout du filtre `C_65` par ville (Vitré/Châteaugiron), comme Boyer. Passe à ~7s.
  - `bien-ici.js` plantait au-delà d'un certain offset ("Too many ads requested") et
    dépassait 60s (2500+ annonces traitées, dont l'écrasante majorité hors zone utile) →
    pagination désormais plafonnée à 5 pages par ville, zones interrogées séparément.
    Passe de 63,7s à ~31s.
  - `db.js` : `dpe`/`ges` sont stockés en `VARCHAR(1)` ; une valeur non conforme (ex. API
    tierce renvoyant autre chose qu'une lettre A-G) faisait planter l'insertion. Ajout
    d'une validation qui met `null` au lieu de faire échouer la requête.

Chaque scraper a été testé individuellement en local après ces correctifs : les 15
scrapers actifs tournent tous en moins de 35 secondes, avec 0 erreur (à part quelques
"données incomplètes" ponctuelles sur des annonces mal formées côté site source, gérées
normalement par le code existant).

## 1. Déployer sur Vercel

Depuis le dossier du projet :

```bash
npm install -g vercel   # si pas déjà installé
vercel login
vercel link             # associe ce dossier à un projet Vercel
vercel --prod            # déploiement
```

### Variables d'environnement à définir sur Vercel

Dashboard Vercel → Project → Settings → Environment Variables :

| Variable | Valeur |
| --- | --- |
| `DATABASE_URL` | La même que dans `.env` (Neon, déjà configuré avec pooler — compatible serverless) |
| `CRON_SECRET` | Une valeur secrète aléatoire, ex. générée ci-dessous |

Génère un secret avec :
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
Utilise la même valeur ici et dans cron-job.org (étape 2).

Après avoir ajouté les variables, redéployer (`vercel --prod`) pour qu'elles soient prises
en compte.

## 2. Planifier les scrapers avec cron-job.org

Crée un compte sur [cron-job.org](https://cron-job.org), puis une tâche **par scraper**
(15 au total). Pour chaque tâche :

- **URL** : `https://<ton-domaine-vercel>.vercel.app/run-scrapers?scraper=<nom>&secret=<CRON_SECRET>`
- **Méthode** : GET
- **Planification** : cron-job.org permet de choisir plusieurs horaires dans une même
  tâche — sélectionner 3 horaires par jour.

⚠️ **Fuseau horaire** : cron-job.org programme en UTC. Pour 6h/12h/18h heure de Paris,
utiliser **4h/10h/16h UTC** en été (CEST, actuellement) ou **5h/11h/17h UTC** en hiver
(CET) — il faudra ajuster manuellement les tâches au changement d'heure (fin
mars / fin octobre), cron-job.org ne gère pas le fuseau France automatiquement.

Liste des 15 scrapers actifs (valeur du paramètre `scraper`) :

```
kermarrec, era, blot, carnot, penn, diard, century, bretilimmo,
boyer, notaires-bretons, immobilier-notaires, acheter-louer,
bien-ici, immonot, fnaim
```

Exemple d'URL complète pour Kermarrec :
```
https://ton-projet.vercel.app/run-scrapers?scraper=kermarrec&secret=e0509eed16a4d4cb3d79b63f33f0f568e7359c20d7b28f1b
```
(remplacer par ton vrai domaine Vercel et ton vrai `CRON_SECRET`, ne pas réutiliser
l'exemple ci-dessus tel quel)

## 3. Nettoyage à décider

Les tables contiennent encore des annonces issues de Figaro Immobilier et Ouest-France
Immo (79 et 191 lignes actuellement) provenant des tests effectués avant leur
désactivation. Comme ces scrapers ne tourneront plus, ces lignes resteront figées
(jamais mises à jour ni supprimées automatiquement). Si moteur-immo doit remplacer ces
deux sources, il faudra soit :
- les laisser telles quelles (données qui devienDront progressivement obsolètes),
- soit les supprimer manuellement : `DELETE FROM "Annonce" WHERE agence IN ('Figaro Immobilier', 'Ouest-France Immo');`

## 4. Vérifier après déploiement

```bash
curl "https://ton-projet.vercel.app/run-scrapers?scraper=kermarrec&secret=TON_SECRET"
```
Doit renvoyer `{"status":"done",...}`. Vérifier aussi dans le dashboard Vercel
(Functions → Logs) qu'aucune fonction ne dépasse ~40-50s (marge sous les 60s max).
