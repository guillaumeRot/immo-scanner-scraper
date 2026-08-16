// Point d'entrée Vercel : Vercel détecte l'export par défaut (l'app Express)
// et l'utilise comme handler de fonction serverless (voir vercel.json pour le routage).
import app from "../src/app.js";

export default app;
