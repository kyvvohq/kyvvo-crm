// Shell compartilhado das telas autenticadas — auth guard, cabeçalho (logo +
// menu de perfil + tema), sidebar de navegação e helpers de modal. Espera que
// a página já tenha no DOM: #painel-sidebar, #btn-toggle-sidebar,
// #topo-perfil, #topo-perfil-gatilho, #menu-perfil, elementos com classe
// .js-avatar-usuario/.js-nome-usuario/.js-email-usuario/.btn-sair/.toggle-tema.
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
};

function icon(name, size = 18) {
  const inner = ICON_PATHS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

document.querySelectorAll('[data-icon]').forEach((el) => {
  el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
});

// --- Sidebar colapsável ---
const painelSidebar = document.getElementById('painel-sidebar');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
function aplicarSidebarOculta(oculta) {
  painelSidebar.classList.toggle('sidebar-oculta', oculta);
  btnToggleSidebar.textContent = oculta ? '>' : '<';
  const rotulo = oculta ? 'Exibir menu' : 'Ocultar menu';
  btnToggleSidebar.setAttribute('aria-label', rotulo);
  btnToggleSidebar.title = rotulo;
}
aplicarSidebarOculta(localStorage.getItem('crm_sidebar_oculta') === '1');
btnToggleSidebar.addEventListener('click', () => {
  const oculta = !painelSidebar.classList.contains('sidebar-oculta');
  aplicarSidebarOculta(oculta);
  localStorage.setItem('crm_sidebar_oculta', oculta ? '1' : '0');
});

document.querySelectorAll('.menu-item[href]').forEach((item) => {
  if (item.getAttribute('href') === window.location.pathname) item.classList.add('active');
});

// --- Grupo colapsável do menu (Configurações > Automações etc.) ---
document.querySelectorAll('.ds-menu-sublink[href]').forEach((item) => {
  if (item.getAttribute('href') === window.location.pathname) item.classList.add('ds-menu-sublink-ativo');
});
document.querySelectorAll('.ds-menu-grupo-botao').forEach((botao) => {
  const grupo = botao.closest('.ds-menu-grupo');
  const jaTemAtivo = !!(grupo && grupo.querySelector('.ds-menu-sublink-ativo'));
  botao.setAttribute('aria-expanded', String(jaTemAtivo));
  botao.addEventListener('click', () => {
    botao.setAttribute('aria-expanded', String(botao.getAttribute('aria-expanded') !== 'true'));
  });
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

document.querySelectorAll('.btn-sair').forEach((btn) => {
  btn.addEventListener('click', () => {
    localStorage.removeItem('crm_token');
    localStorage.removeItem('crm_nome');
    window.location.href = '/crm/login.html';
  });
});

// --- Modal genérico (mesmo padrão do kyvvo-people) ---
function fecharModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', escFecharModal);
}
function escFecharModal(e) {
  if (e.key === 'Escape') fecharModal();
}
function abrirModal(tituloHtml, conteudoHtml, classeExtra) {
  fecharModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card${classeExtra ? ` ${classeExtra}` : ''}">
      <button class="modal-close" id="modal-close" aria-label="Fechar" type="button">${icon('x', 15)}</button>
      ${tituloHtml}
      ${conteudoHtml}
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('modal-close').addEventListener('click', fecharModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) fecharModal(); });
  document.addEventListener('keydown', escFecharModal);
  return overlay;
}
function avisar(titulo, mensagem) {
  abrirModal(
    `<h3>${titulo}</h3>`,
    `
      <p class="modal-texto">${mensagem}</p>
      <div class="modal-acoes">
        <button type="button" class="btn" id="btn-ok-aviso">OK</button>
      </div>
    `
  );
  document.getElementById('btn-ok-aviso').addEventListener('click', fecharModal);
}

// --- Helpers de formatação reaproveitados entre telas ---
function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function formatarData(iso) {
  return iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';
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
