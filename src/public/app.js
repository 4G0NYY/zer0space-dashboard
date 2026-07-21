'use strict';

// ================================================================
// Theme System
// ================================================================

const THEMES = {
  cyan:      { accent: '#0a84ff', accentBg: 'rgba(10,132,255,0.12)',  accentGlow: 'rgba(10,132,255,0.28)'  },
  himmel:    { accent: '#64d2ff', accentBg: 'rgba(100,210,255,0.12)', accentGlow: 'rgba(100,210,255,0.28)' },
  tuerkis:   { accent: '#00c7be', accentBg: 'rgba(0,199,190,0.12)',   accentGlow: 'rgba(0,199,190,0.28)'   },
  gruen:     { accent: '#32d74b', accentBg: 'rgba(50,215,75,0.12)',   accentGlow: 'rgba(50,215,75,0.28)'   },
  bernstein: { accent: '#ff9f0a', accentBg: 'rgba(255,159,10,0.12)',  accentGlow: 'rgba(255,159,10,0.28)'  },
  rot:       { accent: '#ff453a', accentBg: 'rgba(255,69,58,0.12)',   accentGlow: 'rgba(255,69,58,0.28)'   },
  magenta:   { accent: '#ff375f', accentBg: 'rgba(255,55,95,0.12)',   accentGlow: 'rgba(255,55,95,0.28)'   },
  violett:   { accent: '#bf5af2', accentBg: 'rgba(191,90,242,0.12)',  accentGlow: 'rgba(191,90,242,0.28)'  },
};

const THEME_MIGRATION = { amber: 'bernstein', green: 'gruen' };

let currentTheme = 'cyan';
let userRole     = 'viewer'; // set in init()
let selfUsername = '';       // set in init()
let csrfToken     = '';       // set in init(), required on every POST/PUT/DELETE
let vaultUnlocked = false;    // set in init(); false = session predates the vault key or a password was reset

// CSRF is enforced server-side on EVERY state-changing route, not just the vault
// (see auth.js). Rather than thread the header through the ~20 fetch calls in
// this file — and rely on every future one remembering — wrap fetch once and
// attach it to any same-origin request that is not a safe method.
//
// Only same-origin: the token must never be sent to a third party, and a
// relative URL is the only kind this app issues anyway.
(function patchFetchWithCsrf() {
  const nativeFetch = window.fetch.bind(window);
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

  window.fetch = (input, init = {}) => {
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input?.url || '';
    const sameOrigin = url.startsWith('/') || url.startsWith(window.location.origin);

    if (!SAFE.has(method) && sameOrigin && csrfToken) {
      const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
      if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrfToken);
      return nativeFetch(input, { ...init, method, headers });
    }
    return nativeFetch(input, init);
  };
})();

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function resolveTheme(nameOrHex) {
  return THEME_MIGRATION[nameOrHex] || nameOrHex;
}

function applyTheme(nameOrHex) {
  nameOrHex = resolveTheme(nameOrHex);
  let accent, accentBg, accentGlow;
  if (nameOrHex.startsWith('#')) {
    accent = nameOrHex; accentBg = hexToRgba(nameOrHex, 0.12); accentGlow = hexToRgba(nameOrHex, 0.28);
  } else {
    const t = THEMES[nameOrHex] || THEMES.cyan;
    accent = t.accent; accentBg = t.accentBg; accentGlow = t.accentGlow;
  }
  const root = document.documentElement;
  root.style.setProperty('--accent',      accent);
  root.style.setProperty('--accent-bg',   accentBg);
  root.style.setProperty('--accent-glow', accentGlow);
  currentTheme = nameOrHex;
  document.querySelectorAll('.theme-swatch').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === nameOrHex);
  });
  const picker = document.getElementById('accentPicker');
  const hexIn  = document.getElementById('accentHex');
  if (picker) picker.value = accent.slice(0,7);
  if (hexIn)  hexIn.value  = accent;
  if (typeof window.updateBgAccent === 'function') window.updateBgAccent(accent);
}

async function saveTheme(nameOrHex) {
  document.documentElement.style.setProperty('--t', '0.4s');
  applyTheme(nameOrHex);
  setTimeout(() => document.documentElement.style.setProperty('--t', '0.2s'), 450);
  const resolved = resolveTheme(nameOrHex);
  // All users save own preference
  await fetch('/api/user/theme', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: resolved }),
  }).catch(() => {});
  // Admins also update global default (for users without a personal preference)
  if (userRole === 'admin') {
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'theme', value: resolved }),
    }).catch(() => {});
  }
}

document.querySelectorAll('.theme-swatch').forEach(el => {
  el.addEventListener('click', () => saveTheme(el.dataset.theme));
});

const accentPicker = document.getElementById('accentPicker');
accentPicker.addEventListener('input', e => applyTheme(e.target.value));
accentPicker.addEventListener('change', e => saveTheme(e.target.value));

const accentHex = document.getElementById('accentHex');
accentHex.addEventListener('keydown', e => { if (e.key === 'Enter') commitHexInput(); });
accentHex.addEventListener('blur', commitHexInput);
function commitHexInput() {
  let hex = accentHex.value.trim();
  if (!hex.startsWith('#')) hex = '#' + hex;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) saveTheme(hex);
  else accentHex.value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
}

// ================================================================
// Generative Background Canvas (replaceable layer)
// ================================================================

(function initBackground() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, stars = [], particles = [];
  let accentRgb = [10, 132, 255];

  const hexToRgb = hex => {
    const h = hex.replace('#','');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  };

  const resize = () => { W = canvas.width = innerWidth; H = canvas.height = innerHeight; buildStars(); };

  const buildStars = () => { stars = Array.from({length:200}, () => ({
    x: Math.random()*W, y: Math.random()*H,
    r: Math.random()*1.3+0.2, a: Math.random()*0.55+0.15,
    twinkle: Math.random()*Math.PI*2, speed: Math.random()*0.5+0.2,
  })); };

  const buildParticles = () => { particles = Array.from({length:55}, () => ({
    x: Math.random()*W, y: Math.random()*H,
    vx: (Math.random()-0.5)*0.25, vy: -(Math.random()*0.25+0.05),
    r: Math.random()*1.6+0.4, a: Math.random()*0.35+0.08, phase: Math.random()*Math.PI*2,
  })); };

  function drawPlanet() {
    const cx=W*0.81, cy=H*0.17, r=Math.min(W,H)*0.125, [pr,pg,pb]=accentRgb;
    const glow=ctx.createRadialGradient(cx,cy,r*0.85,cx,cy,r*2.2);
    glow.addColorStop(0,`rgba(${pr},${pg},${pb},0.07)`); glow.addColorStop(1,'transparent');
    ctx.beginPath(); ctx.arc(cx,cy,r*2.2,0,Math.PI*2); ctx.fillStyle=glow; ctx.fill();
    const body=ctx.createRadialGradient(cx-r*0.28,cy-r*0.28,r*0.05,cx,cy,r);
    body.addColorStop(0,'#1e1e36'); body.addColorStop(0.55,'#0e0e1e'); body.addColorStop(1,'#040408');
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle=body; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.clip();
    for(let i=-3;i<=3;i++){const y=cy+i*r*0.27,bend=r*0.03*Math.sign(i); ctx.beginPath(); ctx.moveTo(cx-r,y); ctx.quadraticCurveTo(cx,y+bend,cx+r,y); ctx.strokeStyle='rgba(255,255,255,0.022)'; ctx.lineWidth=1; ctx.stroke();}
    const term=ctx.createLinearGradient(cx-r,cy,cx+r*0.5,cy);
    term.addColorStop(0,'rgba(0,0,0,0.55)'); term.addColorStop(0.6,'rgba(0,0,0,0)');
    ctx.fillStyle=term; ctx.fillRect(cx-r,cy-r,r*2,r*2); ctx.restore();
    const atm=ctx.createRadialGradient(cx,cy,r-2,cx,cy,r+7);
    atm.addColorStop(0,`rgba(${pr},${pg},${pb},0.18)`); atm.addColorStop(1,'transparent');
    ctx.beginPath(); ctx.arc(cx,cy,r+7,0,Math.PI*2); ctx.fillStyle=atm; ctx.fill();
  }

  function drawFrame() {
    const m=26,cr=30,len=56; ctx.strokeStyle='rgba(255,255,255,0.055)'; ctx.lineWidth=1.5; ctx.lineCap='square';
    [[m,m+len,m,m+cr,m+cr,m,m+len,m],[W-m-len,m,W-m-cr,m,W-m,m+cr,W-m,m+len],
     [m,H-m-len,m,H-m-cr,m+cr,H-m,m+len,H-m],[W-m-len,H-m,W-m-cr,H-m,W-m,H-m-cr,W-m,H-m-len]
    ].forEach(([x1,y1,x2,y2,x3,y3,x4,y4])=>{ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.arcTo(x2+(x3-x2),y2,x3,y3,cr);ctx.lineTo(x4,y4);ctx.stroke();});
  }

  function drawSilhouette() {
    const sc=Math.min(W,H)/900, bx=W*0.09, by=H+30;
    ctx.save(); ctx.fillStyle='rgba(2,2,8,0.82)'; ctx.strokeStyle='rgba(2,2,8,0.82)'; ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.beginPath(); ctx.roundRect(bx-55*sc,by-145*sc,110*sc,16*sc,4*sc); ctx.fill();
    ctx.beginPath(); ctx.roundRect(bx-50*sc,by-285*sc,100*sc,145*sc,6*sc); ctx.fill();
    ctx.beginPath(); ctx.ellipse(bx+6*sc,by-218*sc,26*sc,38*sc,0.1,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(bx+10*sc,by-270*sc,19*sc,21*sc,0.07,0,Math.PI*2); ctx.fill();
    ctx.lineWidth=13*sc; ctx.beginPath(); ctx.moveTo(bx+28*sc,by-215*sc); ctx.quadraticCurveTo(bx+85*sc,by-212*sc,bx+95*sc,by-192*sc); ctx.stroke();
    ctx.lineWidth=11*sc; ctx.beginPath(); ctx.moveTo(bx-22*sc,by-215*sc); ctx.quadraticCurveTo(bx-52*sc,by-188*sc,bx-50*sc,by-158*sc); ctx.stroke();
    ctx.fillStyle='rgba(2,2,8,0.78)';
    ctx.beginPath(); ctx.ellipse(bx+20*sc,by-112*sc,13*sc,28*sc,0.08,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(bx-14*sc,by-112*sc,13*sc,28*sc,-0.08,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  let raf;
  function draw(t) {
    ctx.clearRect(0,0,W,H);
    stars.forEach(s=>{const tw=0.7+0.3*Math.sin(t*0.0008*s.speed+s.twinkle); ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2); ctx.fillStyle=`rgba(255,255,255,${s.a*tw})`; ctx.fill();});
    drawPlanet(); drawFrame(); drawSilhouette();
    const [pr,pg,pb]=accentRgb;
    particles.forEach(p=>{
      p.x+=p.vx; p.y+=p.vy;
      if(p.y<-6){p.y=H+6;p.x=Math.random()*W;} if(p.x<0)p.x=W; if(p.x>W)p.x=0;
      const pulse=0.5+0.5*Math.sin(t*0.0015+p.phase);
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fillStyle=`rgba(${pr},${pg},${pb},${p.a*pulse})`; ctx.fill();
    });
    raf = requestAnimationFrame(draw);
  }

  window.updateBgAccent = hex => { accentRgb = hexToRgb(hex); };
  window.addEventListener('resize', resize);
  resize(); buildParticles();
  raf = requestAnimationFrame(draw);
})();

// ================================================================
// Background Mode
// ================================================================

const bgCanvas  = document.getElementById('bg-canvas');
const bgImage   = document.getElementById('bg-image');

function applyBgMode(mode, skipSave) {
  const isImage = mode === 'image';
  bgCanvas.style.opacity = isImage ? '0' : '1';
  bgImage.classList.toggle('visible', isImage);
  document.querySelectorAll('.bg-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  const uploadSection = document.getElementById('bgUploadSection');
  if (uploadSection) uploadSection.classList.toggle('visible', isImage);
  if (!skipSave) {
    fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'bg_mode', value: mode }),
    }).catch(() => {});
  }
}

document.querySelectorAll('.bg-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => applyBgMode(btn.dataset.mode));
});

// Upload
const bgDropZone   = document.getElementById('bgDropZone');
const bgFileInput  = document.getElementById('bgFileInput');
const bgPreview    = document.getElementById('bgPreview');
const bgPreviewImg = document.getElementById('bgPreviewImg');
const bgMsg        = document.getElementById('bgMsg');

document.getElementById('bgBrowseBtn').addEventListener('click', () => bgFileInput.click());
bgFileInput.addEventListener('change', e => { if (e.target.files[0]) uploadBackground(e.target.files[0]); });
bgDropZone.addEventListener('dragover', e => { e.preventDefault(); bgDropZone.classList.add('dragging'); });
bgDropZone.addEventListener('dragleave', () => bgDropZone.classList.remove('dragging'));
bgDropZone.addEventListener('drop', e => {
  e.preventDefault(); bgDropZone.classList.remove('dragging');
  if (e.dataTransfer.files[0]) uploadBackground(e.dataTransfer.files[0]);
});

async function uploadBackground(file) {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) {
    showBgMsg(t('bg.badType'), 'error'); return;
  }
  if (file.size > 10*1024*1024) { showBgMsg(t('bg.maxSize'), 'error'); return; }
  const form = new FormData(); form.append('image', file);
  const res = await fetch('/api/background', { method: 'POST', body: form });
  if (!res.ok) { const d=await res.json().catch(()=>({})); showBgMsg(I18N.tError(d,'bg.uploadFailed'),'error'); return; }
  bgPreviewImg.src = URL.createObjectURL(file);
  bgDropZone.style.display = 'none'; bgPreview.classList.add('visible');
  bgImage.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.44),rgba(0,0,0,0.44)),url('/api/background?t=${Date.now()}')`;
  applyBgMode('image', true);
  showBgMsg(t('bg.saved'), 'ok');
}

document.getElementById('bgRemoveBtn').addEventListener('click', async () => {
  await fetch('/api/background', { method: 'DELETE' }).catch(() => {});
  bgImage.style.backgroundImage = '';
  bgPreview.classList.remove('visible'); bgDropZone.style.display = '';
  applyBgMode('generativ'); showBgMsg(t('bg.removed'), 'ok');
});

function showBgMsg(text, type) {
  bgMsg.textContent = text; bgMsg.className = `settings-msg ${type}`;
  setTimeout(() => { bgMsg.textContent=''; bgMsg.className='settings-msg'; }, 4000);
}

// ================================================================
// View Switching
// ================================================================

let currentView = 'home';

function switchView(name) {
  if (name === currentView) return;
  document.getElementById('searchBarWrap').style.display = name === 'home' ? '' : 'none';
  const oldEl = document.getElementById(`view-${currentView}`);
  const newEl = document.getElementById(`view-${name}`);
  if (!newEl) return;
  const leavingVault = currentView === 'vault';
  if (oldEl) {
    oldEl.classList.add('exiting'); oldEl.classList.remove('active');
    setTimeout(() => oldEl.classList.remove('exiting'), 220);
  }
  newEl.classList.add('active');
  currentView = name;
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === name);
  });
  if (window.innerWidth <= 860) document.getElementById('sidebar').classList.remove('open');
  if (name === 'einstellungen' && userRole === 'admin') { loadUsers(); loadInvites(); }
  if (name === 'vault') loadVault();
  // Decrypted vault values shouldn't sit in JS/DOM memory longer than the
  // user is actually looking at the Vault view.
  if (leavingVault) clearVaultMemory();
}

document.querySelectorAll('.nav-item[data-view]').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); switchView(el.dataset.view); });
});

// Greeting is set in init() below, using the verified session username.

// ================================================================
// Cluster Status
// ================================================================

// Briefly pulses a status value when its displayed text actually changes,
// so live updates (metrics polling, backup refresh) feel alive instead of
// silently overwriting the number.
function setTextAnimated(el, text) {
  if (!el || el.textContent === String(text)) return;
  el.textContent = text;
  el.classList.remove('value-pulse');
  void el.offsetWidth; // restart animation
  el.classList.add('value-pulse');
}

async function loadStatus() {
  try {
    const d = await fetch('/api/status').then(r=>r.json());
    setTextAnimated(document.getElementById('servicesActive'), d.servicesActive ?? '?');
    // nodesOnline is overwritten by loadMetrics() once available; set fallback here
    const nodesEl = document.getElementById('nodesOnline');
    if (!nodesEl.dataset.live) setTextAnimated(nodesEl, d.nodesOnline ?? '?');
    const el = document.getElementById('clusterHealth');
    if (!el.dataset.live) {
      const healthy = (d.nodesOnline??0) > 0;
      setTextAnimated(el, healthy ? t('home.healthy') : t('home.checking')); el.style.color = healthy?'var(--green)':'var(--red)';
    }
  } catch {
    document.getElementById('servicesActive').textContent = '?';
    const nodesEl = document.getElementById('nodesOnline');
    if (!nodesEl.dataset.live) nodesEl.textContent = '?';
  }
}

// ================================================================
// Node Metrics (Glances)
// ================================================================

const GAUGE_C = (2 * Math.PI * 24).toFixed(2); // circumference r=24 → 150.80

function fmtBytes(b, d=1) {
  if (b == null || isNaN(b)) return '—';
  if (b < 1024)       return `${b} B`;
  if (b < 1024**2)    return `${(b/1024).toFixed(d)} KB`;
  if (b < 1024**3)    return `${(b/1024**2).toFixed(d)} MB`;
  return `${(b/1024**3).toFixed(d)} GB`;
}

function fmtRate(bps) { return bps == null || isNaN(bps) ? '—' : fmtBytes(bps) + '/s'; }

function gaugeOffset(pct) {
  return (GAUGE_C * (1 - Math.min(100, Math.max(0, pct ?? 0)) / 100)).toFixed(2);
}

function fillCls(pct) {
  return pct >= 85 ? 'crit' : pct >= 70 ? 'warn' : '';
}

function nodeCardHtml(node) {
  // Free text from EXTRA_HOSTS ("Stateful", "Storage"). Escaped like any other
  // value — it reaches here from an environment variable, not from a literal.
  const badge = node.label
    ? `<span class="node-badge">${esc(node.label)}</span>`
    : '';

  if (!node.online) {
    return `
      <div class="node-header">
        <span class="node-name">${esc(node.hostname)}</span>
        ${badge}
        <span class="dot dot-red"></span>
      </div>
      <div class="node-offline-msg">${esc(t('home.unreachable'))}</div>`;
  }

  const cpu     = node.cpu ?? 0;
  const memPct  = node.mem?.percent ?? 0;
  const diskPct = node.disk?.percent ?? 0;

  return `
    <div class="node-header">
      <span class="node-name">${esc(node.hostname)}</span>
      ${badge}
      <span class="dot dot-green"></span>
    </div>
    <div class="node-body">
      <div class="cpu-row">
        <div class="gauge-wrap">
          <svg class="gauge-svg" viewBox="0 0 60 60" aria-hidden="true">
            <circle class="gauge-circle-bg"   cx="30" cy="30" r="24"/>
            <circle class="gauge-circle-fill ${fillCls(cpu)}" cx="30" cy="30" r="24"
              stroke-dasharray="${GAUGE_C}" stroke-dashoffset="${gaugeOffset(cpu)}"
              transform="rotate(-90 30 30)"/>
          </svg>
          <div class="gauge-label">
            <span class="gauge-pct">${Math.round(cpu)}%</span>
            <span class="gauge-name">CPU</span>
          </div>
        </div>
      </div>
      <div class="metric-row">
        <span class="metric-label">RAM</span>
        <div class="metric-bar"><div class="metric-fill ${fillCls(memPct)}" style="width:${Math.min(100,memPct).toFixed(1)}%"></div></div>
        <span class="metric-val">${fmtBytes(node.mem?.used,1)} / ${fmtBytes(node.mem?.total,0)}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Disk</span>
        <div class="metric-bar"><div class="metric-fill ${fillCls(diskPct)}" style="width:${Math.min(100,diskPct).toFixed(1)}%"></div></div>
        <span class="metric-val">${fmtBytes(node.disk?.used,1)} / ${fmtBytes(node.disk?.total,0)}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Net</span>
        <div class="metric-net">
          <span class="net-rx">↓ ${fmtRate(node.net?.rx_rate)}</span>&nbsp;&nbsp;<span class="net-tx">↑ ${fmtRate(node.net?.tx_rate)}</span>
        </div>
      </div>
    </div>`;
}

// Updates values in-place on an already-rendered (online) node card, instead
// of replacing the DOM, so the existing CSS transitions on the gauge and the
// metric bars actually animate between the old and new reading each poll.
function updateNodeMetrics(card, node) {
  const cpu     = node.cpu ?? 0;
  const memPct  = node.mem?.percent ?? 0;
  const diskPct = node.disk?.percent ?? 0;

  const gaugeFill = card.querySelector('.gauge-circle-fill');
  if (gaugeFill) {
    gaugeFill.setAttribute('stroke-dashoffset', gaugeOffset(cpu));
    gaugeFill.setAttribute('class', `gauge-circle-fill ${fillCls(cpu)}`);
  }
  const gaugePct = card.querySelector('.gauge-pct');
  if (gaugePct) gaugePct.textContent = `${Math.round(cpu)}%`;

  const rows = card.querySelectorAll('.metric-row'); // [0]=RAM [1]=Disk [2]=Net — see nodeCardHtml
  const applyBar = (row, pct, valueText) => {
    if (!row) return;
    const fill = row.querySelector('.metric-fill');
    if (fill) { fill.style.width = `${Math.min(100, pct).toFixed(1)}%`; fill.className = `metric-fill ${fillCls(pct)}`; }
    const val = row.querySelector('.metric-val');
    if (val) val.textContent = valueText;
  };
  applyBar(rows[0], memPct,  `${fmtBytes(node.mem?.used,1)} / ${fmtBytes(node.mem?.total,0)}`);
  applyBar(rows[1], diskPct, `${fmtBytes(node.disk?.used,1)} / ${fmtBytes(node.disk?.total,0)}`);

  const netRx = rows[2]?.querySelector('.net-rx');
  const netTx = rows[2]?.querySelector('.net-tx');
  if (netRx) netRx.textContent = `↓ ${fmtRate(node.net?.rx_rate)}`;
  if (netTx) netTx.textContent = `↑ ${fmtRate(node.net?.tx_rate)}`;
}

async function loadMetrics() {
  let data;
  try { data = await fetch('/api/metrics').then(r => r.json()); } catch { return; }
  // Standalone hosts are rendered FIRST and unconditionally. They do not come
  // from the Docker proxy, so they are still reported when the Swarm side has
  // failed and `nodes` comes back empty — which is exactly the moment the
  // database and storage hosts matter most.
  renderExtraHosts(data?.extraHosts);

  const nodes = data?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return;

  // Update status kacheln with live data from Glances
  const online = nodes.filter(n => n.online).length;
  const total  = nodes.length;
  const nodesEl = document.getElementById('nodesOnline');
  setTextAnimated(nodesEl, `${online}/${total}`);
  nodesEl.dataset.live = '1';
  const healthEl = document.getElementById('clusterHealth');
  healthEl.dataset.live = '1';
  setTextAnimated(healthEl, online === total ? 'Gesund' : online > 0 ? 'Warnung' : 'Offline');
  healthEl.style.color  = online === total ? 'var(--green)' : online > 0 ? 'var(--amber,#ff9f0a)' : 'var(--red)';

  // Build / update node cards
  const grid = document.getElementById('nodeGrid');
  if (!grid) return;

  // On first load: replace skeletons
  if (grid.querySelector('.node-skeleton')) grid.innerHTML = '';

  renderHostCards(grid, nodes, 'node');
}

// Shared by the Swarm grid and the standalone grid. `prefix` keeps the element
// ids from colliding — a Swarm node and a standalone host could in principle
// carry the same hostname, and two elements with one id would make the second
// card silently update the first.
function renderHostCards(grid, hosts, prefix) {
  hosts.forEach(host => {
    const id = `${prefix}-${host.hostname.replace(/[^a-zA-Z0-9-]/g, '-')}`;
    let card = document.getElementById(id);
    const wasOnline = card?.dataset.online === '1';
    if (!card) {
      card = document.createElement('div');
      card.id = id;
      grid.appendChild(card);
    }
    if (wasOnline && host.online) {
      // Same online state as last poll — update values in place so gauge/bar
      // transitions animate instead of popping to the new reading instantly.
      updateNodeMetrics(card, host);
    } else {
      const extra = prefix === 'infra' ? ' node-card-infra' : '';
      card.className = `node-card${extra}${host.online ? '' : ' offline'}`;
      card.innerHTML = nodeCardHtml(host);
      card.dataset.online = host.online ? '1' : '0';
    }
  });
}

// Standalone hosts are deliberately NOT folded into the nodes count above: they
// are not Swarm members, and counting them would turn "nodes online" into a
// number that no longer describes the cluster.
function renderExtraHosts(extraHosts) {
  const grid   = document.getElementById('infraGrid');
  const header = document.getElementById('infraHeader');
  const card   = document.getElementById('infraCard');
  if (!grid || !header || !card) return;

  // No EXTRA_HOSTS configured — leave the section out entirely rather than
  // showing an empty heading.
  if (!Array.isArray(extraHosts) || extraHosts.length === 0) {
    grid.hidden = header.hidden = card.hidden = true;
    return;
  }
  grid.hidden = header.hidden = card.hidden = false;

  const online = extraHosts.filter(h => h.online).length;
  const el = document.getElementById('infraOnline');
  setTextAnimated(el, `${online}/${extraHosts.length}`);
  el.style.color = online === extraHosts.length ? '' : online > 0 ? 'var(--amber,#ff9f0a)' : 'var(--red)';

  renderHostCards(grid, extraHosts, 'infra');
}

// ================================================================
// Services
// ================================================================

const servicesGrid = document.getElementById('servicesGrid');
let services = [];

async function loadServices() {
  services = await fetch('/api/services').then(r=>r.json());
  renderGrid(services);
}

function renderGrid(list) {
  servicesGrid.innerHTML = '';
  list.forEach((s,i) => { const c=buildCard(s); c.style.animationDelay=`${i*0.04}s`; servicesGrid.appendChild(c); });
  servicesGrid.appendChild(buildAddCard());
}

function buildCard(s) {
  const el = document.createElement('div');
  el.className = 'service-card';
  const dotClass = s.status==='running'?'dot-green':(s.status==='stopped'||s.status==='error')?'dot-red':'dot-gray';
  el.innerHTML = `
    <div class="card-actions">
      <button class="card-edit" aria-label="${esc(t('svc.editAria', { name: s.name }))}"><i class="ti ti-pencil"></i></button>
      <button class="card-delete" aria-label="${esc(t('svc.removeAria', { name: s.name }))}"><i class="ti ti-trash"></i></button>
    </div>
    <div class="card-icon"><i class="ti ti-${esc(s.icon||'layout-dashboard')}"></i></div>
    <div>
      <div class="card-row"><span class="card-name">${esc(s.name)}</span><span class="dot ${dotClass}"></span></div>
      ${s.description?`<p class="card-desc">${esc(s.description)}</p>`:''}
    </div>`;
  if (s.url) {
    el.style.cursor='pointer';
    el.addEventListener('click', e=>{ if(!e.target.closest('.card-actions')) window.open(s.url,'_blank','noopener'); });
  }
  el.querySelector('.card-edit').addEventListener('click', e=>{
    e.stopPropagation();
    openModal(s);
  });
  el.querySelector('.card-delete').addEventListener('click', async e=>{
    e.stopPropagation();
    if(!confirm(t('common.confirmRemove', { name: s.name }))) return;
    await fetch(`/api/services/${s.id}`,{method:'DELETE'}); loadServices();
  });
  return el;
}

function buildAddCard() {
  const el = document.createElement('div');
  el.className='service-card add-card'; el.style.cursor='pointer';
  // Was a hardcoded German literal — this card is rebuilt on every language
  // change, so it stayed German in the English UI.
  el.innerHTML=`<div class="card-icon"><i class="ti ti-plus"></i></div><span class="card-name">${esc(t('svc.add'))}</span>`;
  el.addEventListener('click', () => openModal());
  return el;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ================================================================
// Search
// ================================================================

document.getElementById('searchInput').addEventListener('input', e=>{
  const q=e.target.value.toLowerCase();
  renderGrid(q?services.filter(s=>s.name.toLowerCase().includes(q)||(s.description||'').toLowerCase().includes(q)):services);
});

// ================================================================
// Sidebar
// ================================================================

document.getElementById('sidebarToggle').addEventListener('click', ()=>{
  document.getElementById('sidebar').classList.toggle('collapsed');
});
document.getElementById('mobileSidebarToggle').addEventListener('click', ()=>{
  document.getElementById('sidebar').classList.toggle('open');
});

// ================================================================
// Modal
// ================================================================

const modalOverlay   = document.getElementById('modalOverlay');
const addServiceForm = document.getElementById('addServiceForm');
let editingServiceId = null;

// Same modal for add + edit. Called with no args → add mode; with a service
// object (from the card's pencil icon) → edit mode, form pre-filled.
function openModal(service) {
  editingServiceId = service ? service.id : null;
  document.getElementById('serviceModalTitle').textContent = service ? t('svc.edit') : t('svc.add');
  document.getElementById('serviceSaveBtn').textContent    = service ? t('svc.submitSave') : t('svc.submitAdd');
  document.getElementById('f-name').value = service ? service.name        : '';
  document.getElementById('f-desc').value = service ? service.description : '';
  document.getElementById('f-url').value  = service ? service.url         : '';
  document.getElementById('f-icon').value = service ? service.icon        : '';
  modalOverlay.classList.add('open');
  document.getElementById('f-name').focus();
}
function closeModal() {
  modalOverlay.classList.remove('open');
  addServiceForm.reset();
  editingServiceId = null;
}

document.getElementById('modalClose').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e=>{ if(e.target===modalOverlay) closeModal(); });
document.addEventListener('keydown', e=>{
  if (e.key!=='Escape') return;
  closeModal();
  if (typeof closeVaultModal === 'function') closeVaultModal();
});

addServiceForm.addEventListener('submit', async e=>{
  e.preventDefault();
  const body = Object.fromEntries(new FormData(addServiceForm));
  if (!body.name?.trim()) return;
  const url    = editingServiceId ? `/api/services/${editingServiceId}` : '/api/services';
  const method = editingServiceId ? 'PUT' : 'POST';
  await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  closeModal(); loadServices();
});

// ================================================================
// Change Password
// ================================================================

document.getElementById('changePasswordForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const form=e.target;
  const currentPassword=form.currentPassword.value, newPassword=form.newPassword.value, confirmPassword=form.confirmPassword.value;
  const btn=document.getElementById('cpSubmitBtn'), msg=document.getElementById('cpMsg');
  msg.textContent=''; msg.className='settings-msg';
  if(newPassword!==confirmPassword){msg.textContent=t('settings.pwMismatch');msg.className='settings-msg error';return;}
  if(newPassword.length<12){msg.textContent=t('users.pwMin12');msg.className='settings-msg error';return;}
  btn.disabled=true; btn.textContent='…';
  try {
    const res=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword,newPassword})});
    const data=await res.json().catch(()=>({}));
    if(res.ok){msg.textContent=t('settings.pwChanged');msg.className='settings-msg ok';form.reset();}
    else{msg.textContent=I18N.tError(data);msg.className='settings-msg error';}
  } catch { msg.textContent=t('common.serverUnreachable'); msg.className='settings-msg error'; }
  btn.disabled=false; btn.textContent=t('settings.savePassword');
});

// ================================================================
// User Management (admin only)
// ================================================================

async function loadUsers() {
  const users = await fetch('/api/users').then(r=>r.json()).catch(()=>[]);
  const list = document.getElementById('userList');
  list.innerHTML = '';
  users.forEach(u => list.appendChild(buildUserRow(u)));
}

function buildUserRow(u) {
  const isSelf = u.username === selfUsername;
  const row = document.createElement('div');
  row.className='user-row'; row.id=`user-row-${u.id}`;
  row.innerHTML=`
    <span class="user-row-name">${esc(u.username)}${isSelf?`<span class="you-badge">${esc(t('users.you'))}</span>`:''}</span>
    <span class="role-badge ${u.role}">${u.role}</span>
    ${u.locked_until?`<span class="lock-badge" title="${esc(t('users.locked'))}"><i class="ti ti-lock"></i> ${esc(t('users.locked'))}</span>`:''}
    <div class="user-row-actions">
      ${u.locked_until?`<button class="btn-sm btn-sm-accent" data-id="${u.id}" data-action="unlock-user">${esc(t('users.unlock'))}</button>`:''}
      <button class="btn-sm btn-sm-accent" data-id="${u.id}" data-action="toggle-reset">${esc(t('users.resetPassword'))}</button>
      <button class="btn-sm" data-id="${u.id}" data-action="toggle-role">${u.role==='admin'?'→ Viewer':'→ Admin'}</button>
      <button class="btn-sm btn-sm-danger" data-id="${u.id}" data-action="delete-user"${isSelf?` disabled title="${esc(t('users.cannotDeleteSelf'))}"`:''}>${esc(t('common.delete'))}</button>
    </div>
    <div class="user-reset-form" id="reset-form-${u.id}" style="display:none">
      <input type="password" class="reset-pw-input" placeholder="${esc(t('users.newPasswordPlaceholder'))}">
      <button class="btn-sm btn-sm-accent" data-id="${u.id}" data-action="confirm-reset">${esc(t('common.apply'))}</button>
      <button class="btn-sm" data-id="${u.id}" data-action="cancel-reset">${esc(t('common.cancel'))}</button>
    </div>`;
  return row;
}

document.getElementById('userList').addEventListener('click', async e=>{
  const btn=e.target.closest('[data-action]'); if(!btn) return;
  const id=Number(btn.dataset.id), action=btn.dataset.action;

  if (action==='toggle-reset') {
    const f=document.getElementById(`reset-form-${id}`);
    f.style.display = f.style.display==='none'?'':'none';
    if(f.style.display!=='none') f.querySelector('.reset-pw-input').focus();
  }
  if (action==='cancel-reset') {
    document.getElementById(`reset-form-${id}`).style.display='none';
  }
  if (action==='confirm-reset') {
    const f=document.getElementById(`reset-form-${id}`);
    const pw=f.querySelector('.reset-pw-input').value;
    if(!pw||pw.length<12){alert(t('users.pwMin12'));return;}
    btn.disabled=true;
    const res=await fetch(`/api/users/${id}/password`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
    btn.disabled=false;
    if(res.ok){f.style.display='none';f.querySelector('.reset-pw-input').value='';}
    else{const d=await res.json().catch(()=>({}));alert(I18N.tError(d));}
  }
  if (action==='toggle-role') {
    const badge=document.getElementById(`user-row-${id}`).querySelector('.role-badge');
    const newRole=badge.textContent==='admin'?'viewer':'admin';
    if(!confirm(t('users.confirmRole', { role: newRole }))) return;
    btn.disabled=true;
    const res=await fetch(`/api/users/${id}/role`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:newRole})});
    btn.disabled=false;
    if(res.ok) loadUsers();
    else{const d=await res.json().catch(()=>({}));alert(I18N.tError(d));}
  }
  if (action==='delete-user') {
    if(!confirm(t('users.confirmDelete'))) return;
    btn.disabled=true;
    const res=await fetch(`/api/users/${id}`,{method:'DELETE'});
    btn.disabled=false;
    if(res.ok) loadUsers();
    else{const d=await res.json().catch(()=>({}));alert(I18N.tError(d));}
  }
  if (action==='unlock-user') {
    btn.disabled=true;
    const res=await fetch(`/api/users/${id}/unlock`,{method:'POST'});
    btn.disabled=false;
    if(res.ok) loadUsers();
    else{const d=await res.json().catch(()=>({}));alert(I18N.tError(d));}
  }
});

// ================================================================
// Invitations (admin only)
// ================================================================
//
// After setup, an invite is the only route to a new account. The admin never
// sets the invitee's password — that is the point: a password only its owner has
// ever seen is one the admin cannot leak, and the vault key derived from it is
// one the admin can never reconstruct.

async function loadInvites() {
  const invites = await fetch('/api/invites').then(r=>r.json()).catch(()=>[]);
  const list = document.getElementById('inviteList');
  list.innerHTML = '';
  if (!invites.length) {
    list.innerHTML = `<p class="settings-hint">${esc(t('invites.none'))}</p>`;
    return;
  }
  invites.forEach(inv => list.appendChild(buildInviteRow(inv)));
}

function inviteLink(code) {
  return `${window.location.origin}/register?code=${code}`;
}

function buildInviteRow(inv) {
  const row = document.createElement('div');
  row.className = `invite-row invite-${inv.status}`;
  row.id = `invite-row-${inv.id}`;

  const when = new Date(inv.status === 'used' ? inv.used_at : inv.expires_at)
    .toLocaleDateString(t('locale'), { day: '2-digit', month: 'short', year: 'numeric' });

  const detail = inv.status === 'used'
    ? esc(t('invites.usedBy', { name: inv.used_by_name || '—' }))
    : `${esc(t('invites.expires'))} ${esc(when)}`;

  // The full code is shown only while it can still be redeemed. Once used or
  // expired it is dead weight, and printing it forever is a habit worth not
  // forming.
  const codeCell = inv.status === 'active'
    ? `<code class="invite-code">${esc(inv.code)}</code>`
    : `<code class="invite-code invite-code-spent">${esc(inv.code.slice(0, 8))}…</code>`;

  row.innerHTML = `
    ${codeCell}
    <span class="invite-status invite-status-${inv.status}">${esc(t(`invites.status.${inv.status}`))}</span>
    <span class="role-badge ${inv.max_role}">${esc(inv.max_role)}</span>
    <span class="invite-detail">${detail}</span>
    <div class="invite-actions">
      ${inv.status === 'active' ? `
        <button class="btn-sm btn-sm-accent" data-id="${inv.id}" data-code="${esc(inv.code)}" data-action="copy-invite">${esc(t('invites.copy'))}</button>
        <button class="btn-sm btn-sm-danger" data-id="${inv.id}" data-action="revoke-invite">${esc(t('invites.revoke'))}</button>
      ` : ''}
    </div>`;
  return row;
}

document.getElementById('inviteList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]'); if (!btn) return;
  const id = Number(btn.dataset.id), action = btn.dataset.action;

  if (action === 'copy-invite') {
    try {
      await navigator.clipboard.writeText(inviteLink(btn.dataset.code));
      const original = btn.textContent;
      btn.textContent = t('invites.copied');
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch {
      // Clipboard access needs a secure context; on plain HTTP over the LAN it
      // is simply unavailable, so fall back to showing the link to copy by hand.
      prompt(t('invites.copy'), inviteLink(btn.dataset.code));
    }
  }

  if (action === 'revoke-invite') {
    if (!confirm(t('invites.revokeConfirm'))) return;
    btn.disabled = true;
    const res = await fetch(`/api/invite/${id}`, { method: 'DELETE' });
    btn.disabled = false;
    if (res.ok) loadInvites();
    else { const d = await res.json().catch(() => ({})); alert(I18N.tError(d)); }
  }
});

document.getElementById('createInviteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const btn = document.getElementById('createInviteBtn');
  const msg = document.getElementById('inviteMsg');
  msg.textContent = ''; msg.className = 'settings-msg';

  btn.disabled = true;
  const res = await fetch('/api/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresInDays: Number(body.expiresInDays), maxRole: body.maxRole }),
  });
  const data = await res.json().catch(() => ({}));
  btn.disabled = false;

  if (res.ok) {
    msg.textContent = t('invites.created');
    msg.className = 'settings-msg ok';
    loadInvites();
  } else {
    msg.textContent = I18N.tError(data);
    msg.className = 'settings-msg error';
  }
});

document.getElementById('addUserForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const form=e.target, body=Object.fromEntries(new FormData(form));
  const btn=document.getElementById('addUserBtn'), msg=document.getElementById('addUserMsg');
  msg.textContent=''; msg.className='settings-msg';
  if(!body.username?.trim()){msg.textContent=t('users.usernameMissing');msg.className='settings-msg error';return;}
  if(!body.password||body.password.length<12){msg.textContent=t('users.pwMin12');msg.className='settings-msg error';return;}
  btn.disabled=true;
  const res=await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:body.username.trim(),password:body.password,role:body.role})});
  const data=await res.json().catch(()=>({}));
  if(res.ok){msg.textContent=t('users.created', { name: body.username.trim() });msg.className='settings-msg ok';form.reset();loadUsers();}
  else{msg.textContent=I18N.tError(data);msg.className='settings-msg error';}
  btn.disabled=false;
});

// ================================================================
// Vault (native password manager)
// ================================================================

let vaultEntries  = [];
let vaultEditingId = null;

// Attaches the CSRF token (from /api/me at login) to state-changing
// requests. GET is exempt — CSRF only matters for writes.
function vaultFetch(url, options = {}) {
  const method  = (options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  return fetch(url, { ...options, headers });
}

// Drops decrypted entries from JS/DOM memory. Called when the user leaves
// the Vault view and on logout — not just when the tab is closed.
function clearVaultMemory() {
  vaultEntries = [];
  const listEl = document.getElementById('vaultList');
  if (listEl) listEl.innerHTML = '';
  const searchEl = document.getElementById('vaultSearchInput');
  if (searchEl) searchEl.value = '';
}

async function loadVault() {
  const lockedEl = document.getElementById('vaultLocked');
  const areaEl   = document.getElementById('vaultUnlockedArea');
  if (!vaultUnlocked) {
    lockedEl.style.display = '';
    areaEl.style.display   = 'none';
    return;
  }
  lockedEl.style.display = 'none';
  areaEl.style.display   = '';
  try {
    const res = await vaultFetch('/api/vault');
    if (res.status === 409) {
      // Session predates the vault key (or a password reset invalidated it).
      vaultUnlocked = false;
      lockedEl.style.display = '';
      areaEl.style.display   = 'none';
      return;
    }
    if (!res.ok) throw new Error('load failed');
    vaultEntries = await res.json();
    renderVaultList(vaultEntries);
  } catch {
    document.getElementById('vaultList').innerHTML =
      `<div class="vault-empty">${esc(t('vault.loadFailed'))}</div>`;
  }
}

function renderVaultList(list) {
  const listEl = document.getElementById('vaultList');
  listEl.innerHTML = '';
  if (list.length === 0) {
    listEl.innerHTML = `<div class="vault-empty">${esc(t('vault.empty'))}</div>`;
    return;
  }
  list.forEach((e, i) => {
    const row = vaultEntryRow(e);
    row.style.animationDelay = `${i * 0.03}s`;
    listEl.appendChild(row);
  });
}

function vaultEntryRow(e) {
  const el = document.createElement('div');
  el.className = 'vault-entry';
  const initial = (e.title || '?').trim()[0]?.toUpperCase() || '?';
  el.innerHTML = `
    <div class="vault-entry-icon">${esc(initial)}</div>
    <div class="vault-entry-main">
      <span class="vault-entry-title">${esc(e.title)}</span>
      <span class="vault-entry-sub">${esc(e.username || '—')}${e.url ? ' · ' + esc(e.url) : ''}</span>
    </div>
    <div class="vault-entry-pw">
      <span class="vault-entry-pw-value masked" data-revealed="0">••••••••</span>
      <button type="button" class="btn-icon vault-pw-eye" aria-label="${esc(t('vault.showPassword'))}"><i class="ti ti-eye"></i></button>
    </div>
    ${e.undecryptable ? `<span class="vault-undecryptable" title="${esc(t('vault.undecryptable'))}"><i class="ti ti-alert-triangle"></i></span>` : ''}
    <div class="vault-entry-actions">
      <button type="button" class="btn-icon vault-edit" aria-label="${esc(t('common.edit'))}"><i class="ti ti-pencil"></i></button>
      <button type="button" class="btn-icon vault-delete" aria-label="${esc(t('common.delete'))}"><i class="ti ti-trash"></i></button>
    </div>`;

  const pwEl = el.querySelector('.vault-entry-pw-value');
  el.querySelector('.vault-pw-eye').addEventListener('click', () => {
    const revealed = pwEl.dataset.revealed === '1';
    pwEl.dataset.revealed = revealed ? '0' : '1';
    pwEl.textContent = revealed ? '••••••••' : (e.password ?? '—');
    pwEl.classList.toggle('masked', revealed);
    el.querySelector('.vault-pw-eye i').className = revealed ? 'ti ti-eye' : 'ti ti-eye-off';
  });
  if (!e.undecryptable) el.querySelector('.vault-edit').addEventListener('click', () => openVaultModal(e));
  else el.querySelector('.vault-edit').disabled = true;
  el.querySelector('.vault-delete').addEventListener('click', () => deleteVaultEntry(e.id, e.title));
  return el;
}

document.getElementById('vaultSearchInput')?.addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  renderVaultList(q
    ? vaultEntries.filter(v => v.title.toLowerCase().includes(q) || (v.url || '').toLowerCase().includes(q))
    : vaultEntries);
});

async function deleteVaultEntry(id, title) {
  if (!confirm(t('common.confirmDelete', { name: title }))) return;
  try {
    const res = await vaultFetch(`/api/vault/${id}`, { method: 'DELETE' });
    if (res.ok) await loadVault();
  } catch {}
}

// ---- Add/Edit Modal ----

const vaultModalOverlay = document.getElementById('vaultModalOverlay');
const vaultEntryForm    = document.getElementById('vaultEntryForm');

function openVaultModal(entry) {
  vaultEditingId = entry ? entry.id : null;
  document.getElementById('vaultModalTitle').textContent = entry ? t('vault.editEntry') : t('vault.addEntry');
  document.getElementById('v-title').value    = entry ? entry.title    : '';
  document.getElementById('v-username').value = entry ? entry.username : '';
  document.getElementById('v-password').value = entry ? (entry.password ?? '') : '';
  document.getElementById('v-url').value       = entry ? entry.url      : '';
  document.getElementById('v-notes').value     = entry ? (entry.notes ?? '') : '';
  document.getElementById('v-password').type = 'password';
  document.getElementById('vPwToggle').querySelector('i').className = 'ti ti-eye';
  document.getElementById('vaultModalMsg').textContent = '';
  vaultModalOverlay.classList.add('open');
  document.getElementById('v-title').focus();
}

function closeVaultModal() {
  if (!vaultModalOverlay.classList.contains('open')) return;
  vaultModalOverlay.classList.remove('open');
  // Wipe the form, incl. the password field — a decrypted value shouldn't
  // linger in the DOM/form state after the modal is gone.
  vaultEntryForm.reset();
  vaultEditingId = null;
}

document.getElementById('vaultAddBtn')?.addEventListener('click', () => openVaultModal(null));
document.getElementById('vaultModalClose').addEventListener('click', closeVaultModal);
vaultModalOverlay.addEventListener('click', e => { if (e.target === vaultModalOverlay) closeVaultModal(); });

document.getElementById('vPwToggle').addEventListener('click', () => {
  const input = document.getElementById('v-password');
  const icon  = document.getElementById('vPwToggle').querySelector('i');
  const show  = input.type === 'password';
  input.type  = show ? 'text' : 'password';
  icon.className = show ? 'ti ti-eye-off' : 'ti ti-eye';
});

vaultEntryForm.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('vaultSaveBtn');
  const msg = document.getElementById('vaultModalMsg');
  msg.textContent = ''; msg.className = 'settings-msg';

  const body = {
    title:    document.getElementById('v-title').value,
    username: document.getElementById('v-username').value,
    password: document.getElementById('v-password').value,
    url:      document.getElementById('v-url').value,
    notes:    document.getElementById('v-notes').value,
  };
  if (!body.title.trim()) { msg.textContent = t('vault.titleMissing'); msg.className = 'settings-msg error'; return; }

  btn.disabled = true;
  try {
    const url    = vaultEditingId ? `/api/vault/${vaultEditingId}` : '/api/vault';
    const method = vaultEditingId ? 'PUT' : 'POST';
    const res  = await vaultFetch(url, { method, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      msg.textContent = I18N.tError(data, 'vault.saveFailed'); msg.className = 'settings-msg error';
    } else {
      closeVaultModal();
      await loadVault();
    }
  } catch {
    msg.textContent = t('common.serverUnreachable'); msg.className = 'settings-msg error';
  }
  btn.disabled = false;
});

// ---- Password generator ----

document.getElementById('vGenLength').addEventListener('input', e => {
  document.getElementById('vGenLengthVal').textContent = e.target.value;
});

function generateVaultPassword() {
  const len = Number(document.getElementById('vGenLength').value) || 20;
  const sets = [];
  if (document.getElementById('vGenLower').checked)   sets.push('abcdefghijklmnopqrstuvwxyz');
  if (document.getElementById('vGenUpper').checked)   sets.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  if (document.getElementById('vGenDigits').checked)  sets.push('0123456789');
  if (document.getElementById('vGenSymbols').checked) sets.push('!@#$%^&*()-_=+[]{}');
  if (sets.length === 0) sets.push('abcdefghijklmnopqrstuvwxyz');
  const all = sets.join('');
  const bytes = new Uint32Array(len);
  window.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += all[bytes[i] % all.length];
  return out;
}

document.getElementById('vPwGenerate').addEventListener('click', () => {
  const input = document.getElementById('v-password');
  input.value = generateVaultPassword();
  input.type  = 'text';
  document.getElementById('vPwToggle').querySelector('i').className = 'ti ti-eye-off';
});

// ================================================================
// Logout
// ================================================================

document.getElementById('logoutBtn').addEventListener('click', async ()=>{
  clearVaultMemory();
  await fetch('/api/logout',{method:'POST'}).catch(()=>{});
  window.location.href='/login';
});

// ================================================================
// Backup Status
// ================================================================

function fmtBackupTime(isoStr) {
  if (!isoStr) return '—';
  const dt = new Date(isoStr);
  const now = new Date();
  const timeStr = dt.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  if (dt.toDateString() === now.toDateString())
    return `Heute ${timeStr}`;
  if (dt.toDateString() === new Date(now - 86400000).toDateString())
    return `Gestern ${timeStr}`;
  return dt.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' }) + ' ' + timeStr;
}

function backupColor(display_status) {
  return display_status === 'ok'     ? 'var(--green)'
       : display_status === 'failed' ? 'var(--red)'
       : display_status === 'stale'  ? 'var(--amber,#ff9f0a)'
       : 'var(--text-2)';
}

async function loadBackupStatus() {
  const el     = document.getElementById('backupTime');
  const detail = document.getElementById('backupDetail');
  const hint   = document.getElementById('backupExpandHint');
  if (!el) return;
  try {
    const d = await fetch('/api/backup').then(r => r.json());
    setTextAnimated(el, fmtBackupTime(d.most_recent));
    el.style.color = backupColor(d.display_status);

    if (detail && d.nodes.length > 0) {
      detail.innerHTML = d.nodes.map(n =>
        `<div class="backup-node-row">
          <span class="dot" style="background:${backupColor(n.display_status)};box-shadow:0 0 4px ${backupColor(n.display_status)}"></span>
          <span class="backup-node-name">${esc(n.node)}</span>
          <span class="backup-node-time">${fmtBackupTime(n.last_run)}</span>
        </div>`
      ).join('');
      if (hint) hint.textContent = '▾';
    } else {
      if (hint) hint.textContent = '';
    }
  } catch {
    el.textContent = '—';
    el.style.color = 'var(--text-2)';
  }
}

document.getElementById('backupCard')?.addEventListener('click', () => {
  const detail = document.getElementById('backupDetail');
  if (!detail || !detail.innerHTML) return;
  detail.classList.toggle('open');
  const hint = document.getElementById('backupExpandHint');
  if (hint) hint.textContent = detail.classList.contains('open') ? '▴' : '▾';
});

// ================================================================
// Init
// ================================================================

// Greeting — uses the verified session username, never a hardcoded fallback.
// Split out of init() so a language switch can re-render it: both the
// salutation and the long-form date are language-dependent.
function renderGreeting() {
  const h = new Date().getHours();
  const salutation =
    h >= 5  && h < 12 ? t('greet.morning')   :
    h >= 12 && h < 18 ? t('greet.afternoon') :
    h >= 18 && h < 22 ? t('greet.evening')   :
                        t('greet.night');
  document.getElementById('greeting').textContent =
    `${salutation}, ${selfUsername || t('greet.fallbackUser')}`;
  document.getElementById('greetingDate').textContent =
    new Date().toLocaleDateString(t('locale'), { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}

// Views whose markup is built in JavaScript carry no data-i18n attributes, so
// applyI18n() cannot reach them. Re-render them explicitly when the language
// changes — but only the view actually on screen, so switching language does
// not fire requests for panels the user cannot see. The others re-render
// anyway when navigated to, because switchView() reloads them.
window.addEventListener('languagechange:zs', () => {
  const active = id => document.getElementById(id)?.classList.contains('active');
  renderGreeting();
  // loadMetrics too: the node cards carry one translated string ("unreachable"),
  // and without this an offline card keeps the language it was rendered in.
  if (active('view-home')) { loadStatus(); loadServices(); loadBackupStatus(); loadMetrics(); }
  if (active('view-einstellungen') && userRole === 'admin') { loadUsers(); loadInvites(); }
  // Skipped while locked: loadVault() would only re-trigger the 403 path.
  if (active('view-vault') && vaultUnlocked) loadVault();
});

(async function init() {
  // Verify the session before loading anything else.
  // Cloudflare Access alone does not create a dashboard session —
  // the user must have logged in with valid dashboard credentials.
  const meRes = await fetch('/api/me').catch(() => null);
  if (!meRes || !meRes.ok) { window.location.replace('/login'); return; }

  const [me, settings] = await Promise.all([
    meRes.json().catch(() => ({})),
    fetch('/api/settings').then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);

  // Role & username
  userRole     = me.role || 'viewer';
  selfUsername = me.username || '';
  csrfToken     = me.csrfToken || '';
  vaultUnlocked = Boolean(me.vaultUnlocked);
  if (userRole === 'admin') document.body.classList.add('is-admin');

  renderGreeting();
  const av = document.getElementById('userAvatar');
  if (av) { av.textContent = (selfUsername || '?')[0].toUpperCase(); av.title = selfUsername; }

  // Theme: user's own preference overrides global default
  const themeToApply = me.theme || settings.theme || 'cyan';
  applyTheme(themeToApply);

  // Background
  if (settings.bg_mode === 'image' && settings.bg_file) {
    const check = await fetch('/api/background', { method: 'HEAD' }).catch(() => ({ok:false}));
    if (check.ok) {
      bgImage.style.backgroundImage =
        `linear-gradient(rgba(0,0,0,0.44),rgba(0,0,0,0.44)),url('/api/background?t=${Date.now()}')`;
      applyBgMode('image', true);
      bgPreviewImg.src = `/api/background?t=${Date.now()}`;
      bgDropZone.style.display = 'none';
      bgPreview.classList.add('visible');
    }
  }

  loadStatus();
  loadServices();
  loadMetrics();
  loadBackupStatus();
  setInterval(loadStatus,       30_000);
  setInterval(loadMetrics,      15_000);
  setInterval(loadBackupStatus, 5 * 60_000);
})();
