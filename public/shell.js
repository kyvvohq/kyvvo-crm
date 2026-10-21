// Shell compartilhado das telas autenticadas — auth guard, cabeçalho (logo +
// balão de notificações + menu de perfil + tema), sidebar de navegação e
// helpers de modal. Espera que a página já tenha no DOM: #painel-sidebar,
// #btn-toggle-sidebar, #topo-perfil, #topo-perfil-gatilho, #menu-perfil,
// elementos com classe .js-avatar-usuario/.js-nome-usuario/.js-email-usuario/
// .btn-sair/.toggle-tema. #notificacoes-sino (.ds-notificacoes do design
// system) é opcional — só liga o polling se a página tiver o balão no <header>.
// Incluir via <script src="/crm/shell.js"> no fim do <body>, depois de um
// snippet inline no <head> que já tenha aplicado data-theme no <html> (evita
// flash do tema errado). Mesmo padrão do kyvvo-people/public/shell.js.

const token = localStorage.getItem('crm_token');
if (!token) window.location.href = '/crm/login.html';

async function apiFetch(url, opts = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem('crm_token');
    localStorage.removeItem('crm_nome');
    localStorage.removeItem('crm_outros_produtos');
    window.location.href = '/crm/login.html';
    throw new Error('Sessão expirada');
  }
  return res;
}

// --- Ícones (Lucide, inline — sem dependência de CDN) ---
const ICON_PATHS = {
  'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  kanban: '<path d="M5 3v14"/><path d="M12 3v8"/><path d="M19 3v18"/>',
  list: '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>',
  funnel: '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>',
  settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  ellipsis: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  menu: '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'message-circle': '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
  'sun-moon': '<path d="M12 2v2"/><path d="M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715"/><path d="M16 12a4 4 0 0 0-4-4"/><path d="m19 5-1.256 1.256"/><path d="M20 12h2"/>',
  'log-out': '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.986L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  cake: '<path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20"/><path d="M7 8v3"/><path d="M12 8v3"/><path d="M17 8v3"/><path d="M7 4h.01"/><path d="M12 4h.01"/><path d="M17 4h.01"/>',
  'circle-alert': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  'package-check': '<path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/><path d="m17 13.5 2 2 4-4"/>',
  'circle-dollar-sign': '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73z"/><path d="M12 22V12"/><path d="M3.3 7 12 12l8.7-5"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  'chevrons-left': '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
  'chevrons-right': '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
  'chart-column': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  mail: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
  'bell-off': '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>',
  percent: '<line x1="19" x2="5" y1="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
};

function icon(name, size = 18) {
  const inner = ICON_PATHS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

document.querySelectorAll('[data-icon]').forEach((el) => {
  el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
});

// --- Sidebar (componente data-ds-menu do @kyvvohq/design-system) ---
// O recolher/expandir e os grupos colapsáveis (Configurações > Automações)
// são hidratados pelo próprio /ds/components.js a partir de `data-ds-menu`
// no <nav> — aqui só persiste a escolha de recolhido e marca o item ativo
// (mesmo padrão do kyvvo-people/public/shell.js).
const painelSidebar = document.getElementById('painel-sidebar');
if (localStorage.getItem('crm_sidebar_oculta') === '1') {
  painelSidebar.setAttribute('data-ds-menu-recolhido', '');
}
painelSidebar.addEventListener('ds-menu-alternar', (e) => {
  localStorage.setItem('crm_sidebar_oculta', e.detail.recolhido ? '1' : '0');
});
// Item "Atendimento" (agente de IA) — injetado aqui para valer em todas as telas; o contador mostra
// os encaminhamentos abertos ("com quem preciso falar hoje?").
(function adicionarMenuAtendimento() {
  const lista = painelSidebar.querySelector('.ds-menu-lista');
  if (!lista || lista.querySelector('a[href="/crm/atendimento.html"]')) return;
  const li = document.createElement('li');
  li.innerHTML = '<a class="ds-menu-link" href="/crm/atendimento.html"><span class="ds-menu-icone">' + icon('message-circle', 18)
    + '</span><span class="ds-menu-rotulo">Atendimento</span><span class="menu-contador" id="menu-atendimento-contador" hidden></span></a>';
  const pedidos = lista.querySelector('a[href="/crm/pedidos.html"]');
  if (pedidos && pedidos.parentElement) pedidos.parentElement.after(li); else lista.appendChild(li);
  apiFetch('/crm/api/agente/resumo').then((r) => (r.ok ? r.json() : null)).then((d) => {
    const el = document.getElementById('menu-atendimento-contador');
    if (d && el && d.encaminhamentos_abertos > 0) { el.textContent = d.encaminhamentos_abertos; el.hidden = false; }
  }).catch(() => {});
})();
document.querySelectorAll('.ds-menu-link[href], .ds-menu-sublink[href]').forEach((item) => {
  if (item.getAttribute('href') !== window.location.pathname) return;
  item.classList.add(item.classList.contains('ds-menu-sublink') ? 'ds-menu-sublink-ativo' : 'ds-menu-link-ativo');
});

// --- Tema claro/escuro ---
function temaAtual() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function aplicarLogos() {
  const escuro = temaAtual() === 'dark';
  document.querySelectorAll('.js-logo-kyvvo').forEach((img) => {
    img.src = escuro ? '/ds/logo-dark.svg' : '/ds/logo.svg';
  });
}
function sincronizarToggleTema() {
  const escuro = temaAtual() === 'dark';
  document.querySelectorAll('.toggle-tema').forEach((btn) => {
    btn.classList.toggle('ligado', escuro);
    btn.setAttribute('aria-checked', String(escuro));
  });
  aplicarLogos();
}
function definirTema(tema) {
  document.documentElement.setAttribute('data-theme', tema);
  localStorage.setItem('crm_tema', tema);
  sincronizarToggleTema();
}
document.querySelectorAll('.toggle-tema').forEach((btn) => {
  btn.addEventListener('click', () => definirTema(temaAtual() === 'dark' ? 'light' : 'dark'));
});
sincronizarToggleTema();

// --- Menu de perfil (cabeçalho, canto superior direito) ---
const topoPerfilGatilho = document.getElementById('topo-perfil-gatilho');
const menuPerfil = document.getElementById('menu-perfil');

function fecharMenuPerfil() {
  if (menuPerfil) menuPerfil.hidden = true;
}
if (topoPerfilGatilho && menuPerfil) {
  topoPerfilGatilho.addEventListener('click', (e) => {
    e.stopPropagation();
    const vaiAbrir = menuPerfil.hidden;
    fecharMenuPerfil();
    if (vaiAbrir) menuPerfil.hidden = false;
  });
  document.addEventListener('click', (e) => {
    if (!document.getElementById('topo-perfil').contains(e.target)) fecharMenuPerfil();
  });
}

function iniciaisNome(nomeCompleto) {
  const partes = (nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
}

const nomeUsuario = localStorage.getItem('crm_nome') || '';
document.querySelectorAll('.js-avatar-usuario').forEach((el) => { el.textContent = iniciaisNome(nomeUsuario); });
document.querySelectorAll('.js-nome-usuario').forEach((el) => { el.textContent = nomeUsuario; });

let emailUsuario = '';
try {
  emailUsuario = JSON.parse(atob(token.split('.')[1])).email || '';
} catch {
  emailUsuario = '';
}
document.querySelectorAll('.js-email-usuario').forEach((el) => { el.textContent = emailUsuario; });

// "Trocar de produto" — outros produtos Kyvvo que o mesmo tenant também tem
// ativo. Corte de sessão (RS256 unificado): o token agora é emitido pelo
// platform e não carrega mais isso — vem separado na resposta do login,
// cacheado em localStorage (mesmo padrão já usado pra crm_nome), não mais
// decodificado do token (ver kyvvo-crm/index.js, kyvvo-crm/public/
// login.html). Logo acima de "Sair da conta" (CRM não tem um item "Meu
// Perfil" pra ancorar embaixo).
let outrosProdutosUsuario = [];
try {
  outrosProdutosUsuario = JSON.parse(localStorage.getItem('crm_outros_produtos') || '[]');
} catch {
  outrosProdutosUsuario = [];
}
const menuOutrosProdutos = document.getElementById('menu-perfil-outros-produtos');
if (menuOutrosProdutos) {
  menuOutrosProdutos.innerHTML = outrosProdutosUsuario
    .map((p) => `<a class="menu-perfil-item" href="${p.url}" data-produto-chave="${p.chave}">${icon('package')}<span class="rotulo">${p.nome}</span></a>`)
    .join('');
}

// Clicar num item de "trocar de produto" tenta primeiro o login automático
// (handoff via kyvvo-platform) — só cai no link puro (landing pública pra
// logar de novo) se o handoff falhar por qualquer motivo. `href` já aponta
// pro link puro de propósito: clique com botão do meio/Ctrl (nova aba)
// continua funcionando normal.
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-produto-chave]');
  if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const destinoDireto = link.href;
  apiFetch('/crm/api/meus-produtos/handoff', { method: 'POST', body: JSON.stringify({ produto: link.dataset.produtoChave, nome: localStorage.getItem('crm_nome') || '', outrosProdutos: outrosProdutosUsuario }) })
    .then((res) => res.json())
    .then((dados) => { window.location.href = (dados && dados.url) || destinoDireto; })
    .catch(() => { window.location.href = destinoDireto; });
});

document.querySelectorAll('.btn-sair').forEach((btn) => {
  btn.addEventListener('click', () => {
    localStorage.removeItem('crm_token');
    localStorage.removeItem('crm_nome');
    localStorage.removeItem('crm_outros_produtos');
    window.location.href = '/crm/login.html';
  });
});

// --- Modal genérico — usa o componente do DS (KyvvoDS.modalAbrir/modalFechar,
// v2.9.0+) por baixo, mantendo a mesma assinatura de sempre (tituloHtml como
// string "<h3>texto</h3>", classeExtra, retorna o overlay) pra nenhuma das
// ~25 chamadas espalhadas pelas telas precisar mudar (migração 2026-10-07).
// `tituloHtml` normalmente é só um `<h3>`, mas abrirModalDisparoIndividual
// (mais abaixo) passa um `<h3>` seguido de conteúdo extra (`<p>`) — esse
// resto vai pro corpo, antes do conteúdo próprio, em vez de ficar preso
// dentro da tag de título que o DS já desenha.
function fecharModal() {
  KyvvoDS.modalFechar();
}
function abrirModal(tituloHtml, conteudoHtml, classeExtra) {
  const match = /^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>([\s\S]*)$/.exec((tituloHtml || '').trim());
  const titulo = match ? match[1] : tituloHtml;
  const corpoExtra = match ? match[2] : '';
  return KyvvoDS.modalAbrir(corpoExtra + conteudoHtml, { titulo, classeExtra });
}
function avisar(titulo, mensagem) {
  abrirModal(
    `<h3>${titulo}</h3>`,
    `
      <p class="modal-texto">${mensagem}</p>
      <div class="modal-acoes">
        <button type="button" class="ds-btn ds-btn-primario" id="btn-ok-aviso">OK</button>
      </div>
    `
  );
  document.getElementById('btn-ok-aviso').addEventListener('click', fecharModal);
}

// Toda ação de excluir/cancelar/remover passa por aqui antes de executar —
// mesmo modal genérico (estilo danger no botão de confirmar), texto e
// rótulos configuráveis por chamada. `aoConfirmar` só roda se o usuário
// confirmar; erro nele mantém o modal aberto (não fecha silenciosamente).
function confirmarAcao(titulo, mensagem, aoConfirmar, opts = {}) {
  const textoConfirmar = opts.textoConfirmar || 'Excluir';
  const textoCancelar = opts.textoCancelar || 'Cancelar';
  abrirModal(
    `<h3>${titulo}</h3>`,
    `
      <p class="modal-texto">${mensagem}</p>
      <div class="modal-acoes">
        <button type="button" class="ds-btn ds-btn-secundario" id="confirmar-acao-cancelar">${textoCancelar}</button>
        <button type="button" class="ds-btn ds-btn-perigo" id="confirmar-acao-confirmar">${textoConfirmar}</button>
      </div>
    `
  );
  document.getElementById('confirmar-acao-cancelar').addEventListener('click', fecharModal);
  document.getElementById('confirmar-acao-confirmar').addEventListener('click', async () => {
    await aoConfirmar();
    fecharModal();
  });
}

// --- Helpers de formatação reaproveitados entre telas ---
function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function formatarData(iso) {
  return iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';
}
// Pra colunas `date` (sem hora, ex.: data_nascimento, data_entrega) — não
// usa `new Date(iso)` de propósito: o Postgres manda só "AAAA-MM-DD", o JS
// interpreta isso como meia-noite UTC, e toLocaleDateString('pt-BR') exibe
// no fuso local (UTC-3) — vira o dia anterior. Fatiar a string direto evita
// o bug (mesmo cuidado já tomado no cálculo de aniversariantes do mês).
function formatarDataSemFuso(data) {
  if (!data) return '—';
  const [ano, mes, dia] = String(data).slice(0, 10).split('-');
  return `${dia}/${mes}/${ano}`;
}
function formatarDataHora(iso) {
  return iso ? new Date(iso).toLocaleString('pt-BR') : '—';
}
function escapeHtml(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
// wa.me só aceita dígitos (com DDI) — telefone já vem em E.164 (+55...) do backend.
function linkWhatsapp(telefone, mensagem) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  return `https://wa.me/${digitos}${mensagem ? `?text=${encodeURIComponent(mensagem)}` : ''}`;
}
// Telefone vem do servidor em E.164 (+5534999998888) — a máscara "telefone"
// do DS espera só o número local (sem o 55 do país), senão formata errado
// (achado real ao pré-preencher um campo com máscara, 2026-10-07). Use
// sempre que for jogar um telefone JÁ SALVO num campo com data-ds-mascara.
function whatsappParaExibicao(valorE164) {
  if (!valorE164) return '';
  let digitos = valorE164.replace(/\D/g, '');
  if (digitos.length > 11 && digitos.startsWith('55')) digitos = digitos.slice(2);
  return (window.KyvvoDS && KyvvoDS.mascara) ? KyvvoDS.mascara.formatar('telefone', digitos) : digitos;
}

// --- Máscara de moeda (R$ 0,00) — digita só números, formata sozinho.
// O valor "de verdade" pra mandar pro backend sai de valorMoedaParaNumero,
// nunca de input.value (que é só o texto formatado).
function aplicarMascaraMoeda(input) {
  const formatar = () => {
    const digitos = input.value.replace(/\D/g, '');
    const numero = Number(digitos || 0) / 100;
    input.value = numero.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  input.addEventListener('input', formatar);
  if (input.value) formatar();
}
function valorMoedaParaNumero(input) {
  const digitos = (input.value || '').replace(/\D/g, '');
  return Number(digitos || 0) / 100;
}

// --- Notificações (balão do topo, #notificacoes-sino) ---
// Balão (.ds-notificacoes) é componente do design system (/ds/components.js,
// KyvvoDS.notificacoesAtualizar cuida de abrir/fechar e da pílula de
// contagem) — aqui só busca os pendentes e desenha a lista, mesmo desenho
// do kyvvo-studio (server/panel/public/app.js), incluindo marcar como lida.
// Só uma tela de destino por enquanto (Quadro/Pedidos); tipo novo que
// precisar de destino próprio entra aqui.
function abrirNotificacaoItem(tipo) {
  if (tipo === 'pedidos_parados') window.location.href = '/crm/quadro.html';
  else if (tipo === 'pedido_criado' || tipo === 'pedido_pronto') window.location.href = '/crm/pedidos.html';
  else if (tipo === 'importacao_concluida') window.location.href = '/crm/importacao.html';
  else if (tipo === 'whatsapp_limite_proximo') window.location.href = '/crm/automacoes.html';
  else if (tipo === 'atendimento_bot_travado') window.location.href = '/crm/atendimento.html';
}

async function marcarNotificacaoLida(id) {
  const res = await apiFetch(`/crm/api/notificacoes/${id}/lida`, { method: 'PATCH' });
  if (res.ok) carregarNotificacoes();
}

document.addEventListener('click', (e) => {
  // Botão "marcar como lida" fica DENTRO do <a> do item — precisa vir antes
  // do closest('.ds-notificacoes-item') abaixo e nunca deixar o clique
  // também navegar.
  const btnLida = e.target.closest('.ds-notificacoes-item-marcar-lida');
  if (btnLida) {
    e.preventDefault();
    e.stopPropagation();
    marcarNotificacaoLida(btnLida.dataset.id);
    return;
  }
  const item = e.target.closest('.ds-notificacoes-item');
  if (item) { e.preventDefault(); abrirNotificacaoItem(item.dataset.tipo); }
});

async function carregarNotificacoes() {
  const sino = document.getElementById('notificacoes-sino');
  const lista = document.getElementById('notificacoes-lista');
  if (!sino || !lista || !window.KyvvoDS) return;
  const res = await apiFetch('/crm/api/notificacoes');
  const dados = await res.json();
  const grupos = dados.notificacoes || [];
  const total = grupos.reduce((soma, g) => soma + g.itens.length, 0);
  KyvvoDS.notificacoesAtualizar(sino, total);
  lista.innerHTML = total === 0
    ? '<div class="ds-notificacoes-vazio">Nenhuma notificação por enquanto.</div>'
    : grupos.map((g) => `
        <div class="ds-notificacoes-grupo-titulo">${escapeHtml(g.titulo)}</div>
        ${g.itens.map((item) => `
          <a class="ds-notificacoes-item" href="#" data-tipo="${g.tipo}" data-id="${item.id}">
            <div class="ds-notificacoes-item-titulo">${escapeHtml(item.titulo)}</div>
            <div class="ds-notificacoes-item-meta">${escapeHtml(item.detalhe)}</div>
            ${g.eventoUnico ? `<button type="button" class="ds-notificacoes-item-marcar-lida" data-id="${item.id}" aria-label="Marcar como lida" title="Marcar como lida">✓</button>` : ''}
          </a>
        `).join('')}
      `).join('');
}
if (document.getElementById('notificacoes-sino')) {
  carregarNotificacoes();
  setInterval(carregarNotificacoes, 60000);
}

// Modal genérico de "peça um texto antes de confirmar uma ação destrutiva"
// (motivo de perda no Quadro, motivo de cancelamento no kebab do Painel
// Hoje) — movida de quadro.html pra cá em 2026-10-03 pra ser reusável.
// Resolve com o texto digitado, ou null se cancelado/fechado.
function pedirTexto(titulo, label, placeholder, textoBotaoConfirmar) {
  return new Promise((resolve) => {
    let resolvido = false;
    const finalizar = (valor) => {
      if (resolvido) return;
      resolvido = true;
      resolve(valor);
    };
    // `aoFechar` do DS cobre X, clique fora e Esc num só callback — os 3
    // contam como cancelar. Guard de `resolvido` evita resolver de novo
    // quando o fechamento é consequência do próprio "Confirmar" (abaixo).
    KyvvoDS.modalAbrir(`
      <label for="pedir-texto-campo">${label}</label>
      <textarea id="pedir-texto-campo" placeholder="${escapeHtml(placeholder || '')}"></textarea>
      <div class="modal-erro" id="pedir-texto-erro"></div>
      <div class="modal-acoes">
        <button type="button" class="ds-btn ds-btn-secundario" id="pedir-texto-cancelar">Cancelar</button>
        <button type="button" class="ds-btn ds-btn-perigo" id="pedir-texto-confirmar">${textoBotaoConfirmar}</button>
      </div>
    `, { titulo, aoFechar: () => finalizar(null) });
    document.getElementById('pedir-texto-cancelar').addEventListener('click', fecharModal);
    document.getElementById('pedir-texto-confirmar').addEventListener('click', () => {
      const texto = document.getElementById('pedir-texto-campo').value.trim();
      if (!texto) { document.getElementById('pedir-texto-erro').textContent = 'Motivo é obrigatório'; return; }
      finalizar(texto);
      fecharModal();
    });
  });
}
function pedirMotivoPerda() {
  return pedirTexto('Motivo da perda', 'Por que este pedido foi perdido?', 'ex.: cliente desistiu, não respondeu, preço...', 'Marcar como perdido');
}
function pedirMotivoCancelamento() {
  return pedirTexto('Cancelar pedido', 'Por que este pedido está sendo cancelado?', 'ex.: cliente desistiu, duplicado...', 'Cancelar pedido');
}

// --- Modal de edição de pedido (Quadro + Pedidos, 2026-10-09) ---------------
// Antes eram duas implementações separadas e divergentes (uma por tela) —
// agora as duas chamam esta função, só mudando o que fazem depois de salvar
// (`onSalvo`, normalmente a própria `carregar()` da tela).
const ORIGENS_MARKETPLACE_PEDIDO = ['shopee', 'tiktok', 'mercado livre', 'mercadolivre', ' ml'];
function ehOrigemPropria(origem) {
  const o = ` ${(origem || '').toLowerCase()}`;
  return !ORIGENS_MARKETPLACE_PEDIDO.some((m) => o.includes(m));
}

function abrirModalPedido(p, { etapas, tiposEntrega, configGeral, onSalvo }) {
  const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const itensPedido = Array.isArray(p.itens) ? p.itens : [];
  const avisoAtivo = !!(configGeral && configGeral.mensagem_aviso_pedido_ativo);
  const mostrarAviso = avisoAtivo && ehOrigemPropria(p.origem) && !p.aviso_canal_proprio_fechado;

  abrirModal(`<h3>${escapeHtml(p.cliente_nome)}</h3>`, `
    <div class="pedido-resumo">
      <div class="pedido-meta">
        <span class="badge">${escapeHtml(p.origem || 'Sem origem')}</span>
        ${itensPedido.length ? `<span class="pedido-meta-texto">${itensPedido.length} ${itensPedido.length === 1 ? 'item' : 'itens'}</span>` : ''}
        ${p.cliente_telefone ? `<button type="button" class="ds-btn ds-btn-secundario ds-btn-sm" id="btn-pedido-ver-conversa">${icon('message-circle', 14)}Ver conversa</button>` : ''}
      </div>
      <div class="pedido-total"><span>Valor do pedido</span><input class="ds-input" id="e-valor-total" inputmode="decimal" placeholder="0,00"></div>
    </div>
    ${mostrarAviso ? `
    <div class="pedido-aviso" id="pedido-aviso-canal-proprio">
      ${icon('package', 16)}<span>${escapeHtml(configGeral.mensagem_aviso_pedido)}</span>
      <button type="button" class="pedido-aviso-fechar" id="btn-fechar-pedido-aviso" aria-label="Fechar aviso">${icon('x', 16)}</button>
    </div>` : ''}
    <div class="ds-form">
      <div class="pedido-grade">
        <div class="ds-campo s2"><label class="ds-rotulo" for="e-cliente-nome">Nome do cliente</label><input class="ds-input" id="e-cliente-nome" value="${escapeHtml(p.cliente_nome || '')}"></div>
        <div class="ds-campo s2"><label class="ds-rotulo" for="e-cliente-telefone">Telefone</label><input class="ds-input" id="e-cliente-telefone" value="${escapeHtml(p.cliente_telefone || '')}"></div>

        <div class="ds-campo">
          <label class="ds-rotulo" for="e-etapa">Etapa</label>
          <div class="ds-select"><select id="e-etapa">${etapas.map((et) => `<option value="${et.id}" ${et.id === p.etapa_id ? 'selected' : ''}>${escapeHtml(et.nome)}</option>`).join('')}</select>${CHEVRON}</div>
        </div>
        <div class="ds-campo">
          <label class="ds-rotulo" for="e-prioridade">Prioridade</label>
          <div class="ds-select"><select id="e-prioridade">
            <option value="">Nenhuma</option>
            <option value="altissima" ${p.prioridade === 'altissima' ? 'selected' : ''}>Altíssima</option>
            <option value="alta" ${p.prioridade === 'alta' ? 'selected' : ''}>Alta</option>
            <option value="media" ${p.prioridade === 'media' ? 'selected' : ''}>Média</option>
            <option value="baixa" ${p.prioridade === 'baixa' ? 'selected' : ''}>Baixa</option>
          </select>${CHEVRON}</div>
        </div>
        <div class="ds-campo">
          <label class="ds-rotulo" for="e-status">Pagamento</label>
          <div class="ds-select"><select id="e-status">
            <option value="pendente" ${p.status_pagamento === 'pendente' ? 'selected' : ''}>Pendente</option>
            <option value="parcial" ${p.status_pagamento === 'parcial' ? 'selected' : ''}>Parcial</option>
            <option value="pago" ${p.status_pagamento === 'pago' ? 'selected' : ''}>Pago</option>
          </select>${CHEVRON}</div>
        </div>

        <div class="ds-campo"><label class="ds-rotulo" for="e-recebido">Valor recebido</label><input class="ds-input" id="e-recebido" inputmode="decimal"></div>
        <div class="ds-campo">
          <label class="ds-rotulo" for="e-tipo-entrega">Tipo de frete</label>
          <div class="ds-select"><select id="e-tipo-entrega"><option value="">Selecione…</option>${tiposEntrega.map((o) => `<option value="${escapeHtml(o.valor)}" ${o.valor === p.tipo_entrega ? 'selected' : ''}>${escapeHtml(o.valor)}</option>`).join('')}</select>${CHEVRON}</div>
        </div>
        <div class="ds-campo"><label class="ds-rotulo" for="e-frete">Valor de frete</label><input class="ds-input" id="e-frete" inputmode="decimal" placeholder="0,00"></div>
        <div class="ds-campo"><label class="ds-rotulo" for="e-entrega">Data de entrega</label><input class="ds-input" id="e-entrega" type="date" value="${p.data_entrega ? p.data_entrega.slice(0, 10) : ''}"></div>
        <div class="ds-campo"><label class="ds-rotulo" for="e-emissao-nf">Data emissão NF</label><input class="ds-input" id="e-emissao-nf" type="date" value="${p.data_emissao_nf ? p.data_emissao_nf.slice(0, 10) : ''}"></div>
        <div class="ds-campo s2">
          <label class="ds-rotulo" for="e-observacoes">Observação</label>
          <textarea class="ds-textarea" id="e-observacoes" placeholder="opcional">${p.observacoes ? escapeHtml(p.observacoes) : ''}</textarea>
        </div>
        <div class="ds-campo s2">
          <span class="ds-rotulo">Itens do pedido</span>
          <div class="pedido-itens">
            ${itensPedido.length ? `
            <div class="pedido-itens-cabecalho"><span class="col-qtd">Qtd</span><span class="col-desc">Descrição</span></div>
            <div class="pedido-itens-corpo">
              ${itensPedido.map((i) => {
                const qtd = Number(i.quantidade) || 1;
                const qtdTexto = Number.isInteger(qtd) ? qtd : qtd.toLocaleString('pt-BR');
                const desc = i.descricao || 'Item sem descrição';
                return `<div class="pedido-item-linha" title="${escapeHtml(desc)}"><span class="col-qtd">${qtdTexto}×</span><span class="col-desc">${escapeHtml(desc)}</span></div>`;
              }).join('')}
            </div>` : '<p class="pedido-itens-vazio">Nenhum item registrado.</p>'}
          </div>
        </div>
        ${Array.isArray(p.arquivos) && p.arquivos.length ? `
        <div class="ds-campo s2">
          <span class="ds-rotulo">Anexos (${p.arquivos.length})</span>
          <div class="pedido-anexos">
            ${p.arquivos.map((a) => {
              const ehImagem = (a.tipo_mime || '').startsWith('image/');
              return ehImagem
                ? `<button type="button" class="pedido-anexo pedido-anexo-imagem" data-pedido-anexo="${a.id}" title="${escapeHtml(a.nome_arquivo || 'Abrir arquivo')}"><img data-pedido-anexo-img="${a.id}" alt="${escapeHtml(a.nome_arquivo || 'imagem')}"></button>`
                : `<button type="button" class="ds-btn ds-btn-ghost ds-btn-sm pedido-anexo" data-pedido-anexo="${a.id}">${icon('download', 14)}${escapeHtml(a.nome_arquivo || 'Abrir arquivo')}</button>`;
            }).join('')}
          </div>
        </div>` : ''}
      </div>
      <div class="modal-erro" id="e-erro"></div>
      <div class="ds-form-acoes">
        <button type="button" class="ds-btn ds-btn-secundario" id="btn-cancelar-edicao">Cancelar</button>
        <button type="button" class="ds-btn ds-btn-primario" id="btn-salvar-edicao" disabled>Salvar</button>
      </div>
    </div>
  `, 'ds-modal-card-pedido');

  document.getElementById('btn-cancelar-edicao').addEventListener('click', fecharModal);

  const btnVerConversa = document.getElementById('btn-pedido-ver-conversa');
  if (btnVerConversa) btnVerConversa.addEventListener('click', () => abrirModalConversa(p.cliente_telefone, p.cliente_nome));

  // Anexos do pedido (fotos/arquivos que a cliente mandou pro bot) — imagem
  // já abre em miniatura; qualquer tipo abre/baixa num clique (mesmo padrão
  // de atendimento.html > abrirAnexo, só que na rota de arquivo do pedido).
  document.querySelectorAll('[data-pedido-anexo-img]').forEach(async (img) => {
    const res = await apiFetch(`/crm/api/pedidos/${p.id}/arquivos/${img.dataset.pedidoAnexoImg}`);
    if (res.ok) img.src = URL.createObjectURL(await res.blob()); else img.closest('.pedido-anexo').remove();
  });
  document.querySelectorAll('[data-pedido-anexo]').forEach((btn) => btn.addEventListener('click', async () => {
    const res = await apiFetch(`/crm/api/pedidos/${p.id}/arquivos/${btn.dataset.pedidoAnexo}`);
    if (!res.ok) { document.getElementById('e-erro').textContent = 'Arquivo indisponível'; return; }
    window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
  }));

  const btnFecharAviso = document.getElementById('btn-fechar-pedido-aviso');
  if (btnFecharAviso) {
    btnFecharAviso.addEventListener('click', () => {
      document.getElementById('pedido-aviso-canal-proprio').remove();
      p.aviso_canal_proprio_fechado = true;
      apiFetch(`/crm/api/pedidos/${p.id}/entrega`, { method: 'PATCH', body: JSON.stringify({ aviso_canal_proprio_fechado: true }) }).catch(() => {});
    });
  }

  const campoValorTotal = document.getElementById('e-valor-total');
  campoValorTotal.value = Number(p.valor_total || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  aplicarMascaraMoeda(campoValorTotal);

  const campoRecebido = document.getElementById('e-recebido');
  campoRecebido.value = Number(p.valor_recebido || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  aplicarMascaraMoeda(campoRecebido);
  const campoFreteEdicao = document.getElementById('e-frete');
  campoFreteEdicao.value = p.frete ? Number(p.frete).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
  aplicarMascaraMoeda(campoFreteEdicao);

  // Salvar começa desabilitado — só libera quando algo muda de verdade
  // (pedido do Bruno). Snapshot de todos os campos editáveis logo após
  // aplicar os valores iniciais (inclusive os com máscara de moeda).
  const formPedido = document.querySelector('.ds-modal-card-pedido .ds-form');
  const btnSalvar = document.getElementById('btn-salvar-edicao');
  function lerEstadoForm() {
    return JSON.stringify({
      nome: document.getElementById('e-cliente-nome').value.trim(),
      telefone: document.getElementById('e-cliente-telefone').value.trim(),
      etapa: document.getElementById('e-etapa').value,
      prioridade: document.getElementById('e-prioridade').value,
      status: document.getElementById('e-status').value,
      valorTotal: campoValorTotal.value,
      recebido: campoRecebido.value,
      tipoEntrega: document.getElementById('e-tipo-entrega').value,
      frete: campoFreteEdicao.value,
      entrega: document.getElementById('e-entrega').value,
      emissaoNf: document.getElementById('e-emissao-nf').value,
      observacoes: document.getElementById('e-observacoes').value,
    });
  }
  const estadoInicial = lerEstadoForm();
  const atualizarSalvarHabilitado = () => { btnSalvar.disabled = lerEstadoForm() === estadoInicial; };
  formPedido.addEventListener('input', atualizarSalvarHabilitado);
  formPedido.addEventListener('change', atualizarSalvarHabilitado);

  btnSalvar.addEventListener('click', async () => {
    const novoNome = document.getElementById('e-cliente-nome').value.trim();
    const novoTelefone = document.getElementById('e-cliente-telefone').value.trim();
    const novaEtapaId = document.getElementById('e-etapa').value;
    const novaPrioridade = document.getElementById('e-prioridade').value || null;
    const novoStatus = document.getElementById('e-status').value;
    const novoRecebido = valorMoedaParaNumero(campoRecebido);

    // Edita o CLIENTE vinculado, não o pedido — nome/telefone não são
    // campos de crm_pedidos. Só manda o PATCH se algo mudou de verdade.
    if (novoNome !== (p.cliente_nome || '') || novoTelefone !== (p.cliente_telefone || '')) {
      const resCliente = await apiFetch(`/crm/api/clientes/${p.cliente_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ nome: novoNome, telefone: novoTelefone }),
      });
      if (!resCliente.ok) { document.getElementById('e-erro').textContent = 'Falha ao salvar nome/telefone do cliente'; return; }
    }

    if (novaEtapaId !== p.etapa_id) {
      const etapaAlvo = etapas.find((et) => et.id === novaEtapaId);
      let motivoPerda;
      if (etapaAlvo.tipo === 'perdida') {
        motivoPerda = await pedirMotivoPerda();
        if (!motivoPerda) return;
      }
      const res = await apiFetch(`/crm/api/pedidos/${p.id}/etapa`, { method: 'PATCH', body: JSON.stringify({ etapa_id: novaEtapaId, motivo_perda: motivoPerda }) });
      if (!res.ok) {
        const dados = await res.json().catch(() => ({}));
        document.getElementById('e-erro').textContent = dados.error || 'Falha ao mover etapa';
        return;
      }
    }
    if (novaPrioridade !== (p.prioridade || null)) {
      const res = await apiFetch(`/crm/api/pedidos/${p.id}/prioridade`, { method: 'PATCH', body: JSON.stringify({ prioridade: novaPrioridade }) });
      if (!res.ok) { document.getElementById('e-erro').textContent = 'Falha ao atualizar prioridade'; return; }
    }
    const novoValorTotal = valorMoedaParaNumero(campoValorTotal);
    if (novoValorTotal !== Number(p.valor_total || 0)) {
      const res = await apiFetch(`/crm/api/pedidos/${p.id}/valor`, { method: 'PATCH', body: JSON.stringify({ valor_total: novoValorTotal }) });
      if (!res.ok) { document.getElementById('e-erro').textContent = 'Falha ao salvar valor do pedido'; return; }
    }
    const res = await apiFetch(`/crm/api/pedidos/${p.id}/pagamento`, { method: 'PATCH', body: JSON.stringify({ status_pagamento: novoStatus, valor_recebido: novoRecebido }) });
    if (!res.ok) { document.getElementById('e-erro').textContent = 'Falha ao salvar pagamento'; return; }

    const novaEntrega = document.getElementById('e-entrega').value || null;
    const novaEmissaoNf = document.getElementById('e-emissao-nf').value || null;
    const novoTipoEntrega = document.getElementById('e-tipo-entrega').value || null;
    const novoFrete = valorMoedaParaNumero(campoFreteEdicao) || null;
    const novaObservacao = document.getElementById('e-observacoes').value.trim() || null;
    const entregaMudou = novaEntrega !== (p.data_entrega ? p.data_entrega.slice(0, 10) : null)
      || novaEmissaoNf !== (p.data_emissao_nf ? p.data_emissao_nf.slice(0, 10) : null)
      || novoTipoEntrega !== (p.tipo_entrega || null)
      || novoFrete !== (p.frete != null ? Number(p.frete) : null)
      || novaObservacao !== (p.observacoes || null);
    if (entregaMudou) {
      const resEntrega = await apiFetch(`/crm/api/pedidos/${p.id}/entrega`, {
        method: 'PATCH',
        body: JSON.stringify({ data_entrega: novaEntrega, data_emissao_nf: novaEmissaoNf, tipo_entrega: novoTipoEntrega, frete: novoFrete, observacoes: novaObservacao }),
      });
      if (!resEntrega.ok) { document.getElementById('e-erro').textContent = 'Falha ao salvar dados de entrega'; return; }
    }

    fecharModal();
    if (onSalvo) onSalvo();
  });
}

// --- Ações rápidas por cliente (Painel Hoje: Aniversariantes do mês e
// Pagamentos pendentes, pedido do Bruno 2026-10-03) — 3 ícones: WhatsApp
// direto (wa.me), conversa pelo próprio CRM (abrirModalConversa, movida de
// whatsapp.html pra cá pra ser reusável) e disparo individual (mensagem
// avulsa agora, usando o modelo já cadastrado da situação).
// `emailAniversario` é opt-in ({ id, email, assunto, corpo }) — só o bloco
// Aniversariantes do mês do Painel passa isto; Pagamentos pendentes (outro
// chamador) continua com só os 3 ícones de sempre. Fica fora do wrapper
// "sem telefone" porque é independente dele: cliente pode ter telefone e
// não ter e-mail cadastrado, ou o contrário.
function acoesClienteHtml(telefone, nomeCliente, mensagemPadrao, emailAniversario) {
  const nome = escapeHtml(nomeCliente || '');
  let emailBtn = '';
  if (emailAniversario) {
    emailBtn = emailAniversario.email
      ? `<button type="button" class="acao-email-aniversario" data-cliente-id="${escapeHtml(emailAniversario.id)}" data-nome="${nome}" data-assunto="${escapeHtml(emailAniversario.assunto || '')}" data-corpo="${escapeHtml(emailAniversario.corpo || '')}" title="Enviar e-mail de aniversário" aria-label="Enviar e-mail de aniversário">${icon('mail', 16)}</button>`
      : `<span class="acao-email-desabilitado" title="Sem e-mail cadastrado">${icon('mail', 16)}</span>`;
  }
  // Sem telefone, os 3 ícones de WhatsApp/conversa/disparo aparecem
  // desabilitados (cinza, sem clique) em vez de sumirem — uma pessoa sem
  // telefone cadastrado (ex.: aniversariante sem WhatsApp na ficha) ainda
  // devia aparecer na lista, só sem como agir em cima dela. Sumir a linha
  // inteira (tentativa anterior) ficava pior: parecia que a pessoa tinha
  // desaparecido, não que faltava um dado.
  if (!telefone) {
    return `
      <div class="acoes-cliente acoes-cliente-desabilitado" title="Sem telefone cadastrado">
        <span>${icon('message-circle', 16)}</span>
        <span><img src="/ds/favicon.svg" width="16" height="16" alt=""></span>
        <span>${icon('zap', 16)}</span>
        ${emailBtn}
      </div>
    `;
  }
  const tel = escapeHtml(telefone);
  const msg = escapeHtml(mensagemPadrao || '');
  // Aniversariantes (emailAniversario presente) é mensagem iniciada pela
  // empresa fora da janela de 24h — a Meta só aceita com modelo aprovado,
  // nunca texto livre (pedido do Bruno, 2026-10-21). Por isso o botão abre um
  // modal diferente (escolher modelo aprovado) em vez do texto livre usado
  // por Pagamentos pendentes.
  const btnDisparo = emailAniversario
    ? `<button type="button" class="acao-disparo-individual" data-tipo="aniversario" data-cliente-id="${escapeHtml(emailAniversario.id)}" data-nome="${nome}" title="Disparo individual (modelo aprovado)" aria-label="Disparo individual (modelo aprovado)">${icon('zap', 16)}</button>`
    : `<button type="button" class="acao-disparo-individual" data-telefone="${tel}" data-nome="${nome}" data-mensagem="${msg}" title="Disparo individual" aria-label="Disparo individual">${icon('zap', 16)}</button>`;
  return `
    <div class="acoes-cliente">
      <a class="acao-whatsapp" href="${linkWhatsapp(telefone, mensagemPadrao)}" target="_blank" rel="noopener" title="Chamar no WhatsApp" aria-label="Chamar no WhatsApp">${icon('message-circle', 16)}</a>
      <button type="button" class="acao-conversa-crm" data-telefone="${tel}" data-nome="${nome}" title="Conversa pelo CRM" aria-label="Conversa pelo CRM"><img src="/ds/favicon.svg" width="16" height="16" alt=""></button>
      ${btnDisparo}
      ${emailBtn}
    </div>
  `;
}
document.addEventListener('click', (e) => {
  const btnConversa = e.target.closest('.acao-conversa-crm');
  if (btnConversa) { abrirModalConversa(btnConversa.dataset.telefone, btnConversa.dataset.nome); return; }
  const btnDisparo = e.target.closest('.acao-disparo-individual');
  if (btnDisparo) {
    if (btnDisparo.dataset.tipo === 'aniversario') abrirModalDisparoAniversario(btnDisparo.dataset.clienteId, btnDisparo.dataset.nome);
    else abrirModalDisparoIndividual(btnDisparo.dataset.telefone, btnDisparo.dataset.nome, btnDisparo.dataset.mensagem);
    return;
  }
  const btnEmail = e.target.closest('.acao-email-aniversario');
  if (btnEmail) abrirModalEmailAniversario(btnEmail.dataset.clienteId, btnEmail.dataset.nome, btnEmail.dataset.assunto, btnEmail.dataset.corpo);
});

// Popup com o histórico completo da conversa (igual whatsapp.html > aba
// Conversas, só que acessível de qualquer tela com shell.js carregado).
// "DD/MM/AAAA às HH:MM" — exatamente o formato do componente .ds-conversas
// (README do design-system), não o formatarDataHora genérico (vírgula em
// vez de "às").
function formatarDataHoraConversa(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const hora = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dia}/${mes}/${d.getFullYear()} às ${hora}:${min}`;
}
function telefoneComBandeiraHtml(telefone) {
  return `<span class="ds-conversas-bandeira" aria-hidden="true">BR</span>${escapeHtml(telefone)}`;
}

// Modal de conversa — componente .ds-conversa-modal do design-system
// (v2.17.0), aberto via KyvvoDS.modalAbrir (não o abrirModal genérico do
// CRM, que é pro resto das telas). Sem o botão "Assumir atendimento" do
// componente original: o bot do CRM é 100% automático, sem handoff pra
// humano (ver lib/notificacoes.js#atendimento_bot_travado) — um botão que
// não faz nada seria pior que não ter botão.
async function abrirModalConversa(telefone, nomeCliente) {
  KyvvoDS.modalAbrir(
    `<div class="ds-conversa-modal">
      <div class="ds-conversa-modal-cabecalho">
        <p class="ds-conversa-modal-nome">${escapeHtml(nomeCliente || telefone)}</p>
        <p class="ds-conversa-modal-whatsapp">${telefoneComBandeiraHtml(telefone)}</p>
      </div>
      <div class="ds-conversa-modal-mensagens" id="conversa-modal-mensagens"><p class="vazio">Carregando…</p></div>
    </div>`,
    { classeExtra: 'ds-modal-card-conversa' }
  );
  const res = await apiFetch(`/crm/api/conversas/${encodeURIComponent(telefone)}/mensagens`);
  const mensagens = await res.json();
  const lista = document.getElementById('conversa-modal-mensagens');
  if (!lista) return; // modal fechado antes da resposta chegar
  lista.innerHTML = mensagens.length ? mensagens.map((m) => `
    <div class="ds-conversa-modal-msg ds-conversa-modal-msg-${m.direcao === 'recebida' ? 'recebida' : 'enviada'}">
      <p class="ds-conversa-modal-msg-texto">${escapeHtml(m.conteudo)}</p>
      <p class="ds-conversa-modal-msg-hora">${formatarDataHoraConversa(m.criado_em)}</p>
    </div>
  `).join('') : '<p class="vazio">Nenhuma mensagem registrada ainda — essa pessoa nunca escreveu pro bot.</p>';
  lista.scrollTop = lista.scrollHeight;
}

// Mensagem avulsa pra 1 cliente agora (fora do fluxo do bot/automações) —
// pré-preenchida com o modelo da situação (aniversário/pagamento pendente
// etc.), editável antes de enviar. Precisa de um número de WhatsApp
// conectado (crm_whatsapp_numeros) — a rota devolve erro claro se não tiver.
function abrirModalDisparoIndividual(telefone, nomeCliente, mensagemPadrao) {
  abrirModal(
    `<h3>Disparo individual</h3><p class="modal-texto">${escapeHtml(nomeCliente || telefone)} · ${escapeHtml(telefone)}</p>`,
    `
      <label for="disparo-mensagem">Mensagem</label>
      <textarea id="disparo-mensagem">${escapeHtml(mensagemPadrao || '')}</textarea>
      <div class="modal-erro" id="disparo-erro"></div>
      <div class="modal-acoes">
        <button type="button" class="ds-btn ds-btn-secundario" id="disparo-cancelar">Cancelar</button>
        <button type="button" class="ds-btn ds-btn-primario" id="disparo-enviar">Enviar</button>
      </div>
    `
  );
  document.getElementById('disparo-cancelar').addEventListener('click', fecharModal);
  document.getElementById('disparo-enviar').addEventListener('click', async () => {
    const mensagem = document.getElementById('disparo-mensagem').value.trim();
    const erroEl = document.getElementById('disparo-erro');
    if (!mensagem) { erroEl.textContent = 'Escreva uma mensagem antes de enviar.'; return; }
    const btn = document.getElementById('disparo-enviar');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    const res = await apiFetch('/crm/api/disparo-individual', {
      method: 'POST',
      body: JSON.stringify({ telefone, mensagem }),
    });
    if (!res.ok) {
      const dados = await res.json().catch(() => ({}));
      erroEl.textContent = dados.error || 'Erro ao enviar.';
      btn.disabled = false;
      btn.textContent = 'Enviar';
      return;
    }
    fecharModal();
  });
}

// E-mail avulso de aniversário (ícone do Painel > Aniversariantes do mês) —
// mesmo molde do disparo individual de WhatsApp acima, mas com assunto +
// corpo (e-mail precisa dos dois) pré-preenchidos com o modelo
// 'aniversario_email' (crm_modelos_mensagem, editável em Configurações).
function abrirModalEmailAniversario(clienteId, nomeCliente, assuntoPadrao, corpoPadrao) {
  abrirModal(
    `<h3>E-mail de aniversário</h3><p class="modal-texto">${escapeHtml(nomeCliente || '')}</p>`,
    `
      <label for="email-aniversario-assunto">Assunto</label>
      <input type="text" id="email-aniversario-assunto" value="${escapeHtml(assuntoPadrao || '')}">
      <label for="email-aniversario-corpo">Mensagem</label>
      <textarea id="email-aniversario-corpo">${escapeHtml(corpoPadrao || '')}</textarea>
      <div class="modal-erro" id="email-aniversario-erro"></div>
      <div class="modal-acoes">
        <button type="button" class="ds-btn ds-btn-secundario" id="email-aniversario-cancelar">Cancelar</button>
        <button type="button" class="ds-btn ds-btn-primario" id="email-aniversario-enviar">Enviar</button>
      </div>
    `
  );
  document.getElementById('email-aniversario-cancelar').addEventListener('click', fecharModal);
  document.getElementById('email-aniversario-enviar').addEventListener('click', async () => {
    const assunto = document.getElementById('email-aniversario-assunto').value.trim();
    const corpo = document.getElementById('email-aniversario-corpo').value.trim();
    const erroEl = document.getElementById('email-aniversario-erro');
    if (!assunto || !corpo) { erroEl.textContent = 'Assunto e mensagem são obrigatórios.'; return; }
    const btn = document.getElementById('email-aniversario-enviar');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    const res = await apiFetch(`/crm/api/clientes/${clienteId}/email-aniversario`, {
      method: 'POST',
      body: JSON.stringify({ assunto, corpo }),
    });
    if (!res.ok) {
      const dados = await res.json().catch(() => ({}));
      erroEl.textContent = dados.error || 'Erro ao enviar.';
      btn.disabled = false;
      btn.textContent = 'Enviar';
      return;
    }
    fecharModal();
  });
}

// Disparo individual de WhatsApp pra aniversariante (ícone ⚡ do Painel >
// Aniversariantes do mês) — diferente de abrirModalDisparoIndividual
// (texto livre, usado por Pagamentos pendentes): aniversário é mensagem
// iniciada pela empresa fora da janela de 24h, a Meta só aceita com um
// modelo aprovado (pedido do Bruno, 2026-10-21). Busca os modelos aprovados
// em GET /crm/api/campanhas/canais (já filtra status === 'APPROVED') em vez
// de mandar texto livre.
async function abrirModalDisparoAniversario(clienteId, nomeCliente) {
  abrirModal(
    `<h3>Disparo de aniversário</h3><p class="modal-texto">${escapeHtml(nomeCliente || '')}</p>`,
    `
      <div class="modal-erro" id="disparo-aniv-erro"></div>
      <p class="modal-texto" id="disparo-aniv-carregando">Carregando modelos aprovados…</p>
      <div id="disparo-aniv-corpo" hidden></div>
    `
  );
  const res = await apiFetch('/crm/api/campanhas/canais');
  const corpoEl = document.getElementById('disparo-aniv-corpo');
  if (!corpoEl) return; // modal fechado antes da resposta chegar
  const carregandoEl = document.getElementById('disparo-aniv-carregando');
  const erroEl = document.getElementById('disparo-aniv-erro');

  if (!res.ok) { carregandoEl.remove(); erroEl.textContent = 'Não foi possível carregar os modelos agora.'; return; }
  const canais = await res.json();
  if (!canais.whatsapp.conectado) { carregandoEl.remove(); erroEl.textContent = 'Nenhum WhatsApp conectado — conecte em Configurações > WhatsApp.'; return; }
  const modelos = canais.whatsapp.modelos || [];
  if (!modelos.length) { carregandoEl.remove(); erroEl.textContent = 'Nenhum modelo aprovado pela Meta ainda.'; return; }

  carregandoEl.remove();
  corpoEl.hidden = false;
  corpoEl.innerHTML = `
    <label for="disparo-aniv-modelo">Modelo aprovado</label>
    <select id="disparo-aniv-modelo">${modelos.map((m) => `<option value="${escapeHtml(m.nome)}">${escapeHtml(m.nome)}</option>`).join('')}</select>
    <p class="modal-texto" id="disparo-aniv-preview"></p>
    <div class="modal-acoes">
      <button type="button" class="ds-btn ds-btn-secundario" id="disparo-aniv-cancelar">Cancelar</button>
      <button type="button" class="ds-btn ds-btn-primario" id="disparo-aniv-enviar">Enviar</button>
    </div>
  `;
  const selectEl = document.getElementById('disparo-aniv-modelo');
  const previewEl = document.getElementById('disparo-aniv-preview');
  const atualizarPreview = () => { previewEl.textContent = (modelos.find((m) => m.nome === selectEl.value) || {}).corpo || ''; };
  selectEl.addEventListener('change', atualizarPreview);
  atualizarPreview();

  document.getElementById('disparo-aniv-cancelar').addEventListener('click', fecharModal);
  document.getElementById('disparo-aniv-enviar').addEventListener('click', async () => {
    const btn = document.getElementById('disparo-aniv-enviar');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    const envio = await apiFetch(`/crm/api/clientes/${clienteId}/whatsapp-aniversario`, {
      method: 'POST',
      body: JSON.stringify({ templateNome: selectEl.value }),
    });
    if (!envio.ok) {
      const dados = await envio.json().catch(() => ({}));
      erroEl.textContent = dados.error || 'Erro ao enviar.';
      btn.disabled = false;
      btn.textContent = 'Enviar';
      return;
    }
    fecharModal();
  });
}
