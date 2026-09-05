/*
 * PWA install helper — Morning do Trader
 * Cole este arquivo como /pwa-install.js e inclua no <head> (ou fim do
 * <body>) de TODAS as páginas do site com:
 *   <script src="/pwa-install.js" defer></script>
 *
 * O que ele faz:
 *  1. Registra o service worker (/sw.js).
 *  2. Mostra um botão "Instalar App" no cabeçalho (ao lado do título do
 *     site, dentro de <span id="pwa-nav-slot"></span>) quando o navegador
 *     permite instalar (Chrome/Edge/Android). Se a página não tiver esse
 *     slot, cai de volta no botão flutuante no canto da tela.
 *  3. No Safari/iOS (que não tem o prompt automático de instalação),
 *     mostra o mesmo botão mas, ao clicar, explica o passo manual
 *     (Compartilhar > Adicionar à Tela de Início).
 *  4. Esconde o botão sozinho se o app já estiver instalado/aberto
 *     como app (modo standalone).
 */
(function () {
  "use strict";

  // 1) Registrar o service worker
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function (err) {
        console.warn("[PWA] falha ao registrar service worker:", err);
      });
    });
  }

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  if (isStandalone()) return; // já é app instalado, não mostra nada

  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  var navSlot = document.getElementById("pwa-nav-slot");

  // 2) Botão — encaixado no cabeçalho quando existir o slot, senão flutuante
  var style = document.createElement("style");
  style.textContent =
    "#pwa-install-btn{display:none;align-items:center;justify-content:center;" +
    "gap:6px;border:none;cursor:pointer;font-family:inherit;font-weight:600;" +
    "color:#fff;background:#10b981;box-shadow:0 2px 8px rgba(0,0,0,.35);" +
    "transition:transform .15s ease, box-shadow .15s ease;}" +
    "#pwa-install-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.45);}" +
    "#pwa-install-btn svg{width:16px;height:16px;flex:none;}" +
    /* Estilo padrão (sem slot no cabeçalho): botão flutuante, canto da tela */
    "body:not(.pwa-has-nav-slot) #pwa-install-btn{position:fixed;right:18px;bottom:18px;" +
    "z-index:9999;padding:12px 18px;border-radius:999px;font-size:14px;}" +
    /* Estilo no cabeçalho: ícone pequeno e redondo, ao lado do título */
    "body.pwa-has-nav-slot #pwa-install-btn{position:static;width:30px;height:30px;" +
    "border-radius:50%;padding:0;font-size:0;flex:none;}" +
    "body.pwa-has-nav-slot #pwa-install-btn span{display:none;}" +
    "#pwa-ios-tip{position:fixed;left:12px;right:12px;bottom:78px;z-index:9999;" +
    "display:none;background:#111;color:#fff;padding:14px 16px;border-radius:14px;" +
    "font-family:inherit;font-size:13.5px;line-height:1.45;box-shadow:0 10px 30px rgba(0,0,0,.4);}" +
    "#pwa-ios-tip b{color:#10b981;}" +
    "#pwa-ios-tip .pwa-close{position:absolute;top:6px;right:10px;cursor:pointer;opacity:.7;font-size:16px;}" +
    "@media (min-width:640px){#pwa-ios-tip{left:auto;width:300px;bottom:78px;right:18px;}}" +
    "body.pwa-has-nav-slot #pwa-ios-tip{bottom:auto;top:64px;}" +
    "@media (min-width:640px){body.pwa-has-nav-slot #pwa-ios-tip{left:16px;right:auto;top:64px;}}";
  document.head.appendChild(style);

  if (navSlot) document.body.classList.add("pwa-has-nav-slot");

  var btn = document.createElement("button");
  btn.id = "pwa-install-btn";
  btn.title = "Instalar App";
  btn.setAttribute("aria-label", "Instalar App");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
    "<span>Instalar App</span>";
  (navSlot || document.body).appendChild(btn);

  var tip = document.createElement("div");
  tip.id = "pwa-ios-tip";
  tip.innerHTML =
    '<span class="pwa-close">✕</span>' +
    "Pra instalar no iPhone/iPad: toque no ícone <b>Compartilhar</b> (o quadrado com a setinha ↑ na barra do Safari) e depois em <b>“Adicionar à Tela de Início”</b>.";
  document.body.appendChild(tip);
  tip.querySelector(".pwa-close").addEventListener("click", function () {
    tip.style.display = "none";
  });

  var deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    btn.style.display = "inline-flex";
  });

  window.addEventListener("appinstalled", function () {
    btn.style.display = "none";
    tip.style.display = "none";
    deferredPrompt = null;
  });

  if (isIOS) {
    // Safari nunca dispara beforeinstallprompt — mostra o botão direto.
    btn.style.display = "inline-flex";
  }

  btn.addEventListener("click", function () {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () {
        deferredPrompt = null;
      });
      return;
    }
    // iOS (ou navegador sem suporte a beforeinstallprompt): mostra dica manual
    tip.style.display = tip.style.display === "block" ? "none" : "block";
  });
})();
