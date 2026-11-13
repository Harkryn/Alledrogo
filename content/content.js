/*
 * Alledrogo — content script
 *
 * Uruchamiany na document_start. Zadania:
 *   1. Natychmiast (synchronicznie) ustawić <html data-alledrogo="on">,
 *      żeby arkusz styles/dark.css zadziałał zanim cokolwiek się wyrenderuje.
 *   2. Odczytać ustawienia z chrome.storage.sync i reagować na ich zmiany
 *      oraz na zmianę motywu systemu (tryb „auto”).
 *   3. „Malarz” (painter): Allegro ma część kolorów wpisanych na sztywno
 *      w hashowanych klasach, więc nie da się ich trafić stabilnym selektorem.
 *      Skrypt czyta obliczony styl elementów, klasyfikuje kolory i nadaje
 *      atrybuty data-alledrogo-*, które arkusz CSS przemalowuje.
 *      MutationObserver obsługuje treści doładowywane dynamicznie (SPA,
 *      infinite scroll, modale, dropdowny).
 */
(() => {
  'use strict';

  if (window.__alledrogoLoaded) return;
  window.__alledrogoLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const root = document.documentElement;
  const CACHE_KEY = 'alledrogo:active';
  const DEFAULTS = { enabled: true, followSystem: false };
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  let settings = { ...DEFAULTS };
  let active = false;

  /* ------------------------------------------------------------------ */
  /* Włączanie / wyłączanie                                              */
  /* ------------------------------------------------------------------ */

  function computeActive() {
    return settings.enabled && (!settings.followSystem || systemDark.matches);
  }

  function setActive(next) {
    if (next === active) return;
    active = next;
    try {
      localStorage.setItem(CACHE_KEY, next ? '1' : '0');
    } catch (_) { /* tryb prywatny / zablokowane storage */ }

    if (next) {
      root.setAttribute('data-alledrogo', 'on');
      painter.start();
    } else {
      root.removeAttribute('data-alledrogo');
      painter.stop();
    }
  }

  // Pierwsza decyzja synchronicznie z pamięci podręcznej strony, aby nie
  // mignęło białe tło, zanim asynchroniczne chrome.storage odpowie.
  let cached = null;
  try {
    cached = localStorage.getItem(CACHE_KEY);
  } catch (_) { /* ignore */ }
  if (cached !== '0') {
    root.setAttribute('data-alledrogo', 'on');
  }

  /* ------------------------------------------------------------------ */
  /* Kolory                                                              */
  /* ------------------------------------------------------------------ */

  const colorCache = new Map();
  let probeCtx = null;

  // Zwraca {r,g,b,a} (0-255, a 0-1) albo null.
  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'none') return null;
    let c = colorCache.get(str);
    if (c !== undefined) return c;

    let m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      c = { r: +m[1], g: +m[2], b: +m[3], a: alpha(m[4]) };
    } else if ((m = str.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/))) {
      c = { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: alpha(m[4]) };
    } else {
      c = probeColor(str);
    }
    colorCache.set(str, c);
    return c;
  }

  function alpha(v) {
    if (v === undefined) return 1;
    return v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
  }

  // Dla egzotycznych formatów (lch, oklab, color-mix...) — przez canvas.
  function probeColor(str) {
    try {
      if (!probeCtx) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 1;
        probeCtx = cv.getContext('2d', { willReadFrequently: true });
      }
      probeCtx.clearRect(0, 0, 1, 1);
      probeCtx.fillStyle = '#010203';
      probeCtx.fillStyle = str;
      probeCtx.fillRect(0, 0, 1, 1);
      const d = probeCtx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (_) {
      return null;
    }
  }

  // HSL (h 0-360, s/l 0-1)
  function toHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }

  // Jasność postrzegana (0-1), z kanałem alfa nałożonym na podane tło.
  function lightness(c, over = 1) {
    const l = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
    return l * c.a + over * (1 - c.a);
  }

  /* ------------------------------------------------------------------ */
  /* Klasyfikacja elementów                                              */
  /* ------------------------------------------------------------------ */

  const SKIP_TAGS = new Set([
    'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT',
    'SOURCE', 'TRACK', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE',
    'BR', 'WBR', 'HEAD', 'TITLE', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
    'svg', 'SVG', 'MATH'
  ]);
  const SVG_SHAPES = 'path, circle, rect, ellipse, polygon, polyline, line, text, use';
  const ATTRS = [
    'data-alledrogo-bg', 'data-alledrogo-fg', 'data-alledrogo-bd',
    'data-alledrogo-fill', 'data-alledrogo-stroke', 'data-alledrogo-icon',
    'data-alledrogo-hbg'
  ];

  // Ikony Allegro: jednokolorowe glify, np. ".../action-common-heart-1a2b3c.svg"
  const ICON_NAME = /\/(?!dark-)(?:action|navigation|informative|status|feedback|social|delivery|payment|user|editor|media|communication|file|device|commerce)-[a-z0-9-]+\.svg(?:$|\?)/i;
  const COLORFUL_NAME = /(orange|teal|green|red|blue|yellow|white|purple|navy|colou?r|brand|subbrand|logo|flag|illustration|badge|smart|one-|pay-)/i;

  let bgMemo = new WeakMap();

  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  // Klasyfikacja tła elementu na podstawie stylu obliczonego.
  function classifyBackground(el, cs) {
    if (el.hasAttribute('data-alledrogo-bg')) return;
    const bg = parseColor(cs.backgroundColor);
    if (!bg || bg.a < 0.3) return;

    const hsl = toHsl(bg);
    const L = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;

    // Pastelowe tła (tagi, banery informacyjne): przyciemnij z zachowaniem odcienia
    if (hsl.s > 0.25 && hsl.l > 0.8) {
      const sat = Math.min(hsl.s, 0.45) * 100;
      el.style.setProperty('--alledrogo-bg', `hsl(${hsl.h.toFixed(0)} ${sat.toFixed(0)}% 15%)`);
      setAttr(el, 'data-alledrogo-bg', 'tint');
      return;
    }
    if (hsl.s > 0.25 || L < 0.72) return; // kolorowe lub już ciemne — zostaw

    if (bg.a < 0.95) {
      setAttr(el, 'data-alledrogo-bg', 'glass');
    } else if (L >= 0.985) {
      setAttr(el, 'data-alledrogo-bg', 'surface');
    } else if (L >= 0.92) {
      // Szare tło: duże obszary to „blat” strony, małe — kontenery
      const wide = el.clientWidth > window.innerWidth * 0.6 && el.clientHeight > 200;
      setAttr(el, 'data-alledrogo-bg', wide ? 'base' : 'raised');
    } else {
      setAttr(el, 'data-alledrogo-bg', 'muted');
    }
  }

  // Efektywne tło pod elementem (po przemalowaniu przodków).
  // Zwraca jasność 0-1 albo -1, gdy pod spodem jest obraz tła.
  function effectiveBgLightness(el) {
    if (!el || el === root || el.nodeType !== 1) return 0;
    const memo = bgMemo.get(el);
    if (memo !== undefined) return memo;
    const cs = getComputedStyle(el);
    let val;
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg.a >= 0.5) {
      val = lightness(bg, 0);
    } else if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) {
      val = -1;
    } else {
      val = effectiveBgLightness(el.parentElement);
    }
    bgMemo.set(el, val);
    return val;
  }

  function hasOwnText(el) {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) return true;
      if (n.nodeType === 1 && n.localName === 'svg') return true;
    }
    return false;
  }

  function classifyText(el, cs) {
    if (el.hasAttribute('data-alledrogo-fg')) return;
    if (!hasOwnText(el)) return;
    const fg = parseColor(cs.color);
    if (!fg || fg.a < 0.2) return;

    const under = effectiveBgLightness(el);
    if (under < 0 || under > 0.45) return; // tekst na jasnym/kolorowym tle lub obrazie

    const hsl = toHsl(fg);
    const apparent = lightness(fg, 1); // jak wyglądał na białym tle
    if (hsl.s < 0.2 || hsl.l < 0.12) {
      if (apparent <= 0.32) setAttr(el, 'data-alledrogo-fg', 'primary');
      else if (apparent <= 0.62) setAttr(el, 'data-alledrogo-fg', 'secondary');
      return;
    }
    // Ciemny, nasycony tekst (zielone ceny, linki, statusy) — rozjaśnij, zachowaj odcień
    if (hsl.l < 0.5) {
      const sat = Math.min(hsl.s, 0.65) * 100;
      el.style.setProperty('--alledrogo-fg', `hsl(${hsl.h.toFixed(0)} ${sat.toFixed(0)}% 68%)`);
      setAttr(el, 'data-alledrogo-fg', 'tint');
    }
  }

  function classifyBorder(el, cs) {
    if (el.hasAttribute('data-alledrogo-bd')) return;
    let color = null;
    if (parseFloat(cs.borderTopWidth) > 0) color = cs.borderTopColor;
    else if (parseFloat(cs.borderBottomWidth) > 0) color = cs.borderBottomColor;
    else if (parseFloat(cs.borderLeftWidth) > 0) color = cs.borderLeftColor;
    else if (parseFloat(cs.borderRightWidth) > 0) color = cs.borderRightColor;
    if (!color) return;
    const c = parseColor(color);
    if (!c || c.a < 0.05) return;
    const hsl = toHsl(c);
    if (hsl.s > 0.25) return; // kolorowe obramowanie (np. pomarańczowy focus)
    const L = lightness(c, 0);
    const blackAlpha = L < 0.15 && c.a < 0.4;   // rgba(0,0,0,.12) — znika na ciemnym tle
    const lightGray = L > 0.65;                  // #ddd, #eceff1 — razi na ciemnym tle
    if (blackAlpha || lightGray) setAttr(el, 'data-alledrogo-bd', '1');
  }

  function classifySvg(svg) {
    if (svg.hasAttribute('data-alledrogo-icon')) return;
    svg.setAttribute('data-alledrogo-icon', 'checked');
    const under = effectiveBgLightness(svg.parentElement);
    if (under < 0 || under > 0.45) return;

    const shapes = svg.querySelectorAll(SVG_SHAPES);
    if (!shapes.length || shapes.length > 60) return;
    const darkFill = [];
    const darkStroke = [];
    for (const s of shapes) {
      const cs = getComputedStyle(s);
      for (const [prop, list] of [['fill', darkFill], ['stroke', darkStroke]]) {
        const c = parseColor(cs[prop]);
        if (!c || c.a < 0.1) continue;
        const hsl = toHsl(c);
        // Ikona z jakimkolwiek kolorem (nie-szarym, nie-białym) = kolorowa — nie ruszamy
        if (hsl.s > 0.2 && hsl.l > 0.12 && hsl.l < 0.9) return;
        if (lightness(c, 0) < 0.35) list.push(s);
      }
    }
    for (const s of darkFill) s.setAttribute('data-alledrogo-fill', '1');
    for (const s of darkStroke) s.setAttribute('data-alledrogo-stroke', '1');
  }

  function classifyImg(img) {
    if (img.hasAttribute('data-alledrogo-icon')) return;
    const src = img.currentSrc || img.src || '';
    if (!src) return; // poczekaj, aż lazy-load ustawi src
    if (!ICON_NAME.test(src) || COLORFUL_NAME.test(src.split('/').pop())) {
      img.setAttribute('data-alledrogo-icon', 'none');
      return;
    }
    const w = img.width || img.clientWidth;
    const h = img.height || img.clientHeight;
    if ((w && w > 48) || (h && h > 48)) {
      img.setAttribute('data-alledrogo-icon', 'none');
      return;
    }
    const under = effectiveBgLightness(img.parentElement);
    img.setAttribute('data-alledrogo-icon', under >= 0 && under <= 0.45 ? 'mono' : 'none');
  }

  function processElement(el) {
    const tag = el.tagName;
    if (tag === 'IMG') { classifyImg(el); return; }
    if (el.localName === 'svg') { classifySvg(el); return; }
    if (SKIP_TAGS.has(tag)) return;
    if (el.closest && el.closest('svg')) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    classifyBackground(el, cs);
    classifyBorder(el, cs);
  }

  function processText(el) {
    if (SKIP_TAGS.has(el.tagName) || el.localName === 'svg') return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    classifyText(el, cs);
  }

  /* ------------------------------------------------------------------ */
  /* Kolejka i MutationObserver                                          */
  /* ------------------------------------------------------------------ */

  const painter = (() => {
    let observer = null;
    let queue = new Set();
    let scheduled = false;
    let running = false;
    const BUDGET_MS = 12;

    function enqueue(node) {
      if (node && node.nodeType === 1) queue.add(node);
      schedule();
    }

    function schedule() {
      if (scheduled || !active) return;
      scheduled = true;
      // rAF nie działa w kartach w tle — setTimeout jako zabezpieczenie
      const run = () => { if (scheduled) { scheduled = false; flush(); } };
      requestAnimationFrame(run);
      setTimeout(run, 100);
    }

    function collect(rootEl) {
      const list = [rootEl];
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT, {
        acceptNode(n) {
          // nie schodzimy do wnętrza SVG (całe SVG klasyfikujemy naraz)
          return n.parentElement && n.parentElement.localName === 'svg'
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
      });
      let n;
      while ((n = walker.nextNode())) list.push(n);
      return list;
    }

    function flush() {
      if (!active || running) return;
      const roots = [...queue].filter((n) => n.isConnected);
      queue.clear();
      if (!roots.length) return;
      // usuń korzenie zawarte w innych korzeniach
      const unique = roots.filter((n) => !roots.some((o) => o !== n && o.contains(n)));
      const elements = [];
      for (const r of unique) elements.push(...collect(r));
      running = true;
      bgMemo = new WeakMap();
      let i = 0;
      let phase = 0; // 0: tła/obramowania, 1: tekst/ikony
      const step = () => {
        if (!active) { running = false; return; }
        const t0 = performance.now();
        while (performance.now() - t0 < BUDGET_MS) {
          if (i >= elements.length) {
            if (phase === 0) { phase = 1; i = 0; bgMemo = new WeakMap(); continue; }
            running = false;
            if (queue.size) schedule();
            return;
          }
          const el = elements[i++];
          if (!el.isConnected) continue;
          try {
            if (phase === 0) processElement(el);
            else processText(el);
          } catch (_) { /* pojedynczy element nie może zatrzymać całości */ }
        }
        setTimeout(step, 0);
      };
      step();
    }

    function onMutations(records) {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of r.addedNodes) enqueue(n);
        } else if (r.type === 'attributes') {
          const el = r.target;
          if (r.attributeName === 'src' || r.attributeName === 'srcset') {
            if (el.getAttribute('data-alledrogo-icon') === 'none' || !el.hasAttribute('data-alledrogo-icon')) {
              el.removeAttribute('data-alledrogo-icon');
              enqueue(el);
            }
          } else {
            enqueue(el);
          }
        }
      }
    }

    // Stany :hover z jasnym tłem (nie są mutacjami DOM) — oznaczamy element
    // atrybutem działającym tylko pod :hover.
    function onHover(e) {
      let el = e.target;
      for (let depth = 0; el && el.nodeType === 1 && depth < 4; depth++, el = el.parentElement) {
        if (el === document.body || el.hasAttribute('data-alledrogo-bg') || el.hasAttribute('data-alledrogo-hbg')) continue;
        if (SKIP_TAGS.has(el.tagName) || el.localName === 'svg') continue;
        const bg = parseColor(getComputedStyle(el).backgroundColor);
        if (!bg || bg.a < 0.3) continue;
        const hsl = toHsl(bg);
        if (hsl.s <= 0.25 && lightness(bg, 0) > 0.72) {
          el.setAttribute('data-alledrogo-hbg', '1');
        }
      }
    }

    function start() {
      if (observer) return;
      observer = new MutationObserver(onMutations);
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'open', 'hidden', 'aria-expanded', 'aria-hidden', 'src', 'srcset']
      });
      document.addEventListener('mouseover', onHover, { passive: true, capture: true });
      enqueue(document.body || root);
    }

    function stop() {
      if (observer) observer.disconnect();
      observer = null;
      queue.clear();
      document.removeEventListener('mouseover', onHover, { capture: true });
      // Atrybuty są nieszkodliwe bez data-alledrogo="on" na <html>,
      // ale sprzątamy, żeby po ponownym włączeniu klasyfikacja była świeża.
      const sel = ATTRS.map((a) => `[${a}]`).join(',');
      for (const el of document.querySelectorAll(sel)) {
        for (const a of ATTRS) el.removeAttribute(a);
        el.style.removeProperty('--alledrogo-bg');
        el.style.removeProperty('--alledrogo-fg');
      }
    }

    return { start, stop, enqueue };
  })();

  /* ------------------------------------------------------------------ */
  /* Ustawienia                                                          */
  /* ------------------------------------------------------------------ */

  function applySettings(next) {
    settings = { ...DEFAULTS, ...next };
    setActive(computeActive());
  }

  // Tymczasowo zakładamy stan z pamięci podręcznej, aby painter ruszył od razu.
  if (cached !== '0') {
    active = true;
    painter.start();
  }

  try {
    api.storage.sync.get(DEFAULTS).then(applySettings, () => applySettings(DEFAULTS));
  } catch (_) {
    applySettings(DEFAULTS);
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const next = { ...settings };
    for (const k of Object.keys(DEFAULTS)) {
      if (changes[k]) next[k] = changes[k].newValue ?? DEFAULTS[k];
    }
    applySettings(next);
  });

  systemDark.addEventListener('change', () => setActive(computeActive()));

  // Pełne przejście po załadowaniu (np. style z opóźnionych arkuszy CSS)
  window.addEventListener('load', () => {
    if (active) painter.enqueue(document.body);
  });
})();
