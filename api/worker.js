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
  // NOTA: os campos "trade_hunter_*" (relatorio_data, win, wdo, placar_titulo,
  // placar_lead, placar_cards, destaques) DE PROPOSITO nao estao nessa lista.
  // Eles sao escritos so' pela rotina automatica (atualizarTradeHunter, em
  // worker.js), nunca pelo formulario manual do painel - se entrassem aqui,
  // toda vez que voce salvasse QUALQUER campo manual (briefing, suporte/
  // resistencia etc.) o POST de /api/manual-data ia apagar esses campos de
  // volta pra vazio, ja' que o formulario nao tem input pra eles. (bug real
  // que existia antes - corrigido junto com essa mudanca, ver POST abaixo.)
];

const FEDWATCH_URL = "https://www.investing.com/central-banks/fed-rate-monitor";

// URL base do relatorio de fluxo do Trade Hunter. A data entra no final,
// formato DD-MM-YYYY (ex: .../relatorio-de-fluxo-22-09-2026).
const TRADE_HUNTER_URL_BASE = "https://tradehunter.com.br/relatorios/relatorio-de-fluxo-";

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
// DIARIO SEMANAL - banco D1 (DIARIO_DB), coaching com IA (Anthropic)
//
// CONFIGURAR ANTES DE PUBLICAR:
// 1. Associe este Worker ao banco D1 "diario-trader-db" com o binding name
//    "DIARIO_DB" (Settings > Variables > D1 Database Bindings).
// 2. Crie a secret ANTHROPIC_API_KEY (console.anthropic.com, com billing
//    ativado) em Settings > Variables > Secrets.
// 3. Opcional: crie a variavel ANTHROPIC_MODEL se quiser trocar o modelo
//    sem reimplantar o worker. Sem ela, usa "claude-sonnet-5" por padrao.
// ============================================================================

function hojeBrasil() {
  // Data de "hoje" no fuso de Brasilia, formato YYYY-MM-DD.
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const obj = {};
  partes.forEach(p => { obj[p.type] = p.value; });
  return `${obj.year}-${obj.month}-${obj.day}`;
}

function dataValida(data) {
  return typeof data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data);
}

// Chama a API da Anthropic (Claude) com um system prompt e uma lista de
// mensagens no formato [{role:"user"|"assistant", content:"..."}].
async function chamarClaude(env, systemPrompt, mensagens) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY nao configurada neste Worker.");
  }
  const modelo = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelo,
      max_tokens: 1200,
      system: systemPrompt,
      messages: mensagens,
    }),
  });
  if (!resp.ok) {
    const erro = await resp.text().catch(() => "");
    throw new Error(`Anthropic API respondeu ${resp.status}: ${erro.slice(0, 300)}`);
  }
  const data = await resp.json();
  const bloco = (data.content || []).find(b => b.type === "text");
  return bloco ? bloco.text : "";
}

// Monta o contexto que a IA recebe antes de cada resposta: registro de hoje,
// ultimos trades e um resumo rapido da semana corrente. Mesma ideia da
// injecao de contexto do ConfyTrade (Angelina), simplificada pra v1.
async function montarContextoDiario(env, email) {
  const hoje = hojeBrasil();

  const registroHoje = await env.DIARIO_DB.prepare(
    "SELECT * FROM registros_diarios WHERE email = ? AND data = ?"
  ).bind(email, hoje).first();

  const ultimosTrades = await env.DIARIO_DB.prepare(
    "SELECT data, horario, ativo, direcao, resultado, motivo FROM trades WHERE email = ? ORDER BY data DESC, id DESC LIMIT 15"
  ).bind(email).all();

  const trades = ultimosTrades.results || [];
  const totalTrades = trades.length;
  const ganhos = trades.filter(t => Number(t.resultado) > 0).length;
  const resultadoAcumulado = trades.reduce((soma, t) => soma + (Number(t.resultado) || 0), 0);
  const winRate = totalTrades ? Math.round((ganhos / totalTrades) * 100) : null;

  let texto = `Data de hoje: ${hoje}.\n`;
  if (registroHoje) {
    texto += `Registro de hoje — tendência: ${registroHoje.tendencia || "não informado"}; `
      + `suportes/resistências: ${registroHoje.suportes_resistencias || "não informado"}; `
      + `observações: ${registroHoje.observacoes || "nenhuma"}.\n`;
  } else {
    texto += "Ainda não há registro do dia de hoje.\n";
  }
  if (totalTrades) {
    texto += `Últimos ${totalTrades} trades registrados: taxa de acerto ${winRate}%, resultado acumulado ${resultadoAcumulado.toFixed(2)} pontos/reais (conforme unidade usada nos registros).\n`;
    texto += "Detalhe dos últimos trades (mais recente primeiro): "
      + trades.slice(0, 8).map(t => `${t.data} ${t.horario || ""} ${t.ativo} ${t.direcao} resultado=${t.resultado}${t.motivo ? " motivo=" + t.motivo : ""}`).join(" | ")
      + ".\n";
  } else {
    texto += "Ainda não há trades registrados.\n";
  }
  return texto;
}

const SYSTEM_PROMPT_DIARIO = `Você é a assistente de coaching comportamental do Diário Semanal, dentro do Kit de Ferramentas do Morning do Trader. Conversa com um day trader brasileiro que opera mini índice (WIN) e mini dólar (WDO).

Seu papel: ajudar o trader a enxergar padrões no próprio comportamento e performance — não dar sinais de entrada/saída, não dar recomendação de investimento, e não substituir a gestão de risco que ele já definiu. Seja direta e objetiva; se notar sinais de tilt, euforia após ganhos ou paralisia após perdas nos dados abaixo, aponte isso claramente, sem rodeios. Fale em português do Brasil, em tom próximo mas sem bajulação.

Contexto atual do trader (dados reais do Diário dele, injetados automaticamente — nunca invente números que não estão aqui):
{{CONTEXTO}}`;

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

// ============================================================================
// Trade Hunter (saldo dos players em WIN/WDO) - relatorio de fluxo publicado
// todo dia util por volta das 15:00 em tradehunter.com.br. Buscamos o
// relatorio do ULTIMO pregao (ontem, ou o ultimo dia util antes disso) numa
// rotina as 7:50 BRT, antes da abertura do mercado - por isso a data usada
// na URL e' sempre "um dia util pra tras" a partir de hoje, nunca a de hoje.
// ============================================================================

// Horario de Brasilia = UTC-3 o ano inteiro (sem horario de verao desde
// 2019), entao da' pra calcular sem precisar de fuso horario de verdade:
// so' subtrair 3h do horario UTC atual.
function dataBrtDeAgora(baseDate) {
  const d = baseDate || new Date();
  return new Date(d.getTime() - 3 * 60 * 60 * 1000);
}

// Retorna o ultimo dia util ANTERIOR a hoje (pula sabado/domingo), como um
// Date "neutro" (meia-noite UTC, so' usado como calendario, nao como
// instante real).
function ultimoDiaUtilAnterior(baseDate) {
  const brt = dataBrtDeAgora(baseDate);
  const d = new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()));
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); // 0=domingo, 6=sabado
  return d;
}

function voltarUmDiaUtil(d) {
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d;
}

function formatarDataUrlTradeHunter(d) {
  const dia = String(d.getUTCDate()).padStart(2, "0");
  const mes = String(d.getUTCMonth() + 1).padStart(2, "0");
  const ano = d.getUTCFullYear();
  return `${dia}-${mes}-${ano}`;
}

// Estrutura real confirmada com o HTML salvo pelo proprio usuario (pagina
// nao minificada, 22/set/2026):
//   <div class="card"><h4>WIN V26 · mini-índice</h4>
//   <div class="th-tbl"><table class="tbl"><thead>...</thead><tbody>
//     <tr><td>Ideal</td><td class="num"><span class="pos">+27.160</span> ctr</td>
//         <td class="num">187.757</td>
//         <td class="num"><span class="pos">+R$ 1,29</span> mi</td></tr>
//     ...
//   </tbody></table></div>
//   <p class="muted">Preço 187.935 · máxima 188.305 · mínima 186.195</p></div>
// O mesmo bloco se repete pra WDO. O sinal negativo usado no site e' o
// travessao unicode "−" (U+2212), nao o hifen comum "-" - por isso
// normalizamos pra hifen comum ao salvar, ja' que o front-end (renderTradeHunter
// em index.html) decide a cor checando startsWith("-") no hifen comum.
// O nome do contrato (V26, Z26 etc.) muda a cada rolagem, entao o parser
// procura so' por "WIN"/"WDO" no <h4>, nunca o codigo do mes.
function parseTradeHunterHtml(html) {
  let dataRelatorio = "";
  const dataMatch = html.match(/<time[^>]*datetime="(\d{4})-(\d{2})-(\d{2})"/);
  if (dataMatch) {
    dataRelatorio = `${dataMatch[3]}/${dataMatch[2]}/${dataMatch[1]}`;
  }

  // IMPORTANTE (23/set/2026): a pagina real tem MAIS de uma tabela por
  // instrumento - alem da tabela "Dia" (posicao ao vivo, a que queremos),
  // mais abaixo na mesma pagina existe uma 2a secao "WIN V26 - saldo
  // acumulado x preco" (varios pregoes). A 1a versao deste parser delimitava
  // o fim do bloco pelo paragrafo '<p class="muted"' logo apos a tabela; no
  // fetch ao vivo (fora do HTML salvo pelo usuario) esse paragrafo nao bateu
  // no lugar esperado (classe com atributos/ordem um pouco diferente) e o
  // parser caiu no fallback de 8000 caracteres, que acabou incluindo tambem
  // a tabela do OUTRO instrumento logo em seguida (WIN veio com 16 linhas =
  // 8 do WIN + 8 do WDO coladas). CORRIGIDO: em vez de confiar num marcador
  // de texto depois da tabela, agora delimitamos pelo proprio elemento
  // <table>...</table> (a primeira tabela depois do <h4> do instrumento) -
  // nao tem como vazar pra tabela seguinte assim.
  function extrairTabela(rotulo) {
    const h4Regex = new RegExp("<h4[^>]*>\\s*" + rotulo + "\\b");
    const hm = h4Regex.exec(html);
    if (!hm) return [];

    const tabelaInicio = html.indexOf("<table", hm.index);
    if (tabelaInicio === -1) return [];
    const tabelaFim = html.indexOf("</table>", tabelaInicio);
    const bloco = html.slice(tabelaInicio, tabelaFim > -1 ? tabelaFim : tabelaInicio + 8000);

    const linhaRegex = /<tr>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>\s*<span[^>]*class="(pos|neg)"[^>]*>([^<]*)<\/span>\s*ctr\s*<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>\s*<span[^>]*class="(pos|neg)"[^>]*>([^<]*)<\/span>\s*(mi|mil)\s*<\/td>\s*<\/tr>/g;

    const linhas = [];
    let lm;
    while ((lm = linhaRegex.exec(bloco)) !== null) {
      linhas.push({
        player: lm[1].trim(),
        saldo: lm[3].trim().replace(/−/g, "-"),
        preco_medio: lm[4].trim(),
        resultado_aberto: lm[6].trim().replace(/−/g, "-") + " " + lm[7],
      });
    }
    return linhas;
  }

  // "Placar do fluxo" - o resumo do topo do relatorio (Ibovespa, WIN, WDO,
  // maior comprador/vendedor etc. em ate 8 cartoes). O titulo e' dinamico
  // (muda o horario/status - "15:00, pregao em curso", depois vira algo tipo
  // "fechamento" - por isso capturamos o texto do <h2> inteiro em vez de
  // fixar um horario).
  function extrairPlacar() {
    const tituloMatch = html.match(/<h2[^>]*>(Placar do fluxo[^<]*)<\/h2>/);
    const titulo = tituloMatch ? tituloMatch[1].trim() : "";

    const leadMatch = html.match(/<p class="lead">([\s\S]*?)<\/p>/);
    const lead = leadMatch ? leadMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    const cards = [];
    const dashInicio = html.indexOf('<div class="dash"');
    if (dashInicio > -1) {
      // Delimita pelo <div class="chart" que sempre vem logo depois dos
      // cartoes (mesma ideia da tabela do WIN/WDO: preferir um limite
      // estrutural solido a um marcador de texto fragil).
      const dashFim = html.indexOf('<div class="chart"', dashInicio);
      const bloco = html.slice(dashInicio, dashFim > -1 ? dashFim : dashInicio + 6000);
      const cardRegex = /<div class="dash-card"[^>]*>\s*<div class="label"[^>]*>([\s\S]*?)<\/div>\s*<div class="value"[^>]*>([\s\S]*?)<\/div>\s*<div class="sub"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
      let cm;
      while ((cm = cardRegex.exec(bloco)) !== null) {
        cards.push({
          label: cm[1].trim(),
          value_html: cm[2].trim().replace(/−/g, "-"),
          sub_html: cm[3].trim().replace(/−/g, "-"),
        });
      }
    }

    return { titulo, lead, cards };
  }

  // "Destaques e sintese" - os 4 blocos de analise no fim do relatorio.
  // IMPORTANTE: existe pelo menos mais 1 callout parecido em outro lugar da
  // pagina (ex: um aviso de "Lacuna declarada" no meio do relatorio), entao
  // NAO da pra so' procurar '<div class="callout ...">' na pagina inteira -
  // isso pegava callouts de fora da secao (testado: vinham 5-6 em vez dos 4
  // certos). Por isso delimitamos pelo <h2>Destaques e sintese</h2> ate' o
  // </main> que fecha o conteudo, e so' contamos callouts dentro desse trecho.
  function extrairDestaques() {
    const h2Idx = html.search(/<h2[^>]*>Destaques e síntese<\/h2>/);
    if (h2Idx === -1) return [];
    const fimIdx = html.indexOf("</main>", h2Idx);
    const bloco = html.slice(h2Idx, fimIdx > -1 ? fimIdx : h2Idx + 6000);

    const calloutRegex = /<div class="callout (info|down|up|warn)"[^>]*>([\s\S]*?)<\/div>/g;
    const destaques = [];
    let dm;
    while ((dm = calloutRegex.exec(bloco)) !== null) {
      destaques.push({ tipo: dm[1], html: dm[2].trim().replace(/−/g, "-") });
    }
    return destaques;
  }

  const placar = extrairPlacar();

  return {
    dataRelatorio,
    win: extrairTabela("WIN"),
    wdo: extrairTabela("WDO"),
    placarTitulo: placar.titulo,
    placarLead: placar.lead,
    placarCards: placar.cards,
    destaques: extrairDestaques(),
  };
}

// Tenta o ultimo dia util anterior; se nao vier nada (feriado sem relatorio,
// site fora do ar), recua mais alguns dias uteis antes de desistir.
async function buscarTradeHunter() {
  const tentativas = [];
  const d = ultimoDiaUtilAnterior();

  for (let i = 0; i < 6; i++) {
    const dataUrl = formatarDataUrlTradeHunter(d);
    tentativas.push(dataUrl);
    const url = TRADE_HUNTER_URL_BASE + dataUrl;

    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/html",
        },
      });

      if (resp.ok) {
        const html = await resp.text();
        const parsed = parseTradeHunterHtml(html);
        if (parsed.win.length > 0 && parsed.wdo.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      // ignora e tenta o dia util anterior
    }

    voltarUmDiaUtil(d);
  }

  throw new Error("Nenhum relatorio encontrado (tentativas: " + tentativas.join(", ") + ")");
}

async function atualizarTradeHunter(env) {
  try {
    const parsed = await buscarTradeHunter();

    if (!parsed || parsed.win.length === 0 || parsed.wdo.length === 0) {
      console.log("Trade Hunter: parse retornou tabela vazia, mantendo dado anterior no KV.");
      return { ok: false, reason: "parse vazio - nada foi salvo, dado anterior mantido" };
    }

    // "dados" e' o registro compartilhado do painel manual (SR_FIELDS +
    // EXTRA_FIELDS). Lemos o que ja esta' salvo e so' sobrescrevemos os
    // campos do Trade Hunter, senao apagariamos briefing/fluxo/etc (por
    // isso tambem esses campos ficam DE FORA de EXTRA_FIELDS - ver
    // comentario ali). Tambem NAO mexemos em "atualizado_em" (esse campo
    // reflete a ultima edicao MANUAL do painel, usado pelos rotulos
    // "Atualizado em..." de suporte/resistencia, briefing e fluxo - uma
    // atualizacao automatica do Trade Hunter nao deve mudar esse rotulo).
    const atual = (await env.MANUAL_DATA.get("dados", "json")) || {};
    atual.trade_hunter_relatorio_data = parsed.dataRelatorio;
    atual.trade_hunter_win = parsed.win;
    atual.trade_hunter_wdo = parsed.wdo;
    atual.trade_hunter_placar_titulo = parsed.placarTitulo;
    atual.trade_hunter_placar_lead = parsed.placarLead;
    atual.trade_hunter_placar_cards = parsed.placarCards;
    atual.trade_hunter_destaques = parsed.destaques;

    await env.MANUAL_DATA.put("dados", JSON.stringify(atual));

    console.log(`Trade Hunter atualizado: relatorio de ${parsed.dataRelatorio}, ${parsed.win.length} players WIN, ${parsed.wdo.length} players WDO, ${parsed.placarCards.length} cartoes no placar, ${parsed.destaques.length} destaques.`);
    return { ok: true, relatorio_data: parsed.dataRelatorio, win: parsed.win.length, wdo: parsed.wdo.length, placar_cards: parsed.placarCards.length, destaques: parsed.destaques.length };
  } catch (e) {
    console.log("Trade Hunter: erro ao buscar/atualizar:", String(e));
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
      // CORRIGIDO (23/set/2026): antes esse POST reconstruia o registro do
      // ZERO a cada chamada (so' com atualizado_em/briefing/SR_FIELDS/
      // EXTRA_FIELDS), o que apagava silenciosamente qualquer campo escrito
      // por uma rotina automatica fora dessas listas (ex: os campos do
      // Trade Hunter) toda vez que o painel manual fosse salvo. Agora le' o
      // registro atual do KV primeiro e so' sobrescreve os campos que o
      // formulario manual realmente controla, preservando o resto.
      const data = (await env.MANUAL_DATA.get("dados", "json")) || {};
      data.atualizado_em = new Date().toISOString();
      data.briefing = body.briefing || "";
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

    // Mesma ideia do /api/fedwatch-refresh, mas pro Trade Hunter (WIN/WDO):
    // forca a busca+parse+gravacao agora, sem esperar o Cron das 7:50.
    if (url.pathname === "/api/trade-hunter-refresh" && request.method === "GET") {
      const chave = url.searchParams.get("chave");
      if (chave !== env.EDIT_KEY) {
        return new Response(JSON.stringify({ error: "chave invalida" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const resultado = await atualizarTradeHunter(env);
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

    // ---------- Diario Semanal (registro diario, trades, relatorio, chat IA) ----------
    // Reaproveita a mesma sessao (x-sessao / LEADS_KV) ja usada nas Ferramentas
    // do Trader -- nao exige novo cadastro, so' um usuario ja logado.

    if (url.pathname === "/api/diario/registro" && request.method === "GET") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const data = url.searchParams.get("data") || hojeBrasil();
      if (!dataValida(data)) {
        return new Response(JSON.stringify({ error: "data invalida" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const registro = await env.DIARIO_DB.prepare(
        "SELECT * FROM registros_diarios WHERE email = ? AND data = ?"
      ).bind(email, data).first();
      return new Response(JSON.stringify(registro || {}), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/diario/registro" && request.method === "POST") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ error: "corpo invalido" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const data = body.data || hojeBrasil();
      if (!dataValida(data)) {
        return new Response(JSON.stringify({ error: "data invalida" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      await env.DIARIO_DB.prepare(
        `INSERT INTO registros_diarios (email, data, grafico_nota, suportes_resistencias, tendencia, observacoes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email, data) DO UPDATE SET
           grafico_nota = excluded.grafico_nota,
           suportes_resistencias = excluded.suportes_resistencias,
           tendencia = excluded.tendencia,
           observacoes = excluded.observacoes`
      ).bind(email, data, body.grafico_nota || "", body.suportes_resistencias || "", body.tendencia || "", body.observacoes || "").run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/diario/trades" && request.method === "GET") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const data = url.searchParams.get("data");
      const inicio = url.searchParams.get("inicio");
      const fim = url.searchParams.get("fim");
      let resultado;
      if (data && dataValida(data)) {
        resultado = await env.DIARIO_DB.prepare(
          "SELECT * FROM trades WHERE email = ? AND data = ? ORDER BY horario ASC, id ASC"
        ).bind(email, data).all();
      } else if (inicio && fim && dataValida(inicio) && dataValida(fim)) {
        resultado = await env.DIARIO_DB.prepare(
          "SELECT * FROM trades WHERE email = ? AND data BETWEEN ? AND ? ORDER BY data ASC, horario ASC"
        ).bind(email, inicio, fim).all();
      } else {
        resultado = await env.DIARIO_DB.prepare(
          "SELECT * FROM trades WHERE email = ? ORDER BY data DESC, id DESC LIMIT 50"
        ).bind(email).all();
      }
      return new Response(JSON.stringify(resultado.results || []), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/diario/trades" && request.method === "POST") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ error: "corpo invalido" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const data = body.data || hojeBrasil();
      if (!dataValida(data) || !body.ativo) {
        return new Response(JSON.stringify({ error: "dados incompletos" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const info = await env.DIARIO_DB.prepare(
        `INSERT INTO trades (email, data, horario, ativo, direcao, preco_entrada, preco_saida, quantidade, resultado, motivo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        email, data, body.horario || "", body.ativo,
        body.direcao === "venda" ? "venda" : "compra",
        Number(body.preco_entrada) || null, Number(body.preco_saida) || null,
        Number(body.quantidade) || null, Number(body.resultado) || 0, body.motivo || ""
      ).run();
      return new Response(JSON.stringify({ ok: true, id: info.meta.last_row_id }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/diario/trades-excluir" && request.method === "POST") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) { body = {}; }
      if (!body.id) {
        return new Response(JSON.stringify({ error: "id obrigatorio" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      await env.DIARIO_DB.prepare("DELETE FROM trades WHERE id = ? AND email = ?").bind(body.id, email).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/diario/resumo-semana" && request.method === "GET") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const inicio = url.searchParams.get("inicio");
      const fim = url.searchParams.get("fim");
      if (!dataValida(inicio) || !dataValida(fim)) {
        return new Response(JSON.stringify({ error: "periodo invalido" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const resultado = await env.DIARIO_DB.prepare(
        "SELECT * FROM trades WHERE email = ? AND data BETWEEN ? AND ? ORDER BY data ASC, horario ASC"
      ).bind(email, inicio, fim).all();
      const trades = resultado.results || [];
      const totalTrades = trades.length;
      const ganhos = trades.filter(t => Number(t.resultado) > 0).length;
      const resultadoAcumulado = trades.reduce((soma, t) => soma + (Number(t.resultado) || 0), 0);
      return new Response(JSON.stringify({
        total_trades: totalTrades,
        ganhos,
        perdas: totalTrades - ganhos,
        win_rate: totalTrades ? Math.round((ganhos / totalTrades) * 100) : null,
        resultado_acumulado: resultadoAcumulado,
        trades,
      }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Recebe o TEXTO ja extraido do PDF do relatorio do Profit (extraido no
    // navegador via pdf.js, pra nao precisar de biblioteca de PDF dentro do
    // Worker) e pede pra IA estruturar isso em JSON.
    if (url.pathname === "/api/diario/relatorio-semanal" && request.method === "POST") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ error: "corpo invalido" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const { semana_inicio, semana_fim, texto_pdf, pdf_nome } = body;
      if (!dataValida(semana_inicio) || !dataValida(semana_fim) || !texto_pdf) {
        return new Response(JSON.stringify({ error: "dados incompletos" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      let resumoJson;
      try {
        const respostaIA = await chamarClaude(
          env,
          "Você extrai dados estruturados de relatórios de performance da plataforma Profit (Nelógica). Responda APENAS com um JSON válido, sem markdown, sem texto antes ou depois, com este formato: "
          + '{"resultado_liquido": number, "total_trades": number, "trades_ganhadores": number, "trades_perdedores": number, "ativo_mais_operado": string, "observacoes": string}. '
          + "Se algum dado não aparecer no texto, use null nesse campo.",
          [{ role: "user", content: `Texto extraído do relatório semanal (PDF do Profit):\n\n${texto_pdf.slice(0, 15000)}` }]
        );
        resumoJson = JSON.parse(respostaIA.trim().replace(/^```json\s*|```$/g, ""));
      } catch (e) {
        return new Response(JSON.stringify({ error: "falha ao interpretar relatorio", detalhe: String(e) }), {
          status: 502, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      await env.DIARIO_DB.prepare(
        "INSERT INTO relatorios_semanais (email, semana_inicio, semana_fim, resumo_json, pdf_nome) VALUES (?, ?, ?, ?, ?)"
      ).bind(email, semana_inicio, semana_fim, JSON.stringify(resumoJson), pdf_nome || "").run();
      return new Response(JSON.stringify({ ok: true, resumo: resumoJson }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/diario/chat-historico" && request.method === "GET") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const resultado = await env.DIARIO_DB.prepare(
        "SELECT papel, mensagem, criado_em FROM conversas_ia WHERE email = ? ORDER BY id DESC LIMIT 30"
      ).bind(email).all();
      const mensagens = (resultado.results || []).reverse();
      return new Response(JSON.stringify(mensagens), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/diario/chat" && request.method === "POST") {
      const email = await emailAutenticado(request, env, url);
      if (!email) {
        return new Response(JSON.stringify({ error: "nao autenticado" }), {
          status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ error: "corpo invalido" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const mensagemUsuario = (body.mensagem || "").trim();
      if (!mensagemUsuario) {
        return new Response(JSON.stringify({ error: "mensagem vazia" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      await env.DIARIO_DB.prepare(
        "INSERT INTO conversas_ia (email, papel, mensagem) VALUES (?, 'user', ?)"
      ).bind(email, mensagemUsuario).run();

      const historico = await env.DIARIO_DB.prepare(
        "SELECT papel, mensagem FROM conversas_ia WHERE email = ? ORDER BY id DESC LIMIT 16"
      ).bind(email).all();
      const mensagensParaIA = (historico.results || []).reverse().map(m => ({
        role: m.papel === "assistant" ? "assistant" : "user",
        content: m.mensagem,
      }));

      let respostaTexto;
      try {
        const contexto = await montarContextoDiario(env, email);
        const systemPrompt = SYSTEM_PROMPT_DIARIO.replace("{{CONTEXTO}}", contexto);
        respostaTexto = await chamarClaude(env, systemPrompt, mensagensParaIA);
      } catch (e) {
        return new Response(JSON.stringify({ error: "falha ao consultar a IA", detalhe: String(e) }), {
          status: 502, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      await env.DIARIO_DB.prepare(
        "INSERT INTO conversas_ia (email, papel, mensagem) VALUES (?, 'assistant', ?)"
      ).bind(email, respostaTexto).run();

      return new Response(JSON.stringify({ resposta: respostaTexto }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  // Roda automaticamente conforme os Cron Triggers configurados no painel do
  // Cloudflare (Settings > Triggers > Cron Triggers). Agora temos DOIS
  // triggers, entao precisamos checar qual foi o disparo (event.cron) pra
  // rodar so' a rotina certa - senao toda vez que um disparasse rodaria os
  // dois de novo, sem necessidade nenhuma:
  // - "0 10 * * *"    -> 7:00 BRT (todo dia)      -> FedWatch (ja existia)
  // - "50 10 * * 2-6" -> 7:50 BRT (dias uteis) -> NOVO: Trade Hunter
  //   (falta configurar esse 2o trigger no painel do Cloudflare, igual foi
  //   feito com o do FedWatch - CUIDADO: o campo de dia-da-semana do Cloudflare
  //   conta domingo=1, entao segunda-a-sexta e' "2-6", NAO "1-5" como seria
  //   no cron "padrao" onde domingo=0)
  async scheduled(event, env, ctx) {
    if (event.cron === "50 10 * * 2-6") {
      ctx.waitUntil(atualizarTradeHunter(env));
    } else {
      // Cobre o trigger do FedWatch e tambem o botao de teste manual do
      // painel do Cloudflare (que dispara "scheduled" sem um cron
      // reconhecido) - mantem o comportamento de sempre nesses casos.
      ctx.waitUntil(atualizarFedWatch(env));
    }
  },
};
