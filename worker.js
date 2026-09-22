// Worker unico do site Morning do Trader
// Reune: painel manual (minerio/suporte-resistencia), Fear & Greed, as 2 listas de noticias,
// Telegram, o proxy do Polymarket (Gamma API), o FedWatch (probabilidades Fed Funds)
// e a captura de leads do Kit Gratuito do Trader (Planilha + Diario).
//
// CONFIGURAR ANTES DE PUBLICAR:
// 1. Crie um KV Namespace na Cloudflare (Workers > KV) chamado, por exemplo, MANUAL_DATA
//    e vincule esse Worker a ele com o nome "MANUAL_DATA" (Settings > Variables > KV Namespace Bindings).
// 2. Crie uma variavel de ambiente secreta chamada EDIT_KEY com uma senha sua (Settings > Variables > Secrets).
//    Essa e a "chave" que voce vai usar na URL ?editar=SUACHAVE do site pra poder editar o painel manual.
// 3. NOVO: configure um Cron Trigger em Settings > Triggers > Cron Triggers, por exemplo
//    "0 10 * * *" (todo dia as 10:00 UTC, ~07:00 horario de Brasilia) para o FedWatch
//    atualizar sozinho todo dia.
// 4. NOVO (Kit Gratuito do Trader): crie um segundo KV Namespace chamado LEADS_KV e
//    vincule esse Worker a ele com o nome "LEADS_KV" (Settings > Variables > KV Namespace
//    Bindings). Depois configure as secrets RESEND_API_KEY e EMAIL_FROM (mesma conta
//    Resend ja usada no Painel do Trader funciona — e' so' um remetente diferente, ex:
//    EMAIL_FROM = "Morning do Trader <kit@morningdotrader.com.br>") e confirme que o
//    dominio morningdotrader.com.br esta verificado no Resend (Domains).

const SR_FIELDS = ["dolar_r3", "dolar_r2", "dolar_r1", "dolar_divisor", "indice_r3", "indice_r2", "indice_r1", "indice_divisor", "dolar_s1", "dolar_s2", "dolar_s3", "indice_s1", "indice_s2", "indice_s3"];
const EXTRA_FIELDS = [
  // Fluxo B3 (Fluxo de Investidores) - inalterado, continua funcionando como antes
  "fluxo_estrangeiro", "fluxo_institucional", "fluxo_pessoa_fisica", "fluxo_inst_financeira", "fluxo_outros", "fluxo_b3_grafico",
  // Fluxo por Investidor - Quantzed/XP (substituiu o antigo Fluxo Cambial BC, que dependia da API do Banco Central e parou de publicar)
  "fluxo_estrangeiro_vista", "fluxo_estrangeiro_futuro", "fluxo_estrangeiro_total",
  "fluxo_institucional_vista", "fluxo_institucional_futuro", "fluxo_institucional_total",
  "fluxo_instfin_vista", "fluxo_instfin_futuro", "fluxo_instfin_total",
  "fluxo_pf_vista", "fluxo_pf_futuro", "fluxo_pf_total",
  "fluxo_outros_vista", "fluxo_outros_total",
  "featured_news_title", "featured_news_url",
  // Alerta do Dia - bloco opcional pra evento/noticia de alto impacto (Payroll,
  // FOMC, Copom...) ou espaco de propaganda (ex: "Um oferecimento de Painel
  // do Trader" + icone). So aparece no site quando alerta_titulo e preenchido.
  "alerta_tag", "alerta_titulo", "alerta_texto", "alerta_imagem", "alerta_countdown_ate",
  // Destaque para Apresentacao / Parceiro (1 e 2) - ate 2 cards de
  // patrocinio pontuais pra parcerias/reunioes (ex: Dom Investimentos,
  // TopGain), no lugar onde antes ficava o carrossel do Mercado Livre.
  // Etiqueta editavel (padrao "Patrocinado" se vazia). Cada um so aparece
  // no site quando o respectivo campo de titulo e preenchido.
  "parceiro_tag", "parceiro_titulo", "parceiro_texto", "parceiro_imagem", "parceiro_link",
  "parceiro2_tag", "parceiro2_titulo", "parceiro2_texto", "parceiro2_imagem", "parceiro2_link"
];

const FEDWATCH_URL = "https://www.investing.com/central-banks/fed-rate-monitor";

// ============================================================================
// KIT GRATUITO DO TRADER - captura de leads (Planilha + Diario)
// ============================================================================

const SITE_URL = "https://morningdotrader.com.br";
// URL do proprio Worker (nao tem dominio proprio configurado ainda, so o
// workers.dev padrao) -- usada pra montar o link do /api/acesso-confirmar,
// que precisa apontar pra ca (o Worker), nao pro site estatico.
const WORKER_URL = "https://morningdotrader-api.luiz-sso.workers.dev";

const BRINDES = {
  "planilha-trader": {
    nome: "Planilha do Trader",
    arquivo: "planilha-trader.xlsx",
    assunto: "Sua Planilha do Trader chegou",
  },
  "diario-trader": {
    nome: "Diário do Trader",
    arquivo: "diario-do-trader.xlsx",
    assunto: "Seu Diário do Trader chegou",
  },
  "guia-risco": {
    nome: "Guia de Gestão de Risco",
    arquivo: "guia-gestao-risco.pdf",
    assunto: "Seu Guia de Gestão de Risco chegou",
  },
  "desafio-21-pregoes": {
    nome: "Desafio 21 Pregões",
    arquivo: "desafio-21-pregoes.xlsx",
    assunto: "Sua planilha do Desafio 21 Pregões chegou",
  },
};

function emailValido(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Mesmo estilo de e-mail transacional ja usado no Painel do Trader: banner de
// imagem (nao CSS background, pra funcionar em qualquer cliente de e-mail) +
// botao numa linha so' (softwares de rastreamento de clique costumam quebrar
// tags de varias linhas).
async function enviarBrindeEmail(env, email, brindeKey) {
  const info = BRINDES[brindeKey];
  const link = `${SITE_URL}/${info.arquivo}`;

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f14;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#141c26;border:1px solid #223041;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td style="width:10px;height:10px;background:#4da3ff;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                <td style="padding-left:10px;color:#8fa1b3;font-size:13px;letter-spacing:0.04em;font-family:'SFMono-Regular',Menlo,Consolas,monospace;">MORNING DO TRADER</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 0;">
              <h1 style="margin:0 0 12px;color:#e8edf2;font-size:22px;line-height:1.3;">${info.nome} — aqui está</h1>
              <p style="margin:0 0 26px;color:#8fa1b3;font-size:14.5px;line-height:1.6;">Clique no botão abaixo pra baixar. Guarde este e-mail — o link não expira.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <a href="${link}" style="display:inline-block;background:#4da3ff;color:#08131f;padding:14px 26px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;">Baixar ${info.nome}</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <p style="margin:0 0 6px;color:#5b6b7a;font-size:12.5px;">Se o botão não funcionar, copie e cole este link no navegador:</p>
              <p style="margin:0;word-break:break-all;color:#4da3ff;font-size:12.5px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;">${link}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #1a2531;">
              <p style="margin:0;color:#5b6b7a;font-size:12.5px;line-height:1.6;">Você recebeu este e-mail porque pediu esse material em morningdotrader.com.br. Se não foi você, pode ignorar com segurança.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: info.assunto,
      html,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("Falha ao enviar e-mail via Resend: " + errText);
  }
}

// ============================================================================
// FERRAMENTAS DO TRADER - login por link magico (Calculadora de Risco,
// Recuperacao de Prejuizo, Plano de Trade)
//
// Mesmo MECANISMO de login sem senha ja usado no Painel do Trader (link
// magico por e-mail, token de uso unico, depois um token de sessao), mas
// com KV e registro totalmente separados (LEADS_KV, nao PAINEL_KV) -- os
// dois produtos continuam sem nenhuma ligacao entre si.
//
// Diferenca importante em relacao ao Painel do Trader: aqui a API roda em
// workers.dev (nao num subdominio de morningdotrader.com.br), entao nao da
// pra usar cookie cross-domain (o navegador rejeita Set-Cookie com Domain
// de um site diferente do que respondeu). Por isso a sessao trafega como um
// token simples: o link magico redireciona pro site com "?sessao=TOKEN" na
// URL, o front-end guarda esse token no localStorage e manda ele de volta
// em cada chamada (header "x-sessao" ou "?sessao="). Funciona igual, so
// muda o transporte.
//
// Um unico cadastro (e-mail + WhatsApp) destrava as 3 ferramentas.
// ============================================================================

function randomToken(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

function whatsappValido(digits) {
  return typeof digits === "string" && digits.length >= 10 && digits.length <= 13;
}

async function enviarAcessoEmail(env, email, link) {
  // O botao fica numa linha so (ver comentario equivalente no Painel do
  // Trader) -- alguns filtros de seguranca/rastreamento de clique quebram
  // tags de <a> com atributos em varias linhas.
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f14;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#141c26;border:1px solid #223041;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td style="width:10px;height:10px;background:#4da3ff;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                <td style="padding-left:10px;color:#8fa1b3;font-size:13px;letter-spacing:0.04em;font-family:'SFMono-Regular',Menlo,Consolas,monospace;">MORNING DO TRADER</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 0;">
              <h1 style="margin:0 0 12px;color:#e8edf2;font-size:22px;line-height:1.3;">Seu acesso às Ferramentas do Trader</h1>
              <p style="margin:0 0 28px;color:#8fa1b3;font-size:14.5px;line-height:1.6;">Clique no botão abaixo pra entrar. O link expira em 15 minutos e só funciona uma vez.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <a href="${link}" style="display:inline-block;background:#4da3ff;color:#08131f;padding:14px 26px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;">Entrar nas ferramentas</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <p style="margin:0 0 6px;color:#5b6b7a;font-size:12.5px;">Se o botão não funcionar, copie e cole este link no navegador:</p>
              <p style="margin:0;word-break:break-all;color:#4da3ff;font-size:12.5px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;">${link}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #1a2531;">
              <p style="margin:0;color:#5b6b7a;font-size:12.5px;line-height:1.6;">Você recebeu este e-mail porque pediu acesso em morningdotrader.com.br. Se não foi você, pode ignorar com segurança.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: "Seu acesso às Ferramentas do Trader",
      html,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("Falha ao enviar e-mail via Resend: " + errText);
  }
}

// Le o token de sessao do header "x-sessao" (ou, em fallback, do querystring
// ?sessao=) e devolve o e-mail autenticado, ou null se nao houver sessao
// valida. Usado por qualquer rota que precise saber quem esta logado
// (guardar/ler o Plano de Trade, por exemplo).
async function emailAutenticado(request, env, url) {
  const token = request.headers.get("x-sessao") || url.searchParams.get("sessao");
  if (!token) return null;
  const email = await env.LEADS_KV.get(`sessao:${token}`);
  return email || null;
}

// ============================================================================
// FEDWATCH - busca e parse
// ============================================================================
//
// A pagina do Investing.com renderiza os dados direto no HTML (sem depender
// de JavaScript rodando no navegador, diferente da pagina oficial do CME
// FedWatch, que so' preenche via um widget de terceiros). Isso permite buscar
// com fetch simples + regex, no mesmo estilo ja usado pelo RSS/Telegram
// abaixo nesse Worker.
//
// Estrutura assumida (baseada na renderizacao visivel da pagina, nao no
// HTML bruto - ajustar os regex abaixo se o parse vier vazio):
// - Cada reuniao tem um bloco "Meeting Time: <data> ET"
// - Logo depois, uma tabela com colunas: Target Rate | Current Probability% | ...
// - So' nos interessa a 1a e a 2a coluna (faixa + probabilidade atual)
async function buscarFedWatch() {
  const resp = await fetch(FEDWATCH_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "text/html",
    },
  });

  if (!resp.ok) {
    throw new Error(`Investing.com respondeu ${resp.status}`);
  }

  const html = await resp.text();
  return parseFedWatchHtml(html);
}

function parseFedWatchHtml(html) {
  const reunioes = [];

  // Estrutura real confirmada (via rota de debug):
  // <span>Meeting Time:</span>
  // <i>Sep 16, 2026 02:00PM ET</i>
  const dataRegex = /<span>Meeting Time:<\/span>\s*<i>([^<]+)<\/i>/g;

  const pontosDeInicio = [];
  let m;
  while ((m = dataRegex.exec(html)) !== null) {
    pontosDeInicio.push({ index: m.index, data: m[1].trim() });
  }

  for (let i = 0; i < pontosDeInicio.length; i++) {
    const inicio = pontosDeInicio[i].index;
    const fim = i + 1 < pontosDeInicio.length ? pontosDeInicio[i + 1].index : inicio + 8000;
    const bloco = html.slice(inicio, fim);

    // Estrutura real da linha (confirmada com HTML real salvo pelo usuario
    // em 18/set/2026, nao mais so' por deducao):
    //   <tr>
    //     <td class="left">3.50 - 3.75 <span class="chartIcon" ...></span></td>
    //     <td>&mdash;</td>   (Current Probability - NAO usamos, ver nota abaixo)
    //     <td>&mdash;</td>   (Previous Day Probability - a que usamos)
    //     <td>7.4%</td>      (semana anterior - nao usamos)
    //   </tr>
    //
    // BUG CORRIGIDO #1 (18/set/2026, 1a tentativa - INCOMPLETA): quando uma
    // faixa tem probabilidade desprezivel, o Investing.com mostra um
    // travessao no lugar do numero. A regex antiga exigia "<td>numero%</td>"
    // logo em seguida; quando essa celula tinha o travessao, o regex nao
    // conseguia casar ali e o motor de regex fazia backtracking, pulando pra
    // frente ate achar a PROXIMA celula com numero — a coluna ou ate' a LINHA
    // errada (o valor de uma faixa vazava pra dentro do rotulo da faixa
    // seguinte). A 1a correcao tentou aceitar "—" (travessao unicode) como
    // alternativa, mas o HTML real usa a ENTIDADE HTML "&mdash;", nao o
    // caractere unicode "—" — entao a 1a correcao nao resolvia nada,
    // confirmado testando contra o HTML real salvo pelo usuario.
    //
    // CORRECAO DEFINITIVA (18/set/2026): em vez de tentar prever todo tipo de
    // "nao-numero" que a celula pode conter, a regex agora captura a linha
    // <tr>...</tr> INTEIRA de uma vez (nao deixa mais o regex "vazar" pra
    // fora da linha ao fazer backtracking), pega as 3 celulas de numero como
    // texto bruto (funciona com "&mdash;", "-", vazio ou qualquer coisa), e
    // so' depois interpreta cada uma (tem numero% -> usa o numero; nao tem ->
    // 0%, probabilidade desprezivel/arredondada).
    //
    // BUG CORRIGIDO #2 (18/set/2026): a coluna "Current Probability%" do
    // Investing.com fica com o rotulo desalinhado - o valor que ela mostra
    // como "atual" na verdade esta atrasado, e o que ela rotula como
    // "Previous Day Probability%" e' o que reflete o valor mais recente de
    // fato. Confirmado comparando o mesmo instante (conversao de fuso):
    // print da CME "18 set 2026 11:31:53 CT" = 16:31 UTC mostrando
    // 42.4%/57.6%; print do Investing "Updated: Sep 18 2026 01:35PM BRT" =
    // 16:35 UTC (4 min de diferenca, praticamente o mesmo momento) mostrando
    // Current=40.3%/59.7% (2% de diferenca da CME) e Previous Day=42.6%/
    // 57.4% (bate com a CME, dentro do ruido normal). Por isso usamos a 2a
    // celula de numero de cada linha (Previous Day) em vez da 1a (Current).
    const linhaRegex = /<tr>\s*<td class="left">\s*([\d.]+\s*-\s*[\d.]+)[\s\S]*?<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<\/tr>/g;

    // Extrai o numero de uma celula bruta ("40.3%" -> 40.3); qualquer coisa
    // sem digito (ex: entidade "&mdash;", "-", vazio) vira 0.
    function extrairProbabilidade(celulaBruta) {
      const m = (celulaBruta || "").match(/([\d.]+)%/);
      return m ? parseFloat(m[1]) : 0;
    }

    const faixas = [];
    let lm;
    while ((lm = linhaRegex.exec(bloco)) !== null) {
      faixas.push({
        faixa: lm[1].replace(/\s+/g, ""),
        probabilidade: extrairProbabilidade(lm[3]), // lm[3] = Previous Day Probability%
      });
    }

    if (faixas.length > 0) {
      reunioes.push({
        data: pontosDeInicio[i].data,
        faixas,
      });
    }

    // So' precisamos das 4 reunioes mais proximas.
    if (reunioes.length >= 4) break;
  }

  return reunioes;
}

// Reduz uma data de reuniao (em qualquer um dos dois formatos usados aqui --
// "Sep 16, 2026 02:00PM ET" do scraper, ou "16 Sep 2026" digitado a mao) a
// uma chave "ano-mes-dia" comparavel, pra dar pra casar uma reuniao colada
// manualmente com a reuniao correspondente que ja existe no KV (sem depender
// de Date.parse, que quebra com o sufixo de fuso horario "ET").
const MESES_FEDWATCH = {
  jan: 0, fev: 1, feb: 1, mar: 2, abr: 3, apr: 3, mai: 4, may: 4, jun: 5,
  jul: 6, ago: 7, aug: 7, set: 8, sep: 8, out: 9, oct: 9, nov: 10, dez: 11, dec: 11,
};

function chaveDataFedwatch(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^([A-Za-zçÇ]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/); // "Sep 16, 2026 ..."
  let dia, mesTxt, ano;
  if (m) {
    mesTxt = m[1].toLowerCase().slice(0, 3);
    dia = parseInt(m[2], 10);
    ano = parseInt(m[3], 10);
  } else {
    m = s.match(/^(\d{1,2})\s+([A-Za-zçÇ]{3,9})\.?\s+(\d{4})/); // "16 Sep 2026"
    if (!m) return null;
    dia = parseInt(m[1], 10);
    mesTxt = m[2].toLowerCase().slice(0, 3);
    ano = parseInt(m[3], 10);
  }
  const mesIdx = MESES_FEDWATCH[mesTxt];
  if (mesIdx === undefined || !dia || !ano) return null;
  return ano + "-" + mesIdx + "-" + dia;
}

async function atualizarFedWatch(env) {
  try {
    // Se tiver um override manual travado (ex: logo apos uma divulgacao do
    // Fed, com o Investing.com desatualizado), respeita a trava e nao deixa
    // nem o Cron nem o refresh manual sobrescreverem o dado correto com um
    // scrape ainda velho. Passado o prazo da trava, volta ao normal sozinho.
    const atual = (await env.MANUAL_DATA.get("fedwatch", "json")) || {};
    if (atual.travado_ate && new Date(atual.travado_ate) > new Date()) {
      console.log("FedWatch: dado manual travado ate " + atual.travado_ate + ", pulando atualizacao automatica.");
      return { ok: false, travado: true, reason: "dado manual travado ate " + atual.travado_ate, dado: atual };
    }

    const reunioes = await buscarFedWatch();

    if (!reunioes || reunioes.length === 0) {
      console.log("FedWatch: parse retornou 0 reunioes, mantendo dado anterior no KV.");
      return { ok: false, reason: "parse vazio - nada foi salvo, dado anterior mantido" };
    }

    const registro = {
      atualizado_em: new Date().toISOString(),
      reunioes,
    };

    await env.MANUAL_DATA.put("fedwatch", JSON.stringify(registro));

    console.log(`FedWatch atualizado: ${reunioes.length} reunioes salvas.`);
    return { ok: true, reunioes: reunioes.length, dado: registro };
  } catch (e) {
    console.log("FedWatch: erro ao buscar/atualizar:", String(e));
    return { ok: false, reason: String(e) };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Libera CORS pra qualquer origem (o site chama esse Worker de outro dominio)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-sessao, x-edit-key",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ---------- Painel manual (minerio de ferro + suporte/resistencia) ----------
    if (url.pathname === "/api/manual-data" && request.method === "GET") {
      const data = (await env.MANUAL_DATA.get("dados", "json")) || {};
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/manual-data" && request.method === "POST") {
      const chave = url.searchParams.get("chave");
      if (chave !== env.EDIT_KEY) {
        return new Response(JSON.stringify({ error: "chave invalida" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const body = await request.json();
      const data = { atualizado_em: new Date().toISOString(), briefing: body.briefing || "" };
      SR_FIELDS.forEach(campo => data[campo] = body[campo] || "");
      EXTRA_FIELDS.forEach(campo => data[campo] = body[campo] || "");
      await env.MANUAL_DATA.put("dados", JSON.stringify(data));
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Ormuz (crise do Estreito de Ormuz) ----------
    if (url.pathname === "/api/ormuz-data" && request.method === "GET") {
      const data = (await env.MANUAL_DATA.get("ormuz", "json")) || {};
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/ormuz-data" && request.method === "POST") {
      const chave = url.searchParams.get("chave");
      if (chave !== env.EDIT_KEY) {
        return new Response(JSON.stringify({ error: "chave invalida" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const body = await request.json();
      const data = { atualizado_em: new Date().toISOString(), ...body };
      await env.MANUAL_DATA.put("ormuz", JSON.stringify(data));
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Kit Gratuito do Trader (captura de leads) ----------
    // Recebe { email, whatsapp, brinde } de kit-do-trader.html (brinde =
    // "planilha-trader" ou "diario-trader"), guarda o lead (com WhatsApp) no
    // KV LEADS_KV e dispara o e-mail com o link de download via Resend. O
    // acesso ao material continua sendo só por e-mail — o WhatsApp é
    // guardado apenas como contato adicional, não é usado pra entrega.
    if (url.pathname === "/api/leads" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "corpo invalido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const email = (body.email || "").trim().toLowerCase();
      const whatsappDigits = String(body.whatsapp || "").replace(/\D/g, "");
      const brinde = body.brinde;

      if (!emailValido(email)) {
        return new Response(JSON.stringify({ error: "e-mail invalido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (whatsappDigits.length < 10 || whatsappDigits.length > 13) {
        return new Response(JSON.stringify({ error: "whatsapp invalido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!BRINDES[brinde]) {
        return new Response(JSON.stringify({ error: "brinde invalido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Guarda o lead primeiro. Se o KV falhar (ex: binding esquecido), ainda
      // tentamos mandar o e-mail — melhor a pessoa receber o arquivo do que
      // travar tudo por causa do registro do lead.
      try {
        await env.LEADS_KV.put(
          `${brinde}:${email}`,
          JSON.stringify({ email, whatsapp: whatsappDigits, brinde, capturado_em: new Date().toISOString() })
        );
      } catch (e) {
        console.log("Leads: erro ao salvar no KV:", String(e));
      }

      try {
        await enviarBrindeEmail(env, email, brinde);
      } catch (e) {
        console.log("Leads: erro ao enviar e-mail:", String(e));
        return new Response(JSON.stringify({ error: "falha ao enviar e-mail" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Ferramentas do Trader (login por link magico) ----------
    //
    // Recebe { email, whatsapp? }. Se o e-mail ainda nao tem cadastro,
    // "whatsapp" e obrigatorio (primeiro acesso = cadastro + login juntos).
    // Se ja tem cadastro, whatsapp e ignorado (so precisa do e-mail pra
    // mandar um novo link). Sempre responde a mesma mensagem generica,
    // enviando o e-mail so quando faz sentido -- evita expor se um e-mail
    // ja esta cadastrado ou nao.
    if (url.pathname === "/api/acesso-solicitar" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "corpo invalido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const email = (body.email || "").trim().toLowerCase();
      const whatsappDigits = String(body.whatsapp || "").replace(/\D/g, "");

      if (!emailValido(email)) {
        return new Response(JSON.stringify({ error: "e-mail invalido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const cadastro = await env.LEADS_KV.get(`cadastro:${email}`, "json");

      if (!cadastro) {
        if (!whatsappValido(whatsappDigits)) {
          // Front-end interpreta esse codigo pra mostrar o campo de WhatsApp
          // (primeiro acesso desse e-mail).
          return new Response(JSON.stringify({ error: "cadastro_necessario" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        await env.LEADS_KV.put(
          `cadastro:${email}`,
          JSON.stringify({ email, whatsapp: whatsappDigits, criado_em: new Date().toISOString() })
        );
      }

      const token = randomToken();
      await env.LEADS_KV.put(`magic:${token}`, email, { expirationTtl: 900 });

      const redirect = typeof body.redirect === "string" ? body.redirect : "ferramentas-do-trader.html";
      const link = `${WORKER_URL}/api/acesso-confirmar?token=${token}&redirect=${encodeURIComponent(redirect)}`;

      try {
        await enviarAcessoEmail(env, email, link);
      } catch (e) {
        console.log("Acesso: erro ao enviar e-mail:", String(e));
        return new Response(JSON.stringify({ error: "falha ao enviar e-mail" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Confirma o token do link magico (clicado no e-mail) e cria a sessao.
    // Como essa API roda em workers.dev (fora do dominio morningdotrader.com.br),
    // nao da pra usar cookie cross-domain -- a sessao vai como querystring
    // "?sessao=TOKEN" no redirect final, e o front-end guarda no localStorage.
    if (url.pathname === "/api/acesso-confirmar" && request.method === "GET") {
      const token = url.searchParams.get("token");
      const redirect = url.searchParams.get("redirect") || "ferramentas-do-trader.html";

      if (!token) {
        return new Response("Link invalido.", { status: 400, headers: corsHeaders });
      }

      const email = await env.LEADS_KV.get(`magic:${token}`);
      if (!email) {
        return new Response("Link expirado ou ja usado. Peca um novo acesso.", { status: 400, headers: corsHeaders });
      }
      await env.LEADS_KV.delete(`magic:${token}`);

      const sessionToken = randomToken(32);
      await env.LEADS_KV.put(`sessao:${sessionToken}`, email, { expirationTtl: 60 * 60 * 24 * 30 });

      const destino = `${SITE_URL}/${redirect}${redirect.includes("?") ? "&" : "?"}sessao=${sessionToken}`;
      return new Response(null, { status: 302, headers: { "Location": destino, ...corsHeaders } });
    }

    // Consulta se a sessao (header x-sessao ou ?sessao=) ainda e valida.
    if (url.pathname === "/api/acesso-status" && request.method === "GET") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      return new Response(JSON.stringify({ authenticated: true, email }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Encerra a sessao (apaga o token do KV -- o front-end tambem limpa o localStorage).
    if (url.pathname === "/api/acesso-sair" && request.method === "POST") {
      const token = request.headers.get("x-sessao") || url.searchParams.get("sessao");
      if (token) await env.LEADS_KV.delete(`sessao:${token}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Plano de Trade (dados salvos por usuario logado) ----------
    // "Meu Plano" (fixo) + "historico" (um registro por dia: ativo do dia,
    // cenario, emocional manha/noite, confirmacao diaria, anotacoes). Guarda
    // tudo num unico registro por e-mail pra simplificar; o historico fica
    // limitado aos ultimos 60 dias pra nao crescer sem limite.
    if (url.pathname === "/api/plano-trade" && request.method === "GET") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const dados = (await env.LEADS_KV.get(`plano:${email}`, "json")) || { meuPlano: {}, historico: {} };
      return new Response(JSON.stringify(dados), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/plano-trade" && request.method === "POST") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "corpo invalido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const atual = (await env.LEADS_KV.get(`plano:${email}`, "json")) || { meuPlano: {}, historico: {} };

      if (body.meuPlano && typeof body.meuPlano === "object") {
        atual.meuPlano = body.meuPlano;
      }

      if (body.hoje && typeof body.hoje === "object") {
        const dataChave = /^\d{4}-\d{2}-\d{2}$/.test(body.data) ? body.data : new Date().toISOString().slice(0, 10);
        atual.historico[dataChave] = { ...(atual.historico[dataChave] || {}), ...body.hoje };

        // Mantem so os ultimos 60 dias, pra o registro nao crescer sem limite.
        const chaves = Object.keys(atual.historico).sort();
        if (chaves.length > 60) {
          chaves.slice(0, chaves.length - 60).forEach((k) => delete atual.historico[k]);
        }
      }

      atual.atualizado_em = new Date().toISOString();
      await env.LEADS_KV.put(`plano:${email}`, JSON.stringify(atual));

      return new Response(JSON.stringify(atual), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- FedWatch (probabilidades Fed Funds, via Investing.com) ----------

    // Rota publica: o site le daqui pra montar os cards.
    if (url.pathname === "/api/fedwatch-data" && request.method === "GET") {
      const data = (await env.MANUAL_DATA.get("fedwatch", "json")) || { reunioes: [] };
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Rota pra forcar uma busca AGORA (nao espera o Cron), util pra testar o
    // parser e pra atualizar manualmente antes da hora.
    if (url.pathname === "/api/fedwatch-refresh" && request.method === "GET") {
      const chave = url.searchParams.get("chave");
      if (chave !== env.EDIT_KEY) {
        return new Response(JSON.stringify({ error: "chave invalida" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const resultado = await atualizarFedWatch(env);
      return new Response(JSON.stringify(resultado), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Override manual, pra casos extremos (ex: Fed acabou de anunciar e o
    // Investing.com ainda nao atualizou). Duas acoes possiveis no corpo:
    // - { reunioes: [...], horas_trava } -> salva o dado manual e trava o
    //   Cron/refresh automatico por "horas_trava" horas (padrao 3h), prazo
    //   depois do qual eles voltam a rodar sozinhos sem precisar mexer em nada.
    // - { destravar: true } -> volta ao automatico na hora, sem esperar o prazo.
    if (url.pathname === "/api/fedwatch-manual" && request.method === "POST") {
      const chave = url.searchParams.get("chave");
      if (chave !== env.EDIT_KEY) {
        return new Response(JSON.stringify({ error: "chave invalida" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "corpo invalido" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (body.destravar) {
        const atual = (await env.MANUAL_DATA.get("fedwatch", "json")) || { reunioes: [] };
        delete atual.manual;
        delete atual.travado_ate;
        await env.MANUAL_DATA.put("fedwatch", JSON.stringify(atual));
        return new Response(JSON.stringify({ ok: true, destravado: true, dado: atual }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const reunioesColadas = Array.isArray(body.reunioes) ? body.reunioes : [];
      if (!reunioesColadas.length) {
        return new Response(JSON.stringify({ error: "reunioes vazio" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Faz merge com o que ja esta salvo em vez de substituir tudo: cola so
      // a reuniao que mudou (ex: a mais proxima, logo apos o Fed anunciar) e
      // as outras que ja estavam la continuam aparecendo normalmente. Casa
      // pela data (dia/mes/ano); se nao achar correspondencia, adiciona como
      // reuniao nova.
      const atual = (await env.MANUAL_DATA.get("fedwatch", "json")) || { reunioes: [] };
      const reunioesFinais = Array.isArray(atual.reunioes) ? atual.reunioes.slice() : [];

      reunioesColadas.forEach((rColada) => {
        const chaveColada = chaveDataFedwatch(rColada.data);
        const idxExistente = chaveColada
          ? reunioesFinais.findIndex((r) => chaveDataFedwatch(r.data) === chaveColada)
          : -1;
        if (idxExistente >= 0) {
          // mantem o texto da data original (ja formatado do jeito que o site espera)
          // e so troca as probabilidades.
          reunioesFinais[idxExistente] = { data: reunioesFinais[idxExistente].data, faixas: rColada.faixas };
        } else {
          reunioesFinais.push(rColada);
        }
      });

      // Reordena cronologicamente quando da pra interpretar a data das duas.
      reunioesFinais.sort((a, b) => {
        const ka = chaveDataFedwatch(a.data);
        const kb = chaveDataFedwatch(b.data);
        if (!ka || !kb) return 0;
        const [ay, am, ad] = ka.split("-").map(Number);
        const [by, bm, bd] = kb.split("-").map(Number);
        return new Date(ay, am, ad) - new Date(by, bm, bd);
      });

      const horas = Number(body.horas_trava) > 0 ? Number(body.horas_trava) : 3;
      const travado_ate = new Date(Date.now() + horas * 3600 * 1000).toISOString();
      const registro = {
        atualizado_em: new Date().toISOString(),
        reunioes: reunioesFinais,
        manual: true,
        travado_ate,
      };
      await env.MANUAL_DATA.put("fedwatch", JSON.stringify(registro));
      return new Response(JSON.stringify({ ok: true, travado_ate, dado: registro }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Fear & Greed Index (dado real da CNN) ----------
    if (url.pathname === "/api/fear-greed") {
      try {
        const resp = await fetch(
          "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
          { headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              "Referer": "https://edition.cnn.com/markets/fear-and-greed",
              "Accept": "application/json"
            } }
        );
        const raw = await resp.json();
        const latest = raw.fear_and_greed;
        return new Response(
          JSON.stringify({ score: latest.score, rating: latest.rating }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: "fetch failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // ---------- Polymarket (proxy da Gamma API) ----------
    // O navegador do visitante pode estar no Brasil, onde a Polymarket e' bloqueada
    // (Anatel + a propria Polymarket bloqueiam por IP de origem). Esse Worker roda
    // na rede da Cloudflare, fora desse bloqueio, entao busca os dados aqui e so'
    // repassa o JSON pronto pro site.
    if (url.pathname === "/api/polymarket") {
      const slug = url.searchParams.get("slug");
      if (!slug) {
        return new Response(JSON.stringify({ error: "slug obrigatorio" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      try {
        const resp = await fetch(
          "https://gamma-api.polymarket.com/events?slug=" + encodeURIComponent(slug),
          { headers: { "Accept": "application/json" } }
        );
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60", ...corsHeaders },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "fetch failed", detail: String(e) }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // ---------- Noticias via RSS (Investing.com) ----------
    async function buscarRSS(rssUrl, limite = 8) {
      const resp = await fetch(rssUrl);
      const xml = await resp.text();
      const items = [];
      const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
      for (const m of matches) {
        const block = m[1];
        const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
        const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
        const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
        const imagem = (block.match(/<enclosure[^>]*url="([^"]*)"/) || [])[1] || "";
        items.push({
          title: title.replace("<![CDATA[", "").replace("]]>", "").trim(),
          link: link.trim(),
          pubDate: pubDate.trim(),
          imagem: imagem.trim(),
        });
        if (items.length >= limite) break;
      }
      return items;
    }

    // Busca em varias fontes RSS e filtra so' os itens cujo titulo bate com as
    // palavras-chave (usado pelo feed de noticias do Ormuz/Ira, pra nao misturar
    // com noticias soltas de outras commodities que vem no mesmo feed).
    async function buscarRSSFiltrado(rssUrls, palavrasChave, limite = 8) {
      const vistos = new Set();
      const filtrados = [];
      for (const rssUrl of rssUrls) {
        const todos = await buscarRSS(rssUrl, 60); // sem limite curto aqui, filtra depois
        for (const item of todos) {
          const tituloLower = item.title.toLowerCase();
          const bate = palavrasChave.some(p => tituloLower.includes(p));
          if (bate && !vistos.has(item.link)) {
            vistos.add(item.link);
            filtrados.push(item);
          }
        }
      }
      return filtrados.slice(0, limite);
    }

    if (url.pathname === "/api/news-market") {
      const items = await buscarRSS("https://br.investing.com/rss/news.rss");
      return new Response(JSON.stringify(items), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/news-corp") {
      const items = await buscarRSS("https://br.investing.com/rss/news_356.rss");
      return new Response(JSON.stringify(items), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Junta as 3 fontes de RSS que ja usamos (Geral, Corporativa, Commodities),
    // marca cada item com a categoria de origem e devolve tudo junto, ordenado
    // por data - usado pela pagina "noticias.html" (grade de cards com foto).
    if (url.pathname === "/api/news-all") {
      const fontes = [
        { url: "https://br.investing.com/rss/news.rss", categoria: "Mercado" },
        { url: "https://br.investing.com/rss/news_356.rss", categoria: "Empresas" },
        { url: "https://br.investing.com/rss/news_11.rss", categoria: "Commodities" },
        { url: "https://br.investing.com/rss/news_14.rss", categoria: "Economia" },
      ];
      const vistos = new Set();
      let todos = [];
      for (const fonte of fontes) {
        const items = await buscarRSS(fonte.url, 12);
        for (const item of items) {
          if (vistos.has(item.link)) continue;
          vistos.add(item.link);
          todos.push({ ...item, categoria: fonte.categoria });
        }
      }
      todos.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
      return new Response(JSON.stringify(todos.slice(0, 32)), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/news-ormuz") {
      const palavrasChave = [
        "ormuz", "hormuz", "irã", "iran", "teerã", "teheran",
        "golfo pérsico", "golfo de omã", "khamenei", "irgc",
        "guarda revolucionária", "guarda revolucionaria"
      ];
      const items = await buscarRSSFiltrado(
        ["https://br.investing.com/rss/news_11.rss", "https://br.investing.com/rss/news.rss"],
        palavrasChave,
        8
      );
      return new Response(JSON.stringify(items), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Telegram (canal publico, via preview t.me/s/) ----------
    // Rota publica: o site le daqui (nao busca mais o Telegram ao vivo,
    // porque a Cloudflare tem os IPs bloqueados pelo Telegram). Quem
    // alimenta esse dado agora e o script userbot (Telethon) rodando na
    // Square Cloud, via POST em /api/telegram-news-update.
    if (url.pathname === "/api/telegram-news" && request.method === "GET") {
      const lista = (await env.MANUAL_DATA.get("telegram_news", "json")) || [];
      return new Response(JSON.stringify(lista), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Rota protegida: o userbot chama essa rota a cada mensagem nova do
    // canal do Telegram. Mantem so as ultimas 10, mais recente primeiro.
    // TTL de 5h: se o userbot ficar fora do ar, a lista some sozinha em
    // vez de mostrar noticia velha pra sempre.
    if (url.pathname === "/api/telegram-news-update" && request.method === "POST") {
      const chave = request.headers.get("x-edit-key");
      if (chave !== env.EDIT_KEY) {
        return new Response(JSON.stringify({ error: "chave invalida" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      try {
        const body = await request.json();

        // Modo "lista" (usado so no backfill inicial do userbot): grava tudo
        // de uma vez, numa unica escrita, pra evitar a corrida de escritas
        // simultaneas no KV (cada uma lendo o estado ainda desatualizado e
        // se sobrescrevendo).
        if (Array.isArray(body.mensagens)) {
          const lista = body.mensagens
            .map((m) => {
              const item = {
                hora: String(m.hora || "").trim(),
                texto: String(m.texto || "").trim().slice(0, 900),
              };
              if (m.completo) item.completo = String(m.completo).trim().slice(0, 4000);
              return item;
            })
            .filter((m) => m.texto)
            .slice(0, 10);
          await env.MANUAL_DATA.put("telegram_news", JSON.stringify(lista), {
            expirationTtl: 18000, // 5 horas
          });
          return new Response(JSON.stringify({ ok: true, total: lista.length }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // Modo "mensagem unica" (usado pro fluxo ao vivo, uma mensagem nova
        // por vez -- espacadas no tempo, sem risco de corrida): le a lista
        // atual, coloca a nova na frente, grava de volta.
        const texto = String(body.texto || "").trim().slice(0, 900);
        const hora = String(body.hora || "").trim();
        if (!texto) {
          return new Response(JSON.stringify({ error: "texto vazio" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        const novoItem = { hora, texto };
        if (body.completo) novoItem.completo = String(body.completo).trim().slice(0, 4000);
        const atual = (await env.MANUAL_DATA.get("telegram_news", "json")) || [];
        const nova = [novoItem, ...atual].slice(0, 10);
        await env.MANUAL_DATA.put("telegram_news", JSON.stringify(nova), {
          expirationTtl: 18000, // 5 horas
        });
        return new Response(JSON.stringify({ ok: true, total: nova.length }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "falha ao gravar", detalhe: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  // Roda automaticamente conforme o Cron Trigger configurado no painel do
  // Cloudflare (Settings > Triggers > Cron Triggers).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(atualizarFedWatch(env));
  },
};
