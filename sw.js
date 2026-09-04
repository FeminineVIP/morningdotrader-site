/*
 * Service Worker do Morning do Trader
 * Estratégia: NETWORK-FIRST para tudo.
 *
 * Por quê network-first e não cache-first? Este site mostra dados de
 * mercado ao vivo (cotações, calendário econômico, fluxo, etc). Um
 * service worker "cache-first" clássico faria o app abrir com dados
 * DESATUALIZADOS sempre que estivesse em cache — o pior cenário possível
 * pra um painel de trading. Por isso aqui o SW:
 *   1. Sempre tenta a rede primeiro.
 *   2. Se a rede responder, atualiza o cache e devolve a resposta fresca.
 *   3. Só usa o cache (versão antiga) se o dispositivo estiver OFFLINE
 *      de verdade (sem internet) — como uma rede de segurança, não como
 *      comportamento padrão.
 *
 * Isso é o suficiente para o site ser "instalável" (critério do Chrome/
 * Android exige um SW com fetch handler) e ainda funcionar minimamente
 * sem internet (abre a última tela vista, em vez de tela de erro).
 */

const CACHE_VERSION = "v1"; // troque esse valor a cada novo deploy pra invalidar o cache antigo
const CACHE_NAME = "morningdotrader-" + CACHE_VERSION;

// Apenas o essencial pro "app shell" (ícones/manifest). As páginas HTML
// e dados NÃO são pré-cacheados aqui de propósito — eles são cacheados
// sob demanda, sempre a partir de uma resposta de rede bem-sucedida.
const PRECACHE_URLS = [
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("morningdotrader-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Só trata GET; deixa POST (ex: envio de formulário/login) passar direto.
  if (req.method !== "GET") return;

  // Não intercepta chamadas a outros domínios (widgets TradingView, APIs
  // de terceiros, etc.) — deixa o navegador lidar normalmente com elas.
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return networkResponse;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("/index.html")))
  );
});
