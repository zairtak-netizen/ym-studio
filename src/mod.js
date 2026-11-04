(function () {
  'use strict';
  if (window.top !== window) return;
  if (!/^music\.yandex\./.test(location.hostname)) return;
  if (window.__ymStudio) return;

  const KEY = 'ymstudio:v1';
  const host = window.chrome && window.chrome.webview;
  const send = (cmd, value) => { if (host) host.postMessage({ cmd, value }); };

  /* ---------- Hooks: must run before the site's own scripts ---------- */

  const mediaHandlers = {};
  if (window.MediaSession) {
    const setHandler = MediaSession.prototype.setActionHandler;
    MediaSession.prototype.setActionHandler = function (action, fn) {
      mediaHandlers[action] = fn;
      return setHandler.call(this, action, fn);
    };
  }

  const audio = { els: new Set(), taps: new Map(), outs: new Set(), routed: new Set(), chains: new Map(), eqOn: false, streams: new WeakSet(), own: null, source: 'none', lastSignal: 0 };

  function tapFor(ctx) {
    let tap = audio.taps.get(ctx);
    if (!tap) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      tap = { analyser, data: new Uint8Array(analyser.frequencyBinCount), wave: new Uint8Array(analyser.fftSize) };
      audio.taps.set(ctx, tap);
    }
    return tap;
  }

  // The site plays through its own Web Audio graph: listen in parallel without touching its output.
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.connect = function (target) {
    if (!(target instanceof AudioDestinationNode)) return connect.apply(this, arguments);
    audio.outs.add(this);
    // Re-linked on every call: a bare disconnect() from the site drops the analyser too.
    try { connect.call(this, tapFor(this.context).analyser); }
    catch (e) { console.warn('[YM Studio] tap', e); }
    if (audio.eqOn) {
      audio.routed.add(this);
      connect.call(this, eqChain(this.context).input);
      return target;
    }
    return connect.apply(this, arguments);
  };
  // While the equalizer is on the site's node feeds the chain, so its own disconnect must follow.
  AudioNode.prototype.disconnect = function (target) {
    if (target instanceof AudioDestinationNode && audio.routed.has(this)) {
      audio.routed.delete(this);
      return disconnect.call(this, eqChain(this.context).input);
    }
    if (!arguments.length) audio.routed.delete(this);
    return disconnect.apply(this, arguments);
  };

  const EQ_FREQS = [60, 150, 400, 1000, 2400, 6000, 15000];
  function eqChain(ctx) {
    let chain = audio.chains.get(ctx);
    if (chain) return chain;
    const filters = EQ_FREQS.map((frequency, i) => {
      const f = ctx.createBiquadFilter();
      f.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = frequency;
      f.Q.value = 1;
      return f;
    });
    const trim = ctx.createGain();
    filters.forEach((f, i) => connect.call(f, filters[i + 1] || trim));
    connect.call(trim, ctx.destination);
    chain = { input: filters[0], filters, trim };
    audio.chains.set(ctx, chain);
    return chain;
  }

  // The site's path stays untouched until the equalizer is switched on.
  function applyEq(on, bands) {
    audio.eqOn = on;
    for (const node of audio.outs) {
      const dest = node.context.destination;
      if (on && !audio.routed.has(node)) {
        try {
          disconnect.call(node, dest);
          connect.call(node, eqChain(node.context).input);
          audio.routed.add(node);
        } catch (e) { /* this node isn't feeding the speakers right now */ }
      } else if (!on && audio.routed.has(node)) {
        disconnect.call(node, eqChain(node.context).input);
        connect.call(node, dest);
        audio.routed.delete(node);
      }
    }
    const boost = Math.max(0, ...bands);
    for (const chain of audio.chains.values()) {
      chain.filters.forEach((f, i) => { f.gain.value = bands[i] || 0; });
      chain.trim.gain.value = Math.pow(10, -boost / 20); // headroom, so boosted bands don't clip
    }
  }

  // captureStream never reroutes playback, unlike createMediaElementSource, so it cannot mute the track.
  function captureElement(el) {
    if (audio.streams.has(el)) return;
    try {
      const stream = el.captureStream();
      if (!stream.getAudioTracks().length) return;
      audio.streams.add(el);
      const ctx = audio.own || (audio.own = new AudioContext());
      if (ctx.state === 'suspended') ctx.resume();
      connect.call(ctx.createMediaStreamSource(stream), tapFor(ctx).analyser);
    } catch (e) { console.warn('[YM Studio] capture', e); }
  }

  // The site unlocks audio with a silent data: clip, which says nothing about the real track.
  const isTrack = el => !!el.currentSrc && !el.currentSrc.startsWith('data:');
  function trackElement(el) {
    if (audio.els.has(el)) return;
    audio.els.add(el);
    el.addEventListener('playing', () => { if (isTrack(el)) captureElement(el); });
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (this.tagName === 'AUDIO') trackElement(this);
    return play.apply(this, arguments);
  };
  function isPlaying() {
    if (navigator.mediaSession && navigator.mediaSession.playbackState === 'playing') return true;
    for (const el of audio.els) if (!el.paused && !el.ended && isTrack(el)) return true;
    return false;
  }

  /* ---------- Settings ---------- */

  const THEMES = [
    { id: 'original', name: 'Оригинал', mode: 'dark', bg: '#000000', surface: '#121212', pop: '#1a1a1a', player: '#141414', text: '#e6e6e6', accent: '#ffff00' },
    { id: 'midnight', name: 'Полночь', mode: 'dark', bg: '#080b1a', surface: '#0f1428', pop: '#171d38', player: '#0d1124', text: '#e4e8ff', accent: '#7c8cff' },
    { id: 'neon', name: 'Неон', mode: 'dark', bg: '#0a0410', surface: '#140a1e', pop: '#1f102e', player: '#12081b', text: '#f6e9ff', accent: '#ff2bd6' },
    { id: 'sakura', name: 'Сакура', mode: 'dark', bg: '#170d13', surface: '#21131b', pop: '#2d1a25', player: '#1d1118', text: '#ffe9f1', accent: '#ff8fb8' },
    { id: 'forest', name: 'Хвоя', mode: 'dark', bg: '#07110c', surface: '#0d1a13', pop: '#14261c', player: '#0b1610', text: '#e2f3e8', accent: '#3ddc84' },
    { id: 'sunset', name: 'Закат', mode: 'dark', bg: '#150a07', surface: '#20100b', pop: '#2c1710', player: '#1b0d09', text: '#ffeadf', accent: '#ff7a3d' },
    { id: 'glacier', name: 'Ледник', mode: 'dark', bg: '#071218', surface: '#0d1c24', pop: '#142833', player: '#0b171e', text: '#def3fb', accent: '#4fd1ff' },
    { id: 'coffee', name: 'Кофейня', mode: 'dark', bg: '#14100c', surface: '#1e1812', pop: '#29211a', player: '#19140f', text: '#f1e6d8', accent: '#d9a566' },
    { id: 'terminal', name: 'Терминал', mode: 'dark', bg: '#000000', surface: '#050a05', pop: '#0a140a', player: '#040804', text: '#b6ffb6', accent: '#33ff66' },
    { id: 'paper', name: 'Бумага', mode: 'light', bg: '#f1ebe0', surface: '#fbf7ef', pop: '#ffffff', player: '#fbf7ef', text: '#2b2620', accent: '#c2410c' },
    { id: 'cloud', name: 'Облако', mode: 'light', bg: '#e9eef6', surface: '#f8fafd', pop: '#ffffff', player: '#f8fafd', text: '#1c2433', accent: '#2563eb' }
  ];

  const DEFAULTS = {
    theme: 'original', accent: '', dynamic: false,
    bg: 'none', image: '', blur: 40, dim: 55, bgSat: 100,
    bgFx: 'none', fxAmount: 50, fxReact: true,
    grain: 0, vignette: 0, bgMotion: false, bgPulse: false, parallax: false,
    glass: false, glassOpacity: 55, radius: 'default', font: '', uiZoom: '100',
    island: false, barHide: false, navHide: false, vinyl: false, pulse: false, progressGlow: false,
    weAccent: false, wePause: false, weVideo: '', weKind: 'video',
    eqOn: false, eqBands: [0, 0, 0, 0, 0, 0, 0], eqPreset: 'flat',
    myLooks: [], autoMode: 'off', dayLook: '', nightLook: '', dayFrom: '08:00', nightFrom: '20:00', pageLooks: {},
    trayClose: false, trackToast: false, pin: false,
    hotkeys: {
      toggle: { mods: 3, vk: 32, label: 'Ctrl+Alt+Пробел' }, next: { mods: 3, vk: 39, label: 'Ctrl+Alt+→' }, prev: { mods: 3, vk: 37, label: 'Ctrl+Alt+←' },
      mini: { mods: 3, vk: 77, label: 'Ctrl+Alt+M' }, stage: { mods: 3, vk: 83, label: 'Ctrl+Alt+S' }, like: { mods: 3, vk: 76, label: 'Ctrl+Alt+L' },
      volUp: { mods: 3, vk: 38, label: 'Ctrl+Alt+↑' }, volDown: { mods: 3, vk: 40, label: 'Ctrl+Alt+↓' }
    },
    coverShape: 'default', hoverZoom: false, tilt: false, mono: false,
    titleGlow: false, pageFade: false, crt: false, slimScroll: true,
    vis: 'off', visPos: 'player', visColor: 'accent', visHeight: 90, visOpacity: 80,
    visSens: 100, visSmooth: 40, visCount: 72, visPeaks: false, visRound: false, visCenter: false, visGlow: false,
    eco: false,
    css: ''
  };

  const LOOKS = [
    { name: 'Синтвейв', hint: 'Ретро-сетка и неон', set: { theme: 'neon', bg: 'gradient', bgFx: 'grid', glassOpacity: 82, vis: 'mirror', visColor: 'gradient', visGlow: true, island: true, titleGlow: true, radius: 'soft' } },
    { name: 'Зимний вечер', hint: 'Сияние и снег', set: { theme: 'glacier', bg: 'aurora', bgFx: 'snow', vis: 'wave', visHeight: 120, island: true, radius: 'soft', coverShape: 'round' } },
    { name: 'Матрица', hint: 'Терминал и ЭЛТ', set: { theme: 'terminal', bgFx: 'rain', glassOpacity: 82, vis: 'dots', crt: true, radius: 'sharp', font: 'Consolas', titleGlow: true, coverShape: 'square' } },
    { name: 'Кино', hint: 'Фон из обложки', set: { bg: 'cover', blur: 60, dim: 60, bgMotion: true, glass: true, dynamic: true, vis: 'circle', visColor: 'gradient', island: true, vignette: 60, grain: 12 } },
    { name: 'Космос', hint: 'Звёзды в такт', set: { theme: 'midnight', bg: 'aurora', dim: 65, bgFx: 'stars', parallax: true, vis: 'line', visColor: 'gradient', visGlow: true, glass: true } },
    { name: 'Костёр', hint: 'Тёплые искры', set: { theme: 'sunset', bg: 'gradient', bgFx: 'sparks', bgPulse: true, vis: 'bars', visPeaks: true, visRound: true, visCenter: true, vignette: 45, pulse: true } }
  ];

  function load() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  const s = load();
  let saveWarned = false, saveTimer;
  // Debounced: a slider fires on every tick and the settings can hold a large background image.
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(s)); saveWarned = false; }
      catch (e) { if (!saveWarned) { saveWarned = true; toast('Не удалось сохранить настройки: мало места. Выберите картинку поменьше.'); } }
    }, 250);
  }

  // Windows "Animation effects: off". Ambient motion freezes; the visualizer stays, since it is requested per track.
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  let stageOn = false;
  // The stage always has a visualizer, without changing what the user picked for normal use.
  const curVis = () => (stageOn && s.vis === 'off') ? 'mirror' : s.vis;
  const FULL_FRAME = ['circle', 'tunnel', 'particles'];
  const visBehind = () => !stageOn && curVis() !== 'off' && (s.visPos === 'back' || FULL_FRAME.includes(curVis()));
  const isLayered = () => s.bg !== 'none' || s.bgFx !== 'none' || visBehind();
  const seeThroughOn = () => s.bg === 'wallpaper' && !stageOn;

  /* ---------- Colour helpers ---------- */

  function rgbOf(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hexOf = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  function luminance(hex) {
    const [r, g, b] = rgbOf(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const onColor = hex => luminance(hex) > 0.35 ? '#000000' : '#ffffff';
  // Cover colours are often dark or muted: keep the hue, force enough contrast against the theme.
  function readable(r, g, b, lightTheme) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    const l0 = (max + min) / 2;
    const s0 = d ? d / (1 - Math.abs(2 * l0 - 1)) : 0;
    const l = lightTheme ? Math.min(l0, 0.4) : Math.max(l0, 0.64);
    const sat = Math.max(s0, 0.6);
    const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
    const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
    return hexOf((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
  }
  const alpha = (c, p) => `color-mix(in srgb, ${c} ${p}%, transparent)`;
  const shade = (c, to, p) => `color-mix(in srgb, ${c}, ${to} ${p}%)`;

  /* ---------- Theme → design tokens ---------- */

  let coverAccent = '';
  const currentTheme = () => THEMES.find(t => t.id === s.theme) || THEMES[0];
  let wallpaperAccent = '';
  const currentAccent = () => (s.dynamic && coverAccent) || (s.weAccent && wallpaperAccent) || s.accent || currentTheme().accent;

  function accentTokens(A) {
    const on = onColor(A);
    const hover = shade(A, luminance(A) > 0.35 ? '#000' : '#fff', 14);
    return {
      '--ym-logo-color-primary-variant': A,
      '--ym-logo-color-primary-player': A,
      '--ym-logo-color-primary-text': A,
      '--ym-controls-color-primary-default-enabled': A,
      '--ym-controls-color-primary-default-hovered': hover,
      '--ym-controls-color-primary-default-pressed': shade(A, '#fff', 30),
      '--ym-controls-color-primary-default-focused_stroke': alpha(A, 50),
      '--ym-controls-color-primary-on_default-enabled': on,
      '--ym-controls-color-primary-outline-hovered_stroke': hover,
      '--ym-controls-color-primary-outline-selected_stroke': A,
      '--ym-controls-color-primary-outline-focused_stroke': alpha(A, 50),
      '--ym-controls-color-primary-text-hovered': hover,
      '--ym-controls-color-accent-default-enabled': A,
      '--ym-controls-color-accent-default-hovered': hover,
      '--ym-controls-color-accent-on_default-enabled': on,
      '--ym-background-color-primary-enabled-tooltip': shade(A, '#000', 35),
      '--ym-slider-color-primary-enabled': A,
      '--ym-slider-color-primary-progress': alpha(A, 28)
    };
  }

  function surfaceTokens(t, layered) {
    const tx = t.text;
    const glass = c => layered ? alpha(c, s.glassOpacity) : c;
    return {
      '--ym-background-color-primary-enabled-basic': layered ? 'transparent' : t.bg,
      '--ym-background-color-primary-enabled-content': glass(t.surface),
      '--ym-background-color-primary-enabled-popover': t.pop,
      '--ym-background-color-primary-enabled-header': alpha(t.bg, 50),
      '--ym-background-color-primary-enabled-player': glass(t.player),
      '--ym-background-color-primary-enabled-menu': alpha(t.pop, 88),
      '--ym-background-color-primary-enabled-vibe': layered ? 'transparent' : `linear-gradient(180deg, ${t.bg}, ${t.surface})`,
      '--ym-background-color-secondary-enabled-blur': shade(t.pop, tx, 12),
      '--ym-logo-color-primary-enabled': tx,
      '--ym-controls-color-primary-default-disabled': alpha(tx, 16),
      '--ym-controls-color-primary-on_default-disabled': alpha(tx, 30),
      '--ym-controls-color-primary-outline-disabled': alpha(tx, 16),
      '--ym-controls-color-primary-outline-enabled': alpha(tx, 18),
      '--ym-controls-color-primary-outline-hovered': alpha(tx, 28),
      '--ym-controls-color-primary-outline-pressed': alpha(tx, 38),
      '--ym-controls-color-primary-on_outline-disabled': alpha(tx, 38),
      '--ym-controls-color-primary-on_outline-enabled': tx,
      '--ym-controls-color-primary-text-disabled': alpha(tx, 30),
      '--ym-controls-color-primary-text-enabled': alpha(tx, 62),
      '--ym-controls-color-primary-text-enabled_variant': tx,
      '--ym-controls-color-primary-text-hovered_variant': tx,
      '--ym-controls-color-secondary-default-disabled': alpha(tx, 8),
      '--ym-controls-color-secondary-default-enabled': alpha(tx, 8),
      '--ym-controls-color-secondary-default-hovered': alpha(tx, 13),
      '--ym-controls-color-secondary-default-pressed': alpha(tx, 24),
      '--ym-controls-color-secondary-default-focused_stroke': alpha(tx, 50),
      '--ym-controls-color-secondary-on_default-disabled': alpha(tx, 26),
      '--ym-controls-color-secondary-on_default-enabled': tx,
      '--ym-controls-color-secondary-on_default-enabled_variant': alpha(tx, 62),
      '--ym-controls-color-secondary-on_default-hovered': tx,
      '--ym-controls-color-secondary-outline-disabled_stroke': alpha(tx, 16),
      '--ym-controls-color-secondary-outline-enabled_stroke': alpha(tx, 28),
      '--ym-controls-color-secondary-outline-hovered_stroke': alpha(tx, 50),
      '--ym-controls-color-secondary-outline-selected': alpha(tx, 14),
      '--ym-controls-color-secondary-outline-selected_stroke': tx,
      '--ym-controls-color-secondary-outline-pressed': alpha(tx, 28),
      '--ym-controls-color-secondary-outline-focused_stroke': alpha(tx, 28),
      '--ym-controls-color-secondary-on_outline-disabled': alpha(tx, 30),
      '--ym-controls-color-secondary-on_outline-enabled': tx,
      '--ym-controls-color-secondary-on_outline-enabled_variant': alpha(tx, 55),
      '--ym-controls-color-secondary-text-disabled': alpha(tx, 12),
      '--ym-controls-color-secondary-text-enabled': alpha(tx, 62),
      '--ym-controls-color-secondary-text-enabled_variant': tx,
      '--ym-controls-color-secondary-text-hovered': tx,
      '--ym-controls-color-secondary-text-selected': tx,
      '--ym-controls-color-secondary-card-disabled': alpha(tx, 24),
      '--ym-controls-color-secondary-card-enabled': alpha(t.pop, 90),
      '--ym-controls-color-secondary-card-hovered': alpha(shade(t.pop, tx, 10), 90),
      '--ym-outline-color-primary-disabled': layered && s.glassOpacity === 0 ? 'transparent' : alpha(tx, 6),
      '--ym-surface-color-primary-enabled-list': alpha(tx, 8),
      '--ym-surface-color-primary-enabled-entity': alpha(t.bg, 64),
      '--ym-slider-color-primary-disabled': alpha(tx, 8)
    };
  }

  const RADII = {
    sharp: { xxxs: 0, xxs: 1, xs: 2, s: 2, m: 3, l: 4, xl: 4, xxl: 5, xxxl: 6 },
    soft: { xxxs: 4, xxs: 6, xs: 8, s: 10, m: 12, l: 16, xl: 20, xxl: 24, xxxl: 28 }
  };

  function buildCss() {
    const t = currentTheme();
    const layered = isLayered();
    const A = currentAccent();
    const custom = s.theme !== 'original' || layered;
    const tokens = Object.assign({}, custom ? surfaceTokens(t, layered) : {},
      (custom || s.accent || s.dynamic) ? accentTokens(currentAccent()) : {});
    const r = RADII[s.radius];
    if (r) Object.keys(r).forEach(k => { tokens['--ym-radius-size-' + k] = r[k] + 'px'; });
    if (s.font) {
      tokens['--ym-font-text'] = `"${s.font}", sans-serif`;
      tokens['--ym-font-heading'] = `"${s.font}", sans-serif`;
    }

    const body = Object.keys(tokens).map(k => `${k}:${tokens[k]} !important;`).join('');
    let css = body ? `:root,.ym-dark-theme,.ym-light-theme{${body}}\n` : '';
    if (s.font) css += `body,button,input{font-family:"${s.font}",sans-serif !important;}\n`;

    if (layered) {
      css += `html,body{background:transparent !important;}
[class*="DefaultLayout_root"],[class*="CommonLayout_root"],[class*="Content_root"]{background:transparent !important;}
[class*="Content_main"]{background:var(--ym-background-color-primary-enabled-content) !important;}\n`;
      if (s.glass) {
        css += `[class*="PlayerBarDesktopWithBackgroundProgressBar_player"],[class*="NavbarDesktop_root"],[class*="Content_main"]{backdrop-filter:blur(24px) saturate(1.4);}\n`;
      }
    }
    if (s.slimScroll) {
      const thumb = alpha(t.text, 22);
      css += `::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:${thumb};border-radius:8px}::-webkit-scrollbar-thumb:hover{background:${currentAccent()}}\n`;
    }
    if (s.island) {
      css += `[class*="PlayerBarDesktopWithBackgroundProgressBar_root"]{box-sizing:border-box;width:calc(100% - 28px) !important;margin:0 14px 12px !important;border-radius:18px !important;overflow:hidden;box-shadow:0 10px 34px rgba(0,0,0,.45);}\n`;
    }
    if (s.barHide) {
      // The bar sits in its own grid row: collapse the row so the content takes the full height,
      // and lay the bar over it. Absolute inside the grid area keeps it clear of the left navigation.
      const bar = '[class*="PlayerBarDesktopWithBackgroundProgressBar_root"]';
      css += `[class*="CommonLayout_root"]:has(>${bar}){grid-template-rows:minmax(0,1fr) 0 0 !important}
${bar}{position:absolute !important;left:0;right:0;bottom:0;z-index:20;backdrop-filter:blur(20px);transform:translateY(calc(100% + 16px));transition:transform .18s ease-in}
html.yms-bar-show ${bar},${bar}:has(:focus-visible){transform:none;transition:transform .22s ease-out}\n`;
    }
    if (s.navHide) {
      // Same idea as the player: the navigation leaves its grid column and slides over the content.
      const nav = '[class*="Navbar_root"]';
      css += `[class*="CommonLayout_root"]:has(>${nav}){grid-template-columns:0 minmax(0,1fr) !important}
${nav}{position:absolute !important;left:0;top:0;bottom:0;width:72px;z-index:30;backdrop-filter:blur(20px);background:${alpha(t.bg, 70)};transform:translateX(-100%);transition:transform .18s ease-in}
html.yms-nav-show ${nav},${nav}:has(:focus-visible){transform:none;transition:transform .22s ease-out}\n`;
    }
    if (s.vinyl) {
      css += `@keyframes yms-spin{to{transform:rotate(360deg)}}
html.yms-playing [class*="PlayerBarDesktopWithBackgroundProgressBar_cover"] img{animation:yms-spin 9s linear infinite}
[class*="PlayerBarDesktopWithBackgroundProgressBar_cover"],[class*="PlayerBarDesktopWithBackgroundProgressBar_cover"] img{border-radius:50% !important}\n`;
    }
    // Cover images are matched by their CDN path, which outlives the site's hashed class names.
    const cover = 'img[src*="get-music-content"]';
    const hovered = `a:hover ${cover},:hover>${cover}`;
    const shape = { square: '0', round: '16px', circle: '50%' }[s.coverShape];
    if (shape) css += `${cover}{border-radius:${shape} !important}\n`;
    if (s.hoverZoom || s.tilt) css += `${cover}{transition:transform .22s ease-out,filter .22s ease-out}\n`;
    if (s.hoverZoom) css += `${hovered}{transform:scale(1.06)}\n`;
    if (s.tilt) css += `${hovered}{transform:perspective(420px) rotateY(-12deg) rotateX(7deg) scale(1.05)}\n`;
    if (s.mono) css += `${cover}{filter:grayscale(1);transition:filter .22s ease-out}${hovered}{filter:none}\n`;
    // Titles clip their overflow for the ellipsis; the clip margin lets the glow out without losing it.
    if (s.titleGlow) css += `h1,h2,[class*="PageHeaderTitle"]{text-shadow:0 0 16px ${alpha(A, 70)};overflow:clip !important;overflow-clip-margin:28px}\n`;
    if (s.progressGlow) {
      css += `[class*="PlayerBarDesktopWithBackgroundProgressBar_progressBar"],[class*="PlayerBarDesktopWithBackgroundProgressBar_slider"]{filter:drop-shadow(0 0 6px ${A})}\n`;
    }
    if (s.pageFade) {
      css += `@keyframes yms-in{from{opacity:0;transform:translateY(10px)}}[class*="Content_main"]>*{animation:yms-in .26s ease-out backwards}\n`;
    }
    if (s.crt) {
      css += `html::after{content:"";position:fixed;inset:0;z-index:2147481000;pointer-events:none;
background:repeating-linear-gradient(0deg,rgba(0,0,0,.2) 0 1px,transparent 1px 3px),radial-gradient(ellipse at center,transparent 62%,rgba(0,0,0,.42))}\n`;
    }
    if (s.bg === 'aurora') {
      css += `@keyframes yms-a1{to{transform:translate3d(22vw,12vh,0) scale(1.25)}}@keyframes yms-a2{to{transform:translate3d(-20vw,-14vh,0) scale(.85)}}@keyframes yms-a3{to{transform:translate3d(12vw,-20vh,0) scale(1.15)}}
.yms-blob:nth-child(1){animation:yms-a1 23s ease-in-out infinite alternate}.yms-blob:nth-child(2){animation:yms-a2 31s ease-in-out infinite alternate}.yms-blob:nth-child(3){animation:yms-a3 27s ease-in-out infinite alternate}\n`;
    }
    if (s.bgMotion) {
      css += `@keyframes yms-kb{to{transform:scale(1.14) translate3d(-1.5%,1%,0)}}#yms-bg-image{animation:yms-kb 38s ease-in-out infinite alternate}\n`;
    }
    css += `@media (prefers-reduced-motion:reduce){.yms-blob,#yms-bg-image,${cover},[class*="Content_main"]>*,[class*="PlayerBarDesktopWithBackgroundProgressBar_root"],[class*="Navbar_root"]{animation:none !important;transition:none !important}}\n`;
    return css + (s.css ? '\n' + s.css : '');
  }

  const sheet = new CSSStyleSheet();
  function applyCss() {
    try { sheet.replaceSync(buildCss()); }
    catch (e) { console.warn('[YM Studio] CSS', e); }
    if (!document.adoptedStyleSheets.includes(sheet)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    const t = currentTheme();
    if (s.theme !== 'original' || isLayered()) send('caption', t.bg);
    else send('caption', '#000000');
  }

  /* ---------- Now playing ---------- */

  const now = { title: '', artist: '', cover: '', playing: false };

  function readMedia() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const title = md ? md.title : '';
    const artist = md ? md.artist : '';
    const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    const playing = isPlaying();
    const changed = title !== now.title || artist !== now.artist;
    const coverChanged = art !== now.cover;
    const stateChanged = playing !== now.playing;
    Object.assign(now, { title, artist, cover: art, playing });
    if (changed) {
      send('title', title ? `${title} — ${artist}` : '');
      if (title && s.trackToast) send('toast', `${title} — ${artist}`);
      if (title && s.autoMode === 'track') applyLook(luckyLook());
    }
    if (stateChanged) {
      document.documentElement.classList.toggle('yms-playing', !!playing);
      syncWallpaperPause();
    }
    if (coverChanged) onCover();
    if (changed || coverChanged || stateChanged) renderMini();
    watchStage();
    watchPage();
  }

  let coverImg = null;
  function onCover() {
    renderBackground();
    coverImg = null;
    if (now.cover) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { coverImg = img; };
      img.src = now.cover;
    }
    syncAccent();
  }

  let accentKey = '';
  function syncAccent() {
    if (!s.dynamic || !now.cover) { accentKey = ''; coverAccent = ''; return; }
    const key = now.cover + currentTheme().mode;
    if (key !== accentKey) { accentKey = key; extractAccent(now.cover, c => { coverAccent = c; }); }
  }

  function extractAccent(url, store) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 40;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 40, 40);
        const d = g.getImageData(0, 0, 40, 40).data;
        let best = null, bestScore = -1;
        const buckets = {};
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gr = d[i + 1], b = d[i + 2];
          const max = Math.max(r, gr, b), min = Math.min(r, gr, b);
          const sat = max ? (max - min) / max : 0;
          if (max < 60 || sat < 0.25) continue;
          const key = (r >> 4) + '-' + (gr >> 4) + '-' + (b >> 4);
          const bucket = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0, sat: 0 });
          bucket.n++; bucket.r += r; bucket.g += gr; bucket.b += b; bucket.sat += sat;
        }
        Object.keys(buckets).forEach(k => {
          const v = buckets[k];
          const score = v.n * (0.4 + v.sat / v.n);
          if (score > bestScore) { bestScore = score; best = v; }
        });
        store(best ? readable(best.r / best.n, best.g / best.n, best.b / best.n, currentTheme().mode === 'light') : '');
        applyCss();
        renderPanelAccent();
      } catch (e) { store(''); }
    };
    img.onerror = () => store('');
    img.src = url;
  }

  /* ---------- Site controls ---------- */

  const volumeInput = () => document.querySelector('[class*="ChangeVolume"] input[type=range]');
  const setNative = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  function setVolume(v) {
    const el = volumeInput();
    if (!el) return false;
    setNative.call(el, Math.max(0, Math.min(1, v)));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function nudgeVolume(delta) {
    const el = volumeInput();
    if (!el) return toast('Плеер ещё не готов: запустите трек на сайте.');
    setVolume(+el.value + delta);
    toast('Громкость ' + Math.round(+el.value * 100) + '%');
  }
  function toggleLike() {
    const b = document.querySelector('[class*="PlayerBarDesktopWithBackgroundProgressBar_root"] button[aria-label="Нравится"]');
    if (b) b.click();
    else toast('Плеер ещё не готов: запустите трек на сайте.');
  }

  function media(action) {
    if (action === 'mini') return setMini(!miniOn());
    if (action === 'stage') return setStage(!stageOn);
    if (action === 'like') return toggleLike();
    if (action === 'volUp') return nudgeVolume(0.05);
    if (action === 'volDown') return nudgeVolume(-0.05);
    if (action === 'toggle') action = now.playing ? 'pause' : 'play';
    if (action === 'next') action = 'nexttrack';
    if (action === 'prev') action = 'previoustrack';
    const fn = mediaHandlers[action];
    if (fn) fn({ action });
    else toast('Плеер ещё не готов: запустите трек на сайте.');
  }

  /* ---------- Layers ---------- */

  let bgVideo, bgLayer, bgMove, bgImage, bgDim, bgAurora, bgGrain, bgVignette, fxCanvas, fxCtx, canvas, ctx2d, ui, panel, miniEl;

  function grainTile() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() < 0.5 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.random() * 90;
    }
    g.putImageData(img, 0, 0);
    return `url("${c.toDataURL('image/png')}")`;
  }

  function renderBackground() {
    if (!bgLayer) return;
    const t = currentTheme();
    const A = currentAccent();
    bgLayer.style.display = isLayered() ? 'block' : 'none';
    bgLayer.style.background = s.bg === 'wallpaper' ? 'transparent' : t.bg;
    send('seethrough', seeThroughOn());
    renderVideo();
    let image = '';
    if (s.bg === 'cover' && now.cover) image = `url("${now.cover}")`;
    if (s.bg === 'image' && s.image) image = `url("${s.image}")`;
    if (s.bg === 'wevideo' && s.weVideo && s.weKind !== 'video') image = `url("/__yms/preview/${encodeURIComponent(s.weVideo)}")`;
    if (s.bg === 'gradient') {
      image = `radial-gradient(60% 70% at 15% 10%, ${alpha(A, 55)}, transparent), radial-gradient(60% 60% at 90% 90%, ${alpha(A, 35)}, transparent)`;
    }
    bgImage.style.backgroundImage = image;
    const photo = ['cover', 'image', 'wevideo'].includes(s.bg);
    bgImage.style.filter = `${photo ? `blur(${s.blur}px) ` : ''}saturate(${s.bgSat}%)`;

    bgAurora.style.display = s.bg === 'aurora' ? 'block' : 'none';
    bgAurora.style.filter = `saturate(${s.bgSat}%)`;
    const blobs = [A, shade(A, '#00e5ff', 60), shade(A, '#ff3db8', 60)];
    [...bgAurora.children].forEach((b, i) => { b.style.background = `radial-gradient(closest-side, ${blobs[i]}, transparent)`; });

    const shadeRgb = t.mode === 'light' ? '255,255,255' : '0,0,0';
    bgDim.style.background = s.bg === 'none' ? 'none' : `rgba(${shadeRgb},${s.dim / 100})`;
    bgGrain.style.opacity = s.grain / 100;
    bgVignette.style.background = s.vignette ? `radial-gradient(ellipse at center, transparent 45%, rgba(${shadeRgb},${s.vignette / 100}))` : 'none';
    if (!s.parallax && !s.bgPulse) bgMove.style.transform = '';
    fxCanvas.style.display = s.bgFx === 'none' ? 'none' : 'block';
    fx.dirty = true;
  }

  function renderVideo() {
    const on = s.bg === 'wevideo' && !!s.weVideo && s.weKind === 'video';
    bgVideo.style.display = on ? 'block' : 'none';
    if (!on) {
      if (bgVideo.getAttribute('src')) { bgVideo.pause(); bgVideo.removeAttribute('src'); bgVideo.load(); }
      return;
    }
    const src = '/__yms/video/' + encodeURIComponent(s.weVideo);
    if (bgVideo.getAttribute('src') !== src) bgVideo.src = src;
    bgVideo.style.filter = `blur(${s.blur}px) saturate(${s.bgSat}%)`;
    if (s.wePause && !now.playing) bgVideo.pause();
    else bgVideo.play().catch(() => {});
  }

  function placeCanvas() {
    if (!canvas) return;
    const on = curVis() !== 'off' && !miniOn();
    canvas.style.display = on ? 'block' : 'none';
    if (!on) return;
    const st = canvas.style;
    const behind = visBehind();
    const dpr = Math.min(window.devicePixelRatio || 1, behind ? 1.5 : 2);
    const height = behind ? window.innerHeight : stageOn ? Math.round(window.innerHeight * 0.22) : s.visHeight;
    st.zIndex = behind ? '-1' : '2147482000';
    st.height = height + 'px';
    st.opacity = s.visOpacity / 100;
    st.filter = s.visGlow ? `drop-shadow(0 0 7px ${currentAccent()})` : 'none';
    st.transform = !behind && !stageOn && s.visPos === 'top' ? 'scaleY(-1)' : 'none';
    if (stageOn) {
      st.top = 'auto';
      st.bottom = '0';
    } else if (behind || s.visPos === 'top') {
      st.top = '0';
      st.bottom = 'auto';
    } else {
      // The Vibe page has a large in-page player mid-screen: only a bar docked at the bottom counts.
      const bar = document.querySelector('[class*="PlayerBarDesktopWithBackgroundProgressBar_root"]');
      const top = bar ? bar.getBoundingClientRect().top : window.innerHeight;
      st.top = 'auto';
      st.bottom = (top > window.innerHeight * 0.6 ? Math.max(0, window.innerHeight - top) : 0) + 'px';
    }
    const w = Math.round(window.innerWidth * dpr), h = Math.round(height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  /* ---------- Sound analysis ---------- */

  const MAX_BARS = 160, SCOPE = 256;
  const levels = new Float32Array(MAX_BARS), peaks = new Float32Array(MAX_BARS), raw = new Float32Array(MAX_BARS);
  const scope = new Float32Array(SCOPE);
  const barCount = () => Math.max(16, Math.min(MAX_BARS, s.visCount));
  let signal = 'none', phase = 0, energy = 0, coverEl = null, coverCheck = 0;

  function readTaps(n) {
    if (!now.playing) return false;
    for (const tap of audio.taps.values()) {
      tap.analyser.getByteFrequencyData(tap.data);
      const size = tap.data.length;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        // Quadratic spacing: most musical energy lives in the low bins.
        const a = Math.floor(Math.pow(i / n, 2) * size * 0.7);
        const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / n, 2) * size * 0.7));
        let m = 0;
        for (let j = a; j < b; j++) m = Math.max(m, tap.data[j]);
        raw[i] = m / 255;
        sum += m;
      }
      if (sum > 0) {
        if (curVis() === 'line') {
          tap.analyser.getByteTimeDomainData(tap.wave);
          const step = tap.wave.length / SCOPE;
          for (let i = 0; i < SCOPE; i++) scope[i] = (tap.wave[Math.floor(i * step)] - 128) / 128;
        }
        return true;
      }
    }
    return false;
  }

  function sample(k) {
    const n = barCount();
    if (readTaps(n)) {
      signal = 'real';
      audio.lastSignal = performance.now();
    } else if (now.playing && performance.now() - audio.lastSignal > 1500) {
      signal = 'simulated';
      phase += 0.05 * k;
      const beat = Math.pow(Math.max(0, Math.sin(phase * 2.2)), 6);
      for (let i = 0; i < n; i++) {
        const fall = 1 - i / n;
        raw[i] = Math.max(0.02, fall * (0.25 + 0.6 * beat) * (0.55 + 0.45 * Math.sin(phase * 1.7 + i * 0.55)));
      }
      for (let i = 0; i < SCOPE; i++) scope[i] = 0.35 * Math.sin(i * 0.12 + phase * 3) * (0.5 + beat);
    } else if (!now.playing) {
      signal = 'idle';
      raw.fill(0);
      scope.fill(0);
    }
    const sens = s.visSens / 100;
    const release = (1 - s.visSmooth / 100 * 0.9) * 0.5;
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, raw[i] * sens);
      levels[i] += (v - levels[i]) * Math.min(1, (v > levels[i] ? 0.65 : release) * k);
      peaks[i] = Math.max(levels[i], peaks[i] - 0.007 * k);
    }
    const low = Math.max(2, Math.round(n / 14));
    let bass = 0;
    for (let i = 0; i < low; i++) bass += levels[i];
    energy += (bass / low - energy) * Math.min(1, 0.35 * k);
  }

  /* ---------- Visualizer ---------- */

  function paint(g, w, h) {
    const A = currentAccent();
    if (s.visColor === 'accent') return A;
    const fill = FULL_FRAME.includes(curVis()) ? g.createConicGradient(0, w / 2, h / 2) : g.createLinearGradient(0, 0, w, 0);
    if (s.visColor === 'gradient') {
      fill.addColorStop(0, A);
      fill.addColorStop(0.5, shade(A, '#00e5ff', 65));
      fill.addColorStop(1, A);
      return fill;
    }
    const drift = calm.matches ? 0 : performance.now() / 60;
    for (let i = 0; i <= 6; i++) fill.addColorStop(i / 6, `hsl(${drift + i * 60} 90% 62%)`);
    return fill;
  }

  // With "from centre" the bass sits mid-screen and the highs run out to both edges.
  function barValue(source, i, n) {
    if (!s.visCenter) return source[i];
    return source[Math.min(n - 1, Math.round(Math.abs(i - (n - 1) / 2) * 2))];
  }

  function drawBars(g, w, h, n, dpr) {
    const mirror = curVis() === 'mirror', dots = curVis() === 'dots';
    const slot = w / n, bw = Math.max(1, slot * 0.62), cell = 5 * dpr, gap = 2 * dpr;
    const scale = h * (mirror ? 0.5 : 0.95);
    const round = s.visRound && !dots;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const v = barValue(levels, i, n);
      if (v < 0.012) continue;
      const x = i * slot + (slot - bw) / 2;
      if (dots) {
        const count = Math.round(v * h / (cell + gap));
        for (let c = 0; c < count; c++) g.rect(x, h - (c + 1) * (cell + gap), bw, cell);
        continue;
      }
      const bh = v * scale;
      const y = mirror ? h / 2 - bh : h - bh;
      const height = mirror ? bh * 2 : bh;
      if (round) g.roundRect(x, y, bw, height, bw / 2);
      else g.rect(x, y, bw, height);
    }
    g.fill();
    if (!s.visPeaks) return;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const v = barValue(peaks, i, n);
      if (v < 0.02) continue;
      const x = i * slot + (slot - bw) / 2, y = mirror ? h / 2 - v * scale : h - v * scale;
      g.rect(x, y - 2 * dpr, bw, 2 * dpr);
      if (mirror) g.rect(x, h / 2 + v * scale, bw, 2 * dpr);
    }
    g.fill();
  }

  function drawWave(g, w, h, n) {
    g.beginPath();
    g.moveTo(0, h);
    let px = 0, py = h;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w, y = h - barValue(levels, i, n) * h * 0.92;
      g.quadraticCurveTo(px, py, (x + px) / 2, (y + py) / 2);
      px = x; py = y;
    }
    g.lineTo(w, py);
    g.lineTo(w, h);
    g.closePath();
    g.globalAlpha = 0.72;
    g.fill();
    g.globalAlpha = 1;
  }

  function drawLine(g, w, h, dpr) {
    g.lineWidth = 2.2 * dpr;
    g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < SCOPE; i++) {
      const x = (i / (SCOPE - 1)) * w, y = h / 2 + scope[i] * Math.min(1.6, s.visSens / 100) * h * 0.46;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }

  function drawCircle(g, w, h, n, dpr) {
    const cx = w / 2, cy = h / 2, base = Math.min(w, h) * 0.17 * (1 + energy * 0.08);
    const reach = Math.min(w, h) * 0.2;
    if (coverImg) {
      g.save();
      g.beginPath();
      g.arc(cx, cy, base * 0.92, 0, Math.PI * 2);
      g.clip();
      g.drawImage(coverImg, cx - base, cy - base, base * 2, base * 2);
      g.restore();
    }
    g.lineWidth = Math.max(2 * dpr, base * 6.28 / n * 0.55);
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i < n; i++) {
      // Both halves run bass to treble, so the ring stays symmetric and has no seam.
      const v = levels[Math.round(Math.abs(i - n / 2) / (n / 2) * (n - 1))];
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const c = Math.cos(a), d = Math.sin(a);
      g.moveTo(cx + c * base, cy + d * base);
      g.lineTo(cx + c * (base + 2 * dpr + v * reach), cy + d * (base + 2 * dpr + v * reach));
    }
    g.stroke();
  }

  // Spectrogram: the canvas scrolls up over itself and each frame adds one new row of sound.
  function drawFall(g, w, h, n, dpr) {
    const row = Math.max(1, Math.round(2 * dpr));
    g.globalCompositeOperation = 'copy';
    g.drawImage(canvas, 0, -row);
    g.globalCompositeOperation = 'source-over';
    const slot = w / n;
    for (let i = 0; i < n; i++) {
      const v = barValue(levels, i, n);
      if (v < 0.03) continue;
      g.globalAlpha = Math.min(1, v * 1.15);
      g.fillRect(i * slot, h - row, Math.ceil(slot), row);
    }
    g.globalAlpha = 1;
  }

  const sparks = [];
  function drawParticles(g, w, h, dpr, k) {
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const spawn = Math.min(14, Math.round(energy * energy * 22 * k));
    for (let i = 0; i < spawn && sparks.length < 320; i++) {
      const a = Math.random() * Math.PI * 2, v = (1.5 + Math.random() * 4 + energy * 5) * dpr;
      sparks.push({ x: cx, y: cy, dx: Math.cos(a) * v, dy: Math.sin(a) * v, life: 1, r: (1 + Math.random() * 2.4) * dpr });
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.x += p.dx * k;
      p.y += p.dy * k;
      p.life -= 0.012 * k;
      if (p.life <= 0) { sparks.splice(i, 1); continue; }
      g.globalAlpha = p.life;
      g.fillRect(p.x, p.y, p.r, p.r);
    }
    g.globalAlpha = 1;
  }

  let tunnelT = 0;
  function drawTunnel(g, w, h, n, dpr, k) {
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, reach = Math.hypot(w, h) / 2, rings = 12, points = 48;
    tunnelT = (tunnelT + (0.0025 + energy * 0.012) * k) % 1;
    g.lineWidth = 1.6 * dpr;
    for (let r = 0; r < rings; r++) {
      const depth = ((r / rings) + tunnelT) % 1;
      const radius = Math.pow(depth, 2.3) * reach;
      g.globalAlpha = Math.min(1, depth * 1.4) * 0.8;
      g.beginPath();
      for (let p = 0; p <= points; p++) {
        const a = (p / points) * Math.PI * 2;
        // Mirrored lookup, so the shape closes without a seam.
        const v = levels[Math.round(Math.abs(p / points * 2 - 1) * (n - 1))];
        const d = radius * (1 + v * 0.28);
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
        if (p) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  function draw(k) {
    const w = canvas.width, h = canvas.height, g = ctx2d, vis = curVis();
    const dpr = w / window.innerWidth, n = barCount();
    const style = paint(g, w, h);
    g.fillStyle = style;
    g.strokeStyle = style;
    if (vis === 'fall') return drawFall(g, w, h, n, dpr);
    if (vis === 'particles') return drawParticles(g, w, h, dpr, k);
    if (vis === 'tunnel') return drawTunnel(g, w, h, n, dpr, k);
    g.clearRect(0, 0, w, h);
    if (vis === 'wave') drawWave(g, w, h, n);
    else if (vis === 'line') drawLine(g, w, h, dpr);
    else if (vis === 'circle') drawCircle(g, w, h, n, dpr);
    else drawBars(g, w, h, n, dpr);
  }

  /* ---------- Background effects ---------- */

  const fx = { key: '', parts: [], sprite: null, spriteFor: '', w: 0, h: 0, dpr: 1, t: 0, dirty: true };
  const FX_COUNT = { stars: 240, snow: 130, rain: 150, sparks: 90, bokeh: 24, grid: 0 };

  function fxPrepare() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (fxCanvas.width !== w || fxCanvas.height !== h) { fxCanvas.width = w; fxCanvas.height = h; }
    const key = [s.bgFx, s.fxAmount, s.eco, w, h].join();
    Object.assign(fx, { w, h, dpr });
    if (key === fx.key) return;
    fx.key = key;
    fx.dirty = true;
    const count = Math.round((FX_COUNT[s.bgFx] || 0) * (s.fxAmount / 50) * (s.eco ? 0.5 : 1));
    fx.parts = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h, z: 0.3 + Math.random() * 0.7, p: Math.random() * 6.28
    }));
  }

  function bokehSprite(color) {
    if (fx.spriteFor === color) return fx.sprite;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.fill();
    fx.sprite = c;
    fx.spriteFor = color;
    return c;
  }

  function fxGrid(g, w, h, A, go) {
    const horizon = h * 0.56, sunR = h * 0.2 * (1 + energy * 0.1);
    const sun = g.createLinearGradient(0, horizon - sunR, 0, horizon);
    sun.addColorStop(0, shade(A, '#ffd166', 70));
    sun.addColorStop(1, A);
    g.globalAlpha = 0.85;
    g.fillStyle = sun;
    g.beginPath();
    g.arc(w / 2, horizon, sunR, Math.PI, 0);
    g.fill();
    g.strokeStyle = A;
    g.lineWidth = 1.2 * fx.dpr;
    g.globalAlpha = 0.55 + energy * 0.3;
    g.beginPath();
    for (let i = -14; i <= 14; i++) {
      g.moveTo(w / 2 + i * w * 0.012, horizon);
      g.lineTo(w / 2 + i * w * 0.14, h);
    }
    const rows = 13;
    fx.t += go * 0.006;
    for (let i = 0; i < rows; i++) {
      const y = horizon + (h - horizon) * Math.pow(((i / rows) + fx.t) % 1, 2.3);
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    g.stroke();
  }

  function drawFx(k) {
    fxPrepare();
    if (calm.matches && !fx.dirty) return;
    fx.dirty = false;
    const g = fxCtx, { w, h, dpr, parts } = fx;
    const theme = currentTheme(), A = currentAccent();
    const ink = theme.mode === 'light' ? theme.text : '#ffffff';
    const pump = s.fxReact ? energy : 0;
    const go = calm.matches ? 0 : k * (1 + pump * 2.4);
    g.clearRect(0, 0, w, h);
    g.globalAlpha = 1;

    if (s.bgFx === 'grid') { fxGrid(g, w, h, A, go); g.globalAlpha = 1; return; }
    if (s.bgFx !== 'bokeh' && s.bgFx !== 'stars') g.beginPath();
    fx.t += 0.016 * go;
    const sprite = s.bgFx === 'bokeh' ? bokehSprite(A) : null;
    for (const p of parts) {
      if (s.bgFx === 'stars') {
        p.y -= p.z * 0.05 * go * dpr;
        if (p.y < 0) p.y = h;
        g.globalAlpha = Math.min(1, (0.3 + 0.5 * Math.abs(Math.sin(fx.t * 1.6 * p.z + p.p))) * (1 + pump));
        g.fillStyle = p.z > 0.86 ? A : ink;
        const r = p.z * 1.9 * dpr * (1 + pump * 0.8);
        g.fillRect(p.x, p.y, r, r);
      } else if (s.bgFx === 'snow') {
        p.y += p.z * 0.9 * go * dpr;
        p.x += Math.sin(fx.t + p.p) * 0.35 * go * dpr;
        if (p.y > h) { p.y = -4; p.x = Math.random() * w; }
        const r = p.z * 2.3 * dpr;
        g.moveTo(p.x + r, p.y);
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
      } else if (s.bgFx === 'rain') {
        p.y += p.z * 11 * go * dpr;
        if (p.y > h) { p.y = -30 * dpr; p.x = Math.random() * w; }
        g.moveTo(p.x, p.y);
        g.lineTo(p.x, p.y + p.z * 26 * dpr);
      } else if (s.bgFx === 'sparks') {
        p.y -= p.z * 1.3 * go * dpr;
        p.x += Math.sin(fx.t * 1.5 + p.p) * 0.5 * go * dpr;
        if (p.y < 0) { p.y = h + 4; p.x = Math.random() * w; }
        const r = p.z * 2.1 * dpr * (1 + pump * 0.6);
        g.moveTo(p.x + r, p.y);
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
      } else if (sprite) {
        p.y -= p.z * 0.16 * go * dpr;
        p.x += Math.sin(fx.t * 0.4 + p.p) * 0.2 * go * dpr;
        if (p.y < -120 * dpr) { p.y = h + 120 * dpr; p.x = Math.random() * w; }
        const r = p.z * 110 * dpr * (1 + pump * 0.3);
        g.globalAlpha = 0.07 + 0.11 * p.z;
        g.drawImage(sprite, p.x - r / 2, p.y - r / 2, r, r);
      }
    }
    if (s.bgFx === 'snow') { g.globalAlpha = 0.75; g.fillStyle = ink; g.fill(); }
    if (s.bgFx === 'sparks') { g.globalAlpha = 0.85; g.fillStyle = A; g.fill(); }
    if (s.bgFx === 'rain') { g.globalAlpha = 0.45; g.strokeStyle = A; g.lineWidth = 1.3 * dpr; g.stroke(); }
    g.globalAlpha = 1;
  }

  const pointer = { x: 0, y: 0, ex: 0, ey: 0 };
  function moveBackground(k) {
    pointer.ex += (pointer.x - pointer.ex) * Math.min(1, 0.06 * k);
    pointer.ey += (pointer.y - pointer.ey) * Math.min(1, 0.06 * k);
    const shift = s.parallax ? 26 : 0;
    const zoom = s.bgPulse ? 1 + energy * 0.04 : 1;
    bgMove.style.transform = `translate3d(${(-pointer.ex * shift).toFixed(1)}px,${(-pointer.ey * shift).toFixed(1)}px,0) scale(${zoom.toFixed(4)})`;
  }

  let barTimer = 0;
  let navTimer = 0;
  function trackNav(e) {
    if (!s.navHide) return;
    const root = document.documentElement;
    const over = e.target instanceof Element && e.target.closest('[class*="Navbar_root"]');
    if (over || e.clientX <= 12) {
      clearTimeout(navTimer);
      navTimer = 0;
      root.classList.add('yms-nav-show');
    } else if (!navTimer) {
      navTimer = setTimeout(() => { navTimer = 0; root.classList.remove('yms-nav-show'); }, 500);
    }
  }

  function setBar(show) {
    const root = document.documentElement;
    if (root.classList.contains('yms-bar-show') === show) return;
    root.classList.toggle('yms-bar-show', show);
    setTimeout(placeCanvas, 240); // the visualizer rides on top of the bar
  }
  function trackBar(e) {
    if (!s.barHide) return;
    // The volume popup rises above the edge zone, and hiding the bar under it would close it mid-drag.
    const over = e.target instanceof Element && e.target.closest('[class*="PlayerBar"],[class*="ChangeVolume"]');
    if (over || e.clientY >= window.innerHeight - 110) {
      clearTimeout(barTimer);
      barTimer = 0;
      setBar(true);
    } else if (!barTimer) {
      barTimer = setTimeout(() => { barTimer = 0; setBar(false); }, 700);
    }
  }

  let lastFrame = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    const visOn = curVis() !== 'off' && canvas.style.display !== 'none';
    const fxOn = s.bgFx !== 'none';
    const moveOn = !calm.matches && (s.parallax || s.bgPulse);
    if (!(visOn || fxOn || moveOn || s.pulse || miniOn())) return;
    const dt = ts - lastFrame;
    if (dt < (s.eco ? 31 : 15)) return;
    lastFrame = ts;
    const k = Math.min(3, dt / 16.7);
    sample(k);
    if (visOn) draw(k);
    if (fxOn) drawFx(k);
    if (moveOn) moveBackground(k);
    if (miniOn()) drawMini();
    if (s.pulse) {
      if (ts - coverCheck > 1000) {
        coverCheck = ts;
        coverEl = document.querySelector('[class*="PlayerBarDesktopWithBackgroundProgressBar_cover"]');
      }
      if (coverEl) coverEl.style.boxShadow = `0 0 ${6 + energy * 26}px ${energy * 7}px ${alpha(currentAccent(), 20 + energy * 70)}`;
    }
    updateVisStatus();
  }

  /* ---------- UI ---------- */

  const UI_CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #fff !important;outline-offset:2px}
[hidden]{display:none !important}
.looks{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.look{all:unset;box-sizing:border-box;cursor:pointer;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.07);transition:background .15s,transform .12s}
.look:hover{background:rgba(255,255,255,.13);transform:translateY(-2px)}
.look b{display:block;font-size:13px;font-weight:600}
.look span{display:block;font-size:12px;color:#a9a9b3;margin-top:2px}
.lucky{all:unset;box-sizing:border-box;display:block;width:100%;text-align:center;cursor:pointer;margin-top:8px;padding:10px;border-radius:12px;font-size:14px;font-weight:600;background:var(--a);color:var(--on)}
.lucky:hover{filter:brightness(1.1)}
.wegrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.wev{all:unset;box-sizing:border-box;position:relative;cursor:pointer;border-radius:10px;overflow:hidden;border:2px solid transparent;background:rgba(255,255,255,.07)}
.wev i{position:absolute;left:5px;top:5px;padding:1px 6px;border-radius:6px;background:rgba(0,0,0,.72);color:#fff;font:600 12px "Segoe UI",sans-serif}
.wev.on{border-color:var(--a)}
.wev img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#26262e}
.wev span{display:block;padding:5px 7px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mylook{display:flex;align-items:center;gap:6px;margin-top:6px}
.mylook .look{flex:1;padding:8px 12px}
.input,input[type=time]{width:100%;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:#ececf1;border-radius:9px;padding:8px;font-size:13px;outline:none;color-scheme:dark}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px}
.field span{display:block;font-size:12px;color:#a9a9b3;margin-bottom:3px}
.hk{all:unset;box-sizing:border-box;text-align:center;min-width:128px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.09);font:12px Consolas,monospace;cursor:pointer}
.hk.wait{background:var(--a);color:var(--on)}
.hk.bad{outline:1px solid #ff6b5e}
.hkrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0;font-size:13px;color:#c9c9d2}
.fab{position:fixed;right:18px;bottom:104px;z-index:2147483000;width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;
  background:var(--a);color:var(--on);box-shadow:0 6px 20px rgba(0,0,0,.45);display:grid;place-items:center;transition:transform .18s}
.fab:hover{transform:scale(1.08) rotate(30deg)}
.fab svg{width:21px;height:21px}
.panel{position:fixed;top:0;right:0;bottom:0;width:372px;max-width:100vw;z-index:2147483001;display:flex;flex-direction:column;color:#ececf1;
  background:rgba(16,16,20,.93);backdrop-filter:blur(26px) saturate(1.3);border-left:1px solid rgba(255,255,255,.08);
  transform:translateX(102%);transition:transform .24s cubic-bezier(.2,.8,.2,1);box-shadow:-18px 0 50px rgba(0,0,0,.45)}
.panel.open{transform:none}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 18px 10px}
h1{font-size:18px;font-weight:650;margin:0}
h1 span{color:var(--a)}
.x{all:unset;cursor:pointer;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:#aaa;font-size:18px}
.x:hover{background:rgba(255,255,255,.09);color:#fff}
nav{display:flex;gap:4px;padding:0 14px 10px;flex-wrap:wrap}
nav button{all:unset;cursor:pointer;padding:6px 10px;border-radius:8px;font-size:13px;color:#a9a9b3}
nav button:hover{color:#fff}
nav button.on{background:var(--a);color:var(--on)}
.body{flex:1;overflow-y:auto;padding:4px 18px 22px}
.body::-webkit-scrollbar{width:8px}.body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:8px}
section{display:none}section.on{display:block}
h2{font-size:12px;letter-spacing:.04em;color:#8f8f9b;margin:18px 0 8px;font-weight:600}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.card{all:unset;cursor:pointer;border-radius:12px;padding:10px;border:2px solid transparent;display:block;transition:transform .12s}
.card:hover{transform:translateY(-2px)}
.card.on{border-color:var(--a)}
.card b{display:block;font-size:13px;font-weight:600}
.dots{display:flex;gap:4px;margin-top:8px}.dots i{width:16px;height:16px;border-radius:50%;display:block;border:1px solid rgba(128,128,128,.35)}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;font-size:14px}
.row small{display:block;color:#8f8f9b;font-size:12px;margin-top:2px}
.sw{position:relative;width:40px;height:23px;flex:none;appearance:none;margin:0;border-radius:23px;background:#3a3a44;cursor:pointer;transition:background .15s}
.sw:checked{background:var(--a)}
.sw::after{content:"";position:absolute;left:3px;top:3px;width:17px;height:17px;border-radius:50%;background:#fff;transition:left .15s}
.sw:checked::after{left:20px}
input[type=range]{width:100%;accent-color:var(--a);margin:2px 0 8px}
.lbl{display:flex;justify-content:space-between;font-size:13px;color:#c9c9d2;margin-top:8px}
.seg{display:flex;gap:4px;background:rgba(255,255,255,.06);border-radius:10px;padding:3px;flex-wrap:wrap}
.seg button{all:unset;cursor:pointer;flex:1;text-align:center;padding:6px 8px;border-radius:8px;font-size:13px;color:#b9b9c3;white-space:nowrap}
.seg button.on{background:var(--a);color:var(--on)}
.btn{all:unset;cursor:pointer;display:inline-block;padding:8px 12px;border-radius:9px;background:rgba(255,255,255,.09);font-size:13px;color:#ececf1;margin:4px 6px 4px 0}
.btn:hover{background:rgba(255,255,255,.16)}
.swatches{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.swatches button{all:unset;box-sizing:border-box;cursor:pointer;width:27px;height:27px;border-radius:50%;border:2px solid rgba(255,255,255,.15)}
.swatches button:hover{transform:scale(1.1)}
input[type=color]{width:27px;height:27px;padding:0;border:0;background:none;cursor:pointer}
input[type=color]::-webkit-color-swatch-wrapper{padding:0}
input[type=color]::-webkit-color-swatch{border:2px solid rgba(255,255,255,.35);border-radius:50%}
select,textarea{width:100%;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:#ececf1;border-radius:9px;padding:8px;font-size:13px;outline:none}
select option{background:#1a1a20}
textarea{height:300px;resize:vertical;font-family:Consolas,monospace;font-size:12.5px}
textarea:focus,select:focus{border-color:var(--a)}
.note{font-size:12px;color:#8f8f9b;line-height:1.45;margin:6px 0}
kbd{background:rgba(255,255,255,.1);border-radius:5px;padding:1px 6px;font:12px Consolas,monospace}
.keys{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:13px;color:#c9c9d2;align-items:center}
.toast{position:fixed;left:50%;bottom:112px;transform:translateX(-50%);z-index:2147483002;background:#1b1b22;color:#fff;font-size:13px;padding:9px 14px;border-radius:10px;box-shadow:0 8px 26px rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s;max-width:80vw}
.toast.on{opacity:1}
.mini{position:fixed;inset:0;z-index:2147483003;display:none;color:#fff;overflow:hidden;background:#0c0c10;-webkit-user-select:none;user-select:none}
.mini.on{display:flex;align-items:center;gap:12px;padding:12px}
.mini .art{position:absolute;inset:-30px;background-size:cover;background-position:center;filter:blur(26px) brightness(.45)}
.mini canvas{position:absolute;left:0;right:0;bottom:0;width:100%;height:46%;opacity:.5}
.mini img{position:relative;width:calc(100vh - 24px);height:calc(100vh - 24px);max-width:40vw;border-radius:12px;object-fit:cover;background:#26262e;flex:none}
.mini .meta{position:relative;min-width:0;flex:1}
.mini .t{font-size:15px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini .r{font-size:13px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.mini .ctl{display:flex;gap:6px;margin-top:9px;align-items:center}
.mini .ctl button{all:unset;cursor:pointer;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.14)}
.mini .ctl button:hover{background:rgba(255,255,255,.26)}
.mini .ctl button.main{background:var(--a);color:var(--on)}
.mini svg{width:17px;height:17px;fill:currentColor}
.mini .exit{margin-left:auto}
`;

  const ICONS = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.4"/><circle cx="8" cy="17" r="2.4"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M4 4h7v2H7.4l4.3 4.3-1.4 1.4L6 7.4V11H4zM20 20h-7v-2h3.6l-4.3-4.3 1.4-1.4 4.3 4.3V13h2z"/></svg>'
  };

  const ACCENTS = ['#ffcc00', '#ff5a5f', '#ff2bd6', '#a855f7', '#6366f1', '#3b82f6', '#22d3ee', '#22c55e', '#f97316'];
  const FONTS = ['', 'Segoe UI Variable Display', 'Bahnschrift', 'Georgia', 'Consolas', 'Verdana', 'Trebuchet MS', 'Candara'];

  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const seg = (key, options) => `<div class="seg" data-seg="${key}">${options.map(o => `<button data-v="${o[0]}">${o[1]}</button>`).join('')}</div>`;
  const sw = (key, title, hint) => `<label class="row"><span>${title}${hint ? `<small>${hint}</small>` : ''}</span><input class="sw" type="checkbox" data-key="${key}"></label>`;
  const range = (key, title, min, max, unit) => `<div class="lbl"><span>${title}</span><span data-out="${key}"></span></div><input type="range" min="${min}" max="${max}" data-key="${key}" data-unit="${unit || ''}" aria-label="${title}">`;
  const when = (rule, html) => `<div data-when="${rule}">${html}</div>`;

  const EQ_LABELS = ['60 Гц', '150 Гц', '400 Гц', '1 кГц', '2,4 кГц', '6 кГц', '15 кГц'];
  const EQ_PRESETS = {
    flat: { name: 'Ровно', bands: [0, 0, 0, 0, 0, 0, 0] },
    bass: { name: 'Бас', bands: [7, 5, 1, 0, 0, 0, 1] },
    rock: { name: 'Рок', bands: [4, 2, -1, -1, 2, 4, 4] },
    vocal: { name: 'Вокал', bands: [-2, -1, 1, 4, 4, 2, 0] },
    club: { name: 'Клуб', bands: [5, 3, 0, 2, 3, 3, 2] },
    night: { name: 'Ночь', bands: [-3, -2, 0, 1, 1, -1, -3] }
  };
  const HOTKEY_NAMES = {
    toggle: 'Пауза / воспроизведение', next: 'Следующий трек', prev: 'Предыдущий трек', like: 'Нравится',
    volUp: 'Громче', volDown: 'Тише', mini: 'Мини-плеер', stage: 'Сцена'
  };

  // Settings appear only where they would have a visible effect, to keep the panel short.
  const RULES = {
    image: () => s.bg === 'image',
    photo: () => ['cover', 'image', 'wevideo'].includes(s.bg),
    backdrop: () => s.bg !== 'none',
    fx: () => s.bgFx !== 'none',
    layered: isLayered,
    vis: () => s.vis !== 'off',
    strip: () => s.vis !== 'off' && !visBehind(),
    placeable: () => s.vis !== 'off' && !FULL_FRAME.includes(s.vis),
    bars: () => ['bars', 'mirror', 'dots'].includes(s.vis),
    density: () => s.vis !== 'off' && !['line', 'particles', 'tunnel'].includes(s.vis),
    centerable: () => ['bars', 'mirror', 'dots', 'wave', 'fall'].includes(s.vis),
    wallpaper: () => s.bg === 'wallpaper',
    wevideo: () => s.bg === 'wevideo',
    engine: () => s.bg === 'wallpaper' || s.bg === 'wevideo',
    autoTime: () => s.autoMode === 'time',
    eq: () => s.eqOn,
    roundable: () => s.vis === 'bars' || s.vis === 'mirror',
    calm: () => calm.matches
  };

  function panelHtml() {
    return `
<header><h1>YM <span>Studio</span></h1><button class="x" data-act="close" title="Закрыть (F2)" aria-label="Закрыть панель">✕</button></header>
<nav>
  <button data-tab="themes" class="on">Темы</button><button data-tab="bg">Фон</button><button data-tab="ui">Интерфейс</button>
  <button data-tab="vis">Визуализатор</button><button data-tab="sound">Звук</button><button data-tab="win">Окно</button><button data-tab="css">CSS</button>
</nav>
<div class="body">
<section data-sec="themes" class="on">
  <h2>ГОТОВЫЕ ОБРАЗЫ</h2>
  <div class="looks">${LOOKS.map((l, i) => `<button class="look" data-look="${i}"><b>${l.name}</b><span>${l.hint}</span></button>`).join('')}</div>
  <button class="lucky" data-act="lucky">Мне повезёт</button>
  <button class="lucky" data-act="stage">Сцена на весь экран</button>
  <h2>МОИ ОБРАЗЫ</h2>
  <div class="pair"><input class="input" data-look-name maxlength="24" placeholder="Название" aria-label="Название образа"><button class="btn" data-act="look-save">Сохранить текущий</button></div>
  <div data-my-looks></div>
  <h2>АВТОСМЕНА</h2>
  ${seg('autoMode', [['off', 'Выкл'], ['time', 'По времени'], ['track', 'На каждый трек']])}
  ${when('autoTime', `<div class="pair">
    <label class="field"><span>Днём с</span><input type="time" data-key="dayFrom"></label>
    <label class="field"><span>Вечером с</span><input type="time" data-key="nightFrom"></label>
    <label class="field"><span>Дневной образ</span><select data-key="dayLook" data-look-select aria-label="Дневной образ"></select></label>
    <label class="field"><span>Вечерний образ</span><select data-key="nightLook" data-look-select aria-label="Вечерний образ"></select></label>
  </div>`)}
  <div class="pair"><select data-page-look data-look-select aria-label="Образ для страницы"></select><button class="btn" data-act="page-bind">Для этой страницы</button></div>
  <p class="note" data-page-note></p>
  <h2>ТЕМА</h2>
  <div class="grid">${THEMES.map(t => `<button class="card" data-theme="${t.id}" style="background:${t.surface};color:${t.text}"><b>${t.name}</b><div class="dots"><i style="background:${t.bg}"></i><i style="background:${t.pop}"></i><i style="background:${t.accent}"></i></div></button>`).join('')}</div>
  <h2>АКЦЕНТ</h2>
  <div class="swatches">${ACCENTS.map(c => `<button data-accent="${c}" style="background:${c}" title="${c}" aria-label="Акцент ${c}"></button>`).join('')}<input type="color" data-accent-pick title="Свой цвет" aria-label="Свой цвет акцента"></div>
  <p><button class="btn" data-act="accent-reset">Цвет темы</button></p>
  ${sw('dynamic', 'Акцент из обложки', 'Цвет меняется вместе с треком')}
  <h2>ОБМЕН</h2>
  <button class="btn" data-act="export">Экспорт темы</button><button class="btn" data-act="import">Импорт</button><button class="btn" data-act="reset">Сбросить всё</button>
  <input type="file" accept=".json,application/json" data-file="theme" hidden>
</section>
<section data-sec="bg">
  ${when('calm', '<p class="note">В Windows отключены анимации, поэтому фон и эффекты неподвижны.</p>')}
  <h2>ФОН ПРИЛОЖЕНИЯ</h2>
  ${seg('bg', [['none', 'Нет'], ['gradient', 'Градиент'], ['aurora', 'Аврора'], ['cover', 'Обложка'], ['image', 'Картинка'], ['wevideo', 'Видео из WE'], ['wallpaper', 'Режим прозрачности']])}
  ${when('image', '<p><button class="btn" data-act="pick-image">Выбрать картинку…</button></p>')}
  ${when('wevideo', `<p class="note" data-wev-status></p>
  <div class="wegrid" data-wev-list></div>
  <p><button class="btn" data-act="wev-random">Случайное видео</button></p>`)}
  ${when('wallpaper', '<p class="note" data-we-status></p>')}
  ${when('engine', sw('weAccent', 'Цвета из обоев', 'Акцент берётся из превью'))}
  ${when('wevideo', sw('wePause', 'Пауза видео вместе с музыкой', 'Экономит видеокарту, пока музыка не играет'))}
  <input type="file" accept="image/*" data-file="image" hidden>
  ${when('photo', range('blur', 'Размытие', 0, 90, ' px'))}
  ${when('backdrop', range('dim', 'Затемнение', 0, 90, '%') + range('bgSat', 'Насыщенность', 0, 200, '%'))}
  <h2>ЭФФЕКТЫ</h2>
  ${seg('bgFx', [['none', 'Нет'], ['stars', 'Звёзды'], ['snow', 'Снег'], ['rain', 'Дождь'], ['sparks', 'Искры'], ['bokeh', 'Боке'], ['grid', 'Ретро-сетка']])}
  ${when('fx', range('fxAmount', 'Количество', 10, 100, '%') + sw('fxReact', 'Реакция на музыку', 'Быстрее и ярче на басах'))}
  ${when('layered', `<h2>ДВИЖЕНИЕ</h2>
  ${sw('bgMotion', 'Медленное приближение', 'Плавно движется картинка фона')}
  ${sw('bgPulse', 'Фон дышит в такт', 'Лёгкое увеличение на басах')}
  ${sw('parallax', 'Параллакс', 'Фон смещается за курсором')}
  <h2>ФАКТУРА</h2>
  ${range('grain', 'Плёночное зерно', 0, 50, '%')}
  ${range('vignette', 'Виньетка', 0, 90, '%')}
  <h2>ПАНЕЛИ</h2>
  ${range('glassOpacity', 'Плотность панелей', 0, 100, '%')}
  ${sw('glass', 'Размытие за панелями', 'Эффект матового стекла')}`)}
</section>
<section data-sec="ui">
  <h2>ФОРМА</h2>
  ${seg('radius', [['default', 'Обычные'], ['sharp', 'Острые'], ['soft', 'Мягкие']])}
  <h2>МАСШТАБ</h2>
  ${seg('uiZoom', [['90', '90%'], ['100', '100%'], ['110', '110%'], ['125', '125%']])}
  <h2>ШРИФТ</h2>
  <select data-key="font" aria-label="Шрифт">${FONTS.map(f => `<option value="${esc(f)}">${f ? esc(f) : 'Как на сайте'}</option>`).join('')}</select>
  <h2>ПЛЕЕР</h2>
  ${sw('island', 'Плеер-остров', 'Парящая панель со скруглением')}
  ${sw('barHide', 'Прятать плеер', 'Появляется, когда курсор у нижнего края окна')}
  ${sw('navHide', 'Прятать навигацию', 'Появляется, когда курсор у левого края окна')}
  ${sw('vinyl', 'Виниловая обложка', 'Круглая, вращается во время игры')}
  ${sw('pulse', 'Свечение обложки в такт', 'Реагирует на низкие частоты')}
  ${sw('progressGlow', 'Свечение полосы прогресса')}
  <h2>ОБЛОЖКИ</h2>
  ${seg('coverShape', [['default', 'Как есть'], ['square', 'Квадрат'], ['round', 'Мягкие'], ['circle', 'Круг']])}
  ${sw('hoverZoom', 'Приближение при наведении')}
  ${sw('tilt', '3D-наклон при наведении')}
  ${sw('mono', 'Чёрно-белые', 'Цвет появляется при наведении')}
  <h2>ЭФФЕКТЫ</h2>
  ${sw('titleGlow', 'Неоновые заголовки')}
  ${sw('pageFade', 'Плавное появление страниц')}
  ${sw('crt', 'Экран старого монитора', 'Строки развёртки поверх окна')}
  ${sw('slimScroll', 'Тонкие полосы прокрутки')}
  <h2>ПРОИЗВОДИТЕЛЬНОСТЬ</h2>
  ${sw('eco', 'Экономный режим', '30 кадров в секунду и вдвое меньше частиц')}
</section>
<section data-sec="vis">
  <h2>ВИЗУАЛИЗАТОР</h2>
  ${seg('vis', [['off', 'Выкл'], ['bars', 'Столбцы'], ['mirror', 'Зеркало'], ['dots', 'Точки'], ['wave', 'Волна'], ['line', 'Осциллограф'], ['fall', 'Водопад'], ['circle', 'Кольцо'], ['particles', 'Частицы'], ['tunnel', 'Туннель']])}
  <p class="note" data-vis-status></p>
  ${when('placeable', `<h2>ПОЛОЖЕНИЕ</h2>
  ${seg('visPos', [['player', 'Над плеером'], ['top', 'Сверху'], ['back', 'На фоне']])}`)}
  ${when('vis', `<h2>ЦВЕТ</h2>
  ${seg('visColor', [['accent', 'Акцент'], ['gradient', 'Градиент'], ['rainbow', 'Радуга']])}
  ${sw('visGlow', 'Неоновое свечение', 'Заметно нагружает видеокарту')}
  <h2>ЗВУК</h2>
  ${range('visSens', 'Чувствительность', 50, 200, '%')}
  ${range('visSmooth', 'Плавность', 0, 90, '%')}
  <h2>ВИД</h2>`)}
  ${when('strip', range('visHeight', 'Высота', 40, 260, ' px'))}
  ${when('vis', range('visOpacity', 'Непрозрачность', 15, 100, '%'))}
  ${when('density', range('visCount', 'Количество полос', 24, 160))}
  ${when('bars', sw('visPeaks', 'Падающие пики'))}
  ${when('roundable', sw('visRound', 'Скруглённые столбцы'))}
  ${when('centerable', sw('visCenter', 'От центра', 'Басы в середине, верхи по краям'))}
</section>
<section data-sec="sound">
  <h2>ЭКВАЛАЙЗЕР</h2>
  ${sw('eqOn', 'Включить эквалайзер', 'Выключен: звук идёт как на сайте')}
  ${when('eq', `${seg('eqPreset', Object.keys(EQ_PRESETS).map(k => [k, EQ_PRESETS[k].name]))}
  ${EQ_LABELS.map((l, i) => `<div class="lbl"><span>${l}</span><span data-eq-out="${i}"></span></div><input type="range" min="-12" max="12" step="1" data-eq="${i}" aria-label="Полоса ${l}">`).join('')}`)}
  <h2>ТАЙМЕР СНА</h2>
  <div class="seg" data-sleep>${[[0, 'Выкл'], [15, '15 мин'], [30, '30 мин'], [60, '1 час'], [90, '1,5 часа']].map(o => `<button data-min="${o[0]}">${o[1]}</button>`).join('')}</div>
  <p class="note" data-sleep-status>Громкость плавно снизится за последнюю минуту, потом музыка встанет на паузу.</p>
</section>
<section data-sec="win">
  <h2>ОКНО</h2>
  ${sw('pin', 'Поверх всех окон', 'Окно не уходит за другие программы. В полноэкранных играх лучше выключить')}
  ${sw('trayClose', 'Сворачивать в трей при закрытии', 'Музыка продолжит играть')}
  ${sw('trackToast', 'Уведомление о новом треке', 'Только когда окно не активно')}
  <p><button class="btn" data-act="mini">Мини-плеер</button></p>
  <h2>ГОРЯЧИЕ КЛАВИШИ (РАБОТАЮТ ВЕЗДЕ)</h2>
  <p class="note">Нажмите на сочетание, затем новые клавиши. Esc отменяет.</p>
  ${Object.keys(HOTKEY_NAMES).map(k => `<div class="hkrow"><span>${HOTKEY_NAMES[k]}</span><button class="hk" data-hk="${k}" aria-label="Сочетание: ${HOTKEY_NAMES[k]}"></button></div>`).join('')}
  <p class="note"><kbd>F2</kbd> открывает эту панель, пока окно приложения активно.</p>
</section>
<section data-sec="css">
  <h2>СВОЙ CSS</h2>
  <p class="note">Применяется сразу. Переменные сайта начинаются с <kbd>--ym-</kbd>.</p>
  <textarea data-key="css" spellcheck="false" placeholder="/* Например */&#10;[class*=&quot;NavbarDesktop_root&quot;] { opacity: .9; }"></textarea>
</section>
</div>`;
  }

  function syncPanel() {
    if (!panel) return;
    panel.querySelectorAll('[data-theme]').forEach(el => el.classList.toggle('on', el.dataset.theme === s.theme));
    panel.querySelectorAll('[data-seg]').forEach(group => {
      group.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(s[group.dataset.seg])));
    });
    panel.querySelectorAll('[data-key]').forEach(el => {
      const k = el.dataset.key;
      if (el.type === 'checkbox') el.checked = !!s[k];
      else if (el !== ui.activeElement) el.value = s[k];
      const out = panel.querySelector(`[data-out="${k}"]`);
      if (out) out.textContent = s[k] + (el.dataset.unit || '');
    });
    panel.querySelector('[data-accent-pick]').value = /^#[0-9a-f]{6}$/i.test(currentAccent()) ? currentAccent() : '#ffcc00';
    panel.querySelectorAll('[data-when]').forEach(el => { el.hidden = !RULES[el.dataset.when](); });
    panel.querySelectorAll('[data-eq]').forEach(el => {
      const i = +el.dataset.eq;
      el.value = s.eqBands[i];
      panel.querySelector(`[data-eq-out="${i}"]`).textContent = (s.eqBands[i] > 0 ? '+' : '') + s.eqBands[i] + ' дБ';
    });
    panel.querySelectorAll('[data-hk]').forEach(el => {
      if (el !== hkWaiting) el.textContent = (s.hotkeys[el.dataset.hk] || {}).label || 'Нет';
    });
    renderLooks();
    renderWallpaper();
    renderVideos();
    renderPanelAccent();
  }

  function allLooks() { return LOOKS.concat(s.myLooks); }
  const findLook = name => allLooks().find(l => l.name === name);

  function renderLooks() {
    const options = '<option value="">Не менять</option>' + allLooks().map(l => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('');
    panel.querySelectorAll('[data-look-select]').forEach(sel => {
      const value = sel.dataset.key ? s[sel.dataset.key] : sel.value;
      if (sel.dataset.options !== options) { sel.innerHTML = options; sel.dataset.options = options; }
      sel.value = value;
    });
    const list = panel.querySelector('[data-my-looks]');
    const key = JSON.stringify(s.myLooks.map(l => l.name));
    if (list.dataset.rendered !== key) {
      list.dataset.rendered = key;
      list.innerHTML = s.myLooks.map((l, i) => `<div class="mylook"><button class="look" data-mine="${i}"><b>${esc(l.name)}</b></button><button class="x" data-mine-del="${i}" aria-label="Удалить образ ${esc(l.name)}">✕</button></div>`).join('');
    }
    const bound = s.pageLooks[location.pathname];
    panel.querySelector('[data-page-note]').textContent = bound ? `Здесь включается образ «${bound}».` : 'Выберите образ, он будет включаться на этой странице или в плейлисте.';
  }

  /* ---------- Looks and automation ---------- */

  // Everything that isn't appearance survives a look change.
  const LOOK_KEEPS = ['image', 'css', 'uiZoom', 'eco', 'eqOn', 'eqBands', 'eqPreset', 'myLooks', 'autoMode', 'dayLook', 'nightLook', 'dayFrom', 'nightFrom',
    'pageLooks', 'trayClose', 'trackToast', 'hotkeys', 'barHide', 'navHide', 'wePause', 'weVideo', 'weKind', 'pin'];

  function snapshot() {
    const copy = {};
    Object.keys(DEFAULTS).forEach(k => { if (!LOOK_KEEPS.includes(k)) copy[k] = s[k]; });
    return copy;
  }

  function saveMyLook() {
    const field = panel.querySelector('[data-look-name]');
    const name = field.value.trim();
    if (!name) return toast('Введите название образа');
    if (LOOKS.some(l => l.name === name)) return toast('Такое имя уже занято готовым образом');
    s.myLooks = s.myLooks.filter(l => l.name !== name).concat({ name, set: snapshot() });
    field.value = '';
    refresh();
    toast('Образ сохранён: ' + name);
  }

  let timeLook = '';
  function checkSchedule() {
    if (s.autoMode !== 'time') { timeLook = ''; return; }
    const d = new Date();
    const clock = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const inDay = s.dayFrom <= s.nightFrom ? clock >= s.dayFrom && clock < s.nightFrom : clock >= s.dayFrom || clock < s.nightFrom;
    const name = inDay ? s.dayLook : s.nightLook;
    if (!name || name === timeLook) return;
    const look = findLook(name);
    if (look) { timeLook = name; applyLook(look.set); }
  }

  let lastPath = location.pathname, beforePage = null;
  function watchPage() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const look = findLook(s.pageLooks[lastPath]);
    if (look) {
      if (!beforePage) beforePage = snapshot();
      applyLook(look.set);
    } else if (beforePage) {
      applyLook(beforePage);
      beforePage = null;
    }
    renderLooks();
  }

  /* ---------- Stage ---------- */

  const fullscreenPlayer = () => document.querySelector('[class*="FullscreenPlayerDesktop_root"]');
  let fabEl;
  function setStage(on) {
    if (on === stageOn) return;
    if (on) {
      const open = document.querySelector('button[aria-label="Плеер на весь экран"]');
      if (!open) return toast('Сначала запустите трек');
      togglePanel(false);
      open.click();
    } else {
      const player = fullscreenPlayer();
      const close = player && player.querySelector('button[aria-label="Закрыть"]');
      if (close) close.click();
    }
    stageOn = on;
    fabEl.hidden = on;
    send('fullscreen', on);
    refresh();
    setTimeout(placeCanvas, 400);
  }
  let stageSeen = false;
  function watchStage() {
    if (!stageOn) { stageSeen = false; return; }
    if (fullscreenPlayer()) stageSeen = true;
    else if (stageSeen) setStage(false); // closed with the site's own button or Esc
  }

  /* ---------- Wallpaper Engine ---------- */

  let wallpaper = null, wallpaperWatched = false;

  function renderWallpaper() {
    const el = panel.querySelector('[data-we-status]');
    if (!el) return;
    if (!wallpaper) el.textContent = 'Ищу Wallpaper Engine…';
    else if (!wallpaper.installed) el.textContent = 'Wallpaper Engine не найден.';
    else if (!wallpaper.running) el.textContent = 'Wallpaper Engine не запущен.';
    else {
      const kinds = { scene: 'сцена', video: 'видео', web: 'веб' };
      el.textContent = `Сейчас: ${wallpaper.title || 'без названия'}${kinds[wallpaper.kind] ? ` (${kinds[wallpaper.kind]})` : ''}. Сквозь окно видны обои и всё, что лежит за ним.`
        + (wallpaper.pausesMaximized ? ' В настройках WE включена пауза при развёрнутом окне: разверните приложение, и обои замрут.' : '');
    }
  }

  function onWallpaper(info) {
    wallpaper = info;
    renderWallpaper();
    if (s.bg !== 'wallpaper') return;
    if (info.preview) extractAccent(info.preview, c => { wallpaperAccent = c; });
    else wallpaperAccent = '';
  }

  let weVideos = null, accentVideo = '';
  function onVideos(list) {
    const order = { video: 0, scene: 1, web: 2 };
    weVideos = list.slice().sort((a, b) => order[a.kind] - order[b.kind]);
    const current = weVideos.find(v => v.id === s.weVideo) || weVideos.find(v => v.kind === 'video') || weVideos[0];
    if (current) { s.weVideo = current.id; s.weKind = current.kind; }
    refresh();
  }

  function pickWallpaper(id) {
    s.weVideo = id;
    s.weKind = weVideos.find(v => v.id === id).kind;
    refresh();
  }

  function renderVideos() {
    const note = panel.querySelector('[data-wev-status]');
    const box = panel.querySelector('[data-wev-list]');
    if (!weVideos) { note.textContent = 'Ищу видео в Wallpaper Engine…'; return; }
    const count = kind => weVideos.filter(v => v.kind === kind).length;
    note.textContent = weVideos.length
      ? `Видео: ${count('video')}, сцены: ${count('scene')}, веб: ${count('web')}. Видео играет как есть. Сцены и веб-обои показываются как их превью: картинка или GIF. Живую анимацию рисует только сам Wallpaper Engine. Чтобы её увидеть, поставьте эти обои в WE и включите режим прозрачности.`
      : 'Библиотека Wallpaper Engine пуста.';
    const key = weVideos.map(v => v.id).join();
    if (box.dataset.rendered !== key) {
      box.dataset.rendered = key;
      const badge = { scene: 'Сцена', web: 'Веб' };
      box.innerHTML = weVideos.map(v => `<button class="wev" data-wev="${esc(v.id)}" title="${esc(v.title)}">${v.preview ? `<img alt="" loading="lazy" src="/__yms/preview/${encodeURIComponent(v.id)}">` : '<img alt="">'}${badge[v.kind] ? `<i>${badge[v.kind]}</i>` : ''}<span>${esc(v.title)}</span></button>`).join('');
    }
    box.querySelectorAll('[data-wev]').forEach(b => b.classList.toggle('on', b.dataset.wev === s.weVideo));
  }

  function syncVideoAccent() {
    if (s.bg !== 'wevideo' || !s.weVideo || accentVideo === s.weVideo) return;
    accentVideo = s.weVideo;
    extractAccent('/__yms/preview/' + encodeURIComponent(s.weVideo), c => { wallpaperAccent = c; });
  }

  function syncWallpaper() {
    const want = s.bg === 'wallpaper';
    if (want !== wallpaperWatched) {
      wallpaperWatched = want;
      send('we', want ? 'watch' : 'unwatch');
    }
    if (s.bg === 'wevideo' && !weVideos) send('we', 'videos');
    syncVideoAccent();
    syncWallpaperPause();
  }

  function syncWallpaperPause() {
    if (s.bg === 'wevideo') renderVideo();
  }

  /* ---------- Sleep timer ---------- */

  const sleep = { end: 0, timer: 0, volume: null };
  function setSleep(minutes) {
    clearInterval(sleep.timer);
    if (sleep.volume !== null) { setVolume(sleep.volume); sleep.volume = null; }
    sleep.end = minutes ? Date.now() + minutes * 60000 : 0;
    panel.querySelectorAll('[data-min]').forEach(b => b.classList.toggle('on', +b.dataset.min === minutes));
    if (minutes) sleep.timer = setInterval(tickSleep, 1000);
    tickSleep();
  }
  function tickSleep() {
    const note = panel.querySelector('[data-sleep-status]');
    if (!sleep.end) { note.textContent = 'Громкость плавно снизится за последнюю минуту, потом музыка встанет на паузу.'; return; }
    const left = sleep.end - Date.now();
    note.textContent = 'Пауза через ' + Math.ceil(left / 60000) + ' мин.';
    if (left <= 60000 && left > 0) {
      const el = volumeInput();
      if (el && sleep.volume === null) sleep.volume = +el.value;
      if (sleep.volume !== null) setVolume(sleep.volume * left / 60000);
    }
    if (left <= 0) {
      if (now.playing) media('pause');
      setSleep(0);
      panel.querySelectorAll('[data-min]').forEach(b => b.classList.toggle('on', +b.dataset.min === 0));
      toast('Таймер сна: музыка на паузе');
    }
  }

  /* ---------- Hotkeys ---------- */

  let hkWaiting = null;
  const sendHotkeys = () => send('hotkeys', Object.keys(s.hotkeys).filter(k => s.hotkeys[k]).map(k => ({ action: k, mods: s.hotkeys[k].mods, vk: s.hotkeys[k].vk })));
  const KEY_NAMES = { 32: 'Пробел', 37: '←', 38: '↑', 39: '→', 40: '↓' };

  function captureHotkey(e) {
    if (!hkWaiting) return false;
    e.preventDefault();
    e.stopPropagation();
    const action = hkWaiting.dataset.hk, button = hkWaiting;
    if (e.key === 'Escape') { hkWaiting = null; button.classList.remove('wait'); syncPanel(); return true; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return true;
    const mods = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.shiftKey ? 4 : 0);
    if (!mods && !/^F\d+$/.test(e.key)) { toast('Добавьте Ctrl, Alt или Shift'); return true; }
    const key = KEY_NAMES[e.keyCode] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const label = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
    s.hotkeys = Object.assign({}, s.hotkeys, { [action]: { mods, vk: e.keyCode, label } });
    hkWaiting = null;
    button.classList.remove('wait', 'bad');
    sendHotkeys();
    refresh();
    return true;
  }

  function renderPanelAccent() {
    if (!ui) return;
    const A = currentAccent();
    ui.host.style.setProperty('--a', A);
    ui.host.style.setProperty('--on', onColor(A));
  }

  let sentZoom = '', sentPin = null;
  function refresh() {
    save();
    syncAccent();
    applyCss();
    renderBackground();
    placeCanvas();
    syncPanel();
    if (!s.pulse && coverEl) { coverEl.style.boxShadow = ''; coverEl = null; }
    if (s.uiZoom !== sentZoom) { sentZoom = s.uiZoom; send('zoom', +s.uiZoom / 100); }
    if (s.pin !== sentPin) { sentPin = s.pin; send('topmost', s.pin); }
    applyEq(s.eqOn, s.eqBands);
    syncWallpaper();
    send('tray', s.trayClose);
    checkSchedule();
  }

  // A look replaces the visual setup but keeps what the user made or tuned for their machine.
  function applyLook(set) {
    const keep = {};
    LOOK_KEEPS.forEach(k => { keep[k] = s[k]; });
    Object.assign(s, DEFAULTS, keep, set);
    refresh();
  }

  const pick = list => list[Math.floor(Math.random() * list.length)];
  function luckyLook() {
    const vis = pick(['bars', 'mirror', 'dots', 'wave', 'line', 'fall', 'circle', 'particles', 'tunnel']);
    return {
      theme: pick(THEMES.filter(t => t.mode === 'dark' && t.id !== 'original')).id,
      bg: pick(['gradient', 'aurora', 'cover']),
      bgFx: pick(['none', 'stars', 'snow', 'rain', 'sparks', 'bokeh', 'grid']),
      vis,
      visColor: pick(['accent', 'gradient', 'rainbow']),
      visPeaks: Math.random() < 0.5,
      visCenter: Math.random() < 0.5,
      dynamic: Math.random() < 0.4,
      island: Math.random() < 0.6,
      radius: pick(['default', 'soft', 'sharp']),
      titleGlow: Math.random() < 0.4,
      vignette: pick([0, 30, 55]),
      grain: pick([0, 0, 10, 20])
    };
  }

  let toastTimer;
  function toast(text) {
    if (!ui) return;
    const el = ui.querySelector('.toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
  }

  function togglePanel(force) {
    const open = force === undefined ? !panel.classList.contains('open') : force;
    panel.classList.toggle('open', open);
  }

  function downscale(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1920 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  function exportTheme() {
    const data = Object.assign({}, s);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'ym-studio-theme.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function importTheme(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        Object.keys(DEFAULTS).forEach(k => {
          if (k in data && typeof data[k] === typeof DEFAULTS[k]) s[k] = data[k];
        });
        if (s.image && !/^data:image\//.test(s.image)) s.image = '';
        refresh();
        toast('Тема загружена');
      } catch (e) { toast('Это не файл темы YM Studio'); }
    };
    reader.readAsText(file);
  }

  function onClick(e) {
    const el = e.target.closest('button');
    if (!el) return;
    const d = el.dataset;
    if (d.tab) {
      panel.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b === el));
      panel.querySelectorAll('section').forEach(x => x.classList.toggle('on', x.dataset.sec === d.tab));
    } else if (d.theme) {
      s.theme = d.theme;
      s.accent = '';
      refresh();
    } else if (d.accent) {
      s.accent = d.accent;
      refresh();
    } else if (d.look !== undefined) {
      applyLook(LOOKS[+d.look].set);
      toast('Образ: ' + LOOKS[+d.look].name);
    } else if (d.mine !== undefined) {
      applyLook(s.myLooks[+d.mine].set);
    } else if (d.mineDel !== undefined) {
      s.myLooks = s.myLooks.filter((l, i) => i !== +d.mineDel);
      refresh();
    } else if (d.hk) {
      if (hkWaiting) hkWaiting.classList.remove('wait');
      hkWaiting = el;
      el.classList.add('wait');
      el.textContent = 'Нажмите клавиши…';
    } else if (d.wev !== undefined) {
      pickWallpaper(d.wev);
    } else if (d.min !== undefined) {
      setSleep(+d.min);
    } else if (d.v !== undefined) {
      const key = el.parentElement.dataset.seg;
      s[key] = d.v;
      if (key === 'bg' && d.v === 'image' && !s.image) panel.querySelector('[data-file="image"]').click();
      if (key === 'eqPreset') s.eqBands = EQ_PRESETS[d.v].bands.slice();
      refresh();
    } else if (d.act === 'lucky') applyLook(luckyLook());
    else if (d.act === 'stage') setStage(true);
    else if (d.act === 'look-save') saveMyLook();
    else if (d.act === 'wev-random') {
      const playable = (weVideos || []).filter(v => v.kind === 'video');
      if (playable.length) { s.weVideo = pick(playable).id; s.weKind = 'video'; refresh(); }
    }
    else if (d.act === 'page-bind') {
      const name = panel.querySelector('[data-page-look]').value;
      const map = Object.assign({}, s.pageLooks);
      if (name) map[location.pathname] = name; else delete map[location.pathname];
      s.pageLooks = map;
      refresh();
    }
    else if (d.act === 'close') togglePanel(false);
    else if (d.act === 'accent-reset') { s.accent = ''; refresh(); }
    else if (d.act === 'pick-image') panel.querySelector('[data-file="image"]').click();
    else if (d.act === 'export') exportTheme();
    else if (d.act === 'import') panel.querySelector('[data-file="theme"]').click();
    else if (d.act === 'reset') {
      if (confirm('Сбросить все настройки YM Studio?')) { Object.assign(s, DEFAULTS); refresh(); }
    } else if (d.act === 'mini') { togglePanel(false); setMini(true); }
  }

  function onInput(e) {
    const el = e.target;
    if (el.dataset.eq !== undefined) {
      s.eqBands = s.eqBands.map((v, i) => i === +el.dataset.eq ? +el.value : v);
      s.eqPreset = '';
      refresh();
    } else if (el.dataset.key) {
      const k = el.dataset.key;
      s[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
      refresh();
    } else if (el.dataset.accentPick !== undefined) {
      s.accent = el.value;
      refresh();
    }
  }

  async function onFile(e) {
    const el = e.target;
    if (!el.dataset.file || !el.files[0]) return;
    const file = el.files[0];
    el.value = '';
    if (el.dataset.file === 'theme') return importTheme(file);
    try {
      s.image = await downscale(file);
      s.bg = 'image';
      refresh();
    } catch (err) { toast('Не удалось открыть картинку'); }
  }

  function updateVisStatus() {
    const el = panel && panel.classList.contains('open') && panel.querySelector('[data-vis-status]');
    if (!el) return;
    const text = {
      real: 'Источник: реальный звук трека.',
      simulated: 'Источник: имитация. Сайт не отдаёт звук для анализа, поэтому анимация не связана с музыкой.',
      idle: 'Запустите трек, чтобы увидеть анализ звука.',
      none: 'Запустите трек, чтобы увидеть анализ звука.'
    }[signal];
    if (el.textContent !== text) el.textContent = text;
  }

  /* ---------- Mini player ---------- */

  const miniOn = () => document.documentElement.classList.contains('yms-mini');
  let miniCanvas, miniCtx;

  function setMini(on) { send('mini', on); }

  function applyMini(on) {
    document.documentElement.classList.toggle('yms-mini', on);
    miniEl.classList.toggle('on', on);
    placeCanvas();
    renderMini();
  }

  function renderMini() {
    if (!miniEl) return;
    miniEl.querySelector('.t').textContent = now.title || 'Ничего не играет';
    miniEl.querySelector('.r').textContent = now.artist || 'Запустите трек';
    const img = miniEl.querySelector('img');
    if (now.cover) { if (img.src !== now.cover) img.src = now.cover; } else img.removeAttribute('src');
    miniEl.querySelector('.art').style.backgroundImage = now.cover ? `url("${now.cover}")` : '';
    miniEl.querySelector('[data-m="toggle"]').innerHTML = now.playing ? ICONS.pause : ICONS.play;
  }

  function drawMini() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(miniCanvas.clientWidth * dpr), h = Math.round(miniCanvas.clientHeight * dpr);
    if (!w || !h) return;
    if (miniCanvas.width !== w || miniCanvas.height !== h) { miniCanvas.width = w; miniCanvas.height = h; }
    miniCtx.clearRect(0, 0, w, h);
    miniCtx.fillStyle = currentAccent();
    const n = barCount();
    const slot = w / n;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(1, levels[i] * h);
      miniCtx.fillRect(i * slot, h - bh, Math.max(1, slot * 0.6), bh);
    }
  }

  /* ---------- Mount ---------- */

  function mount() {
    const root = document.documentElement;

    bgLayer = document.createElement('div');
    bgLayer.id = 'yms-bg';
    bgLayer.style.cssText = 'position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;display:none';
    const layer = css => {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;' + css;
      return el;
    };
    // Parallax and the bass pulse transform this wrapper, the slow zoom transforms the image inside it.
    bgMove = layer('inset:0;will-change:transform');
    bgImage = layer('inset:-120px;background-size:cover;background-position:center;transition:background-image .6s');
    bgImage.id = 'yms-bg-image';
    bgAurora = layer('inset:-20%;display:none');
    ['left:2%;top:0', 'right:0;top:18%', 'left:26%;bottom:0'].forEach(place => {
      const blob = layer(place + ';width:62vw;height:62vw;will-change:transform');
      blob.className = 'yms-blob';
      bgAurora.appendChild(blob);
    });
    bgVideo = document.createElement('video');
    bgVideo.muted = true;
    bgVideo.loop = true;
    bgVideo.playsInline = true;
    bgVideo.style.cssText = 'position:absolute;left:-120px;top:-120px;width:calc(100% + 240px);height:calc(100% + 240px);object-fit:cover;display:none';
    bgMove.append(bgImage, bgVideo, bgAurora);
    bgDim = layer('inset:0');
    fxCanvas = document.createElement('canvas');
    fxCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none';
    fxCtx = fxCanvas.getContext('2d');
    bgGrain = layer(`inset:0;opacity:0;background-image:${grainTile()}`);
    bgVignette = layer('inset:0');
    bgLayer.append(bgMove, bgDim, fxCanvas, bgGrain, bgVignette);
    root.appendChild(bgLayer);

    canvas = document.createElement('canvas');
    canvas.id = 'yms-vis';
    canvas.style.cssText = 'position:fixed;left:0;right:0;width:100%;z-index:2147482000;pointer-events:none;display:none';
    ctx2d = canvas.getContext('2d');
    root.appendChild(canvas);

    const hostEl = document.createElement('yms-root');
    root.appendChild(hostEl);
    ui = hostEl.attachShadow({ mode: 'open' });
    const uiSheet = new CSSStyleSheet();
    uiSheet.replaceSync(UI_CSS);
    ui.adoptedStyleSheets = [uiSheet];

    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.title = 'YM Studio (F2)';
    fab.setAttribute('aria-label', 'Настройки YM Studio');
    fab.innerHTML = ICONS.gear;
    fab.addEventListener('click', () => togglePanel());
    fabEl = fab;

    panel = document.createElement('aside');
    panel.className = 'panel';
    panel.innerHTML = panelHtml();
    panel.addEventListener('click', onClick);
    panel.addEventListener('input', onInput);
    panel.addEventListener('change', onFile);

    const toastEl = document.createElement('div');
    toastEl.className = 'toast';

    miniEl = document.createElement('div');
    miniEl.className = 'mini';
    miniEl.innerHTML = `<div class="art"></div><canvas></canvas><img alt=""><div class="meta"><div class="t"></div><div class="r"></div>
<div class="ctl"><button data-m="prev" aria-label="Предыдущий трек">${ICONS.prev}</button><button data-m="toggle" class="main" aria-label="Пауза или воспроизведение">${ICONS.play}</button><button data-m="next" aria-label="Следующий трек">${ICONS.next}</button><button data-m="exit" class="exit" title="Вернуться в полное окно" aria-label="Вернуться в полное окно">${ICONS.expand}</button></div></div>`;
    miniEl.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.m === 'exit') setMini(false); else media(b.dataset.m);
    });
    miniCanvas = miniEl.querySelector('canvas');
    miniCtx = miniCanvas.getContext('2d');

    ui.append(fab, panel, toastEl, miniEl);

    window.addEventListener('keydown', e => {
      if (captureHotkey(e)) return;
      if (e.key === 'F2') { e.preventDefault(); togglePanel(); }
      if (e.key === 'Escape' && panel.classList.contains('open')) togglePanel(false);
    }, true);
    window.addEventListener('mousemove', e => {
      pointer.x = e.clientX / window.innerWidth * 2 - 1;
      pointer.y = e.clientY / window.innerHeight * 2 - 1;
      trackBar(e);
      trackNav(e);
    }, { passive: true });
    root.addEventListener('mouseleave', () => {
      if (s.barHide && !barTimer) barTimer = setTimeout(() => { barTimer = 0; setBar(false); }, 700);
    });
    calm.addEventListener('change', refresh);
    window.addEventListener('resize', placeCanvas);
    setInterval(placeCanvas, 2000);
    setInterval(readMedia, 700);
    setInterval(checkSchedule, 30000);

    if (host) {
      host.addEventListener('message', e => {
        const m = e.data;
        if (!m) return;
        if (m.type === 'media') media(m.value);
        if (m.type === 'we') onWallpaper(m.value);
        if (m.type === 'wevideos') onVideos(m.value);
        if (m.type === 'hotkeys') {
          panel.querySelectorAll('[data-hk]').forEach(b => b.classList.toggle('bad', m.value.includes(b.dataset.hk)));
          if (m.value.length) toast('Не все сочетания свободны: они заняты другой программой');
        }
        if (m.type === 'state') {
          applyMini(!!m.value.mini);
        }
      });
      send('ready');
      sendHotkeys();
    }

    refresh();
    readMedia();
    requestAnimationFrame(loop);
  }

  window.__ymStudio = { settings: s, audio, now, media, get signal() { return signal; }, get stage() { return stageOn; }, refresh, setVolume, setSleep, sleep, tickSleep, findLook, onWallpaper };

  applyCss();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
