/* ============================================================================
   scroll-world — portable scroll-scrubbed camera-flight engine
   ----------------------------------------------------------------------------
   Framework-agnostic. Vanilla JS, zero dependencies. It builds its own DOM and
   injects its own (namespaced) CSS into a container you give it, so it drops into
   plain HTML, Next.js (call from a ref/useEffect), Vue (onMounted), a server-
   rendered page, anything.

   USAGE
     mountScrollWorld(document.getElementById('world'), {
       brand: { name: 'Pearl & Co.', href: '#top' },
       diveScroll: 1.3,   // viewport-heights of scroll per dive clip
       connScroll: 0.9,   // ...per connector clip
       hint: 'scroll to fly in',
       nav: true,         // show the top section nav
       atmosphere: true,  // subtle gradient + drifting particles behind the clips
       sections: [
         { id, label, still, clip, clipMobile, accent,
           scroll: 1.6,   // optional per-section override of diveScroll — more scroll
                          // distance = a slower, longer dwell in this scene
           linger: 0.5,   // optional 0..1 — remaps time so the camera settles mid-scene
                          // (exactly where the copy peaks) and moves quicker at the
                          // edges. 0 = linear (default). Keep ≤ 0.6; 1 = full pause.
           eyebrow, title, body, tags:[…],
           cta:{ primary:{label,href}, secondary:{label,href} } }, // last section only
         …
       ],
       connectors: [clipUrl, …],          // length = sections.length - 1 (nulls allowed)
       connectorsMobile: [clipUrl, …],    // optional lighter connectors for phones (same length)

   MOBILE (the clipMobile/connectorsMobile variants are the opt-in "mobile beta";
   the rest of the phone handling below is always on)
     The engine is phone-aware out of the box: on a coarse-pointer / ≤860px viewport it
       - loads `clipMobile` / `connectorsMobile` when provided (encode these smaller +
         tighter-GOP — seek cost on a phone decoder is dominated by frames-from-keyframe,
         so a 720p, -g 4 file scrubs far smoother than the 1080p desktop master; see
         pipeline.md). Falls back to the desktop `clip` if no mobile variant is given.
       - coalesces seeks (never issues a new currentTime while the decoder is still
         `seeking`) so fast flicks can't pile up and freeze the video.
       - keeps the still as a live poster until the clip actually paints its first frame,
         and primes each video (muted play→pause) on first touch — this is what stops iOS
         from showing a blank scene before the first seek.
       - drops the drifting particles and ignores URL-bar-only resizes (no scroll jump).
     Nothing here is required — a config with only `clip`/`connectors` still works on
     phones; the mobile variants just make it lighter and smoother.

   THEME (CSS custom properties; set on the container or :root to override)
     --sw-bg         page background (match your scene bg for seamless posters)
     --sw-ink        primary text
     --sw-ink-soft   secondary text
     --sw-accent     default accent (each section overrides via its `accent`)
     --sw-font-display / --sw-font-body

   REQUIREMENTS ON YOUR ASSETS
     - clips encoded native-res, crf~20, -g 8, +faststart, no audio (see pipeline.md)
     - connectors' endpoints are the neighbouring dives' ACTUAL frames (see SKILL Step 5)
     - (optional) mobile variants at ~720p, -g 4 for smoother phone scrubbing
   The engine loads each clip as a Blob (always seekable) and scrubs currentTime; it does
   NOT depend on HTTP byte-range support.
   ========================================================================== */

function mountScrollWorld(container, config) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Phone detection. `coarse` is captured once (input type doesn't change mid-session);
  // the ≤860px query is read live via isMobile() so a desktop resize/DevTools toggle
  // switches sources and seek behaviour without a reload.
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const smallMQ = window.matchMedia('(max-width: 860px)');
  const isMobile = () => coarse || smallMQ.matches;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const lowMemory = Number(navigator.deviceMemory || 8) <= 4;
  const lowCpu = Number(navigator.hardwareConcurrency || 8) <= 4;
  const saveData = Boolean(connection && connection.saveData);
  const isLite = () => isMobile() || lowMemory || lowCpu || saveData;
  const SECTIONS = config.sections || [];
  const CONNECTORS = config.connectors || [];
  const CONNECTORS_M = config.connectorsMobile || [];
  const DIVE_W = config.diveScroll || 1.3;
  const CONN_W = config.connScroll || 0.9;
  const CROSSFADE = (config.crossfade != null) ? config.crossfade : 0.12;  // seam dissolve width (vh)
  const N = SECTIONS.length;
  if (!N) return;

  injectCSS();
  container.classList.add('sw-root');
  let liteMode = isLite();
  let playbackMode = isMobile();
  let activePlaybackSegment = -1;
  container.classList.toggle('sw-lite', liteMode);
  container.classList.toggle('sw-playback', playbackMode);

  // ---- build the interleaved segment chain: dive0, conn0, dive1, … diveN-1 ----
  const SEGMENTS = [];
  SECTIONS.forEach((s, i) => {
    // Keep the reading estimate as QA metadata, but mobile navigation is deliberately
    // one viewport per scene: the visitor controls dwell time and one gesture advances
    // exactly one story beat.
    const copyText = [s.eyebrow, s.title, s.body, s.cta && s.cta.primary && s.cta.primary.label]
      .filter(Boolean).join(' ').trim();
    const copyWords = copyText ? copyText.split(/\s+/).length : 0;
    const readSeconds = 1.2 + copyWords / (200 / 60);
    const mobileW = s.mobileScroll || 1;
    const dive = { kind: 'dive', si: i, clip: s.clip, clipM: s.clipMobile || s.clipLite, still: s.still, accent: s.accent,
                   w: s.scroll || DIVE_W, mobileW, copyWords, readSeconds, linger: s.linger || 0 };
    SEGMENTS.push(dive);
    s._seg = dive;
    // A connector is optional: if connectors[i] is falsy, the two dives simply
    // crossfade directly (no fly-over). Lets a page complete even when a
    // connector can't be generated (e.g. a content-filter false-positive).
    if (i < N - 1 && CONNECTORS[i]) {
      SEGMENTS.push({ kind: 'conn', si: i, clip: CONNECTORS[i], clipM: CONNECTORS_M[i],
                      still: SECTIONS[i + 1].still, accent: SECTIONS[i + 1].accent, w: CONN_W });
    }
  });
  const NSEG = SEGMENTS.length;

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) {
    sky.appendChild(el('div', 'sw-sky__grad'));
    sky.appendChild(el('div', 'sw-sky__glow'));
  }
  const particles = el('div', 'sw-particles'); sky.appendChild(particles);

  const scrollbar = el('div', 'sw-scrollbar');
  const scrollbarFill = el('span'); scrollbar.appendChild(scrollbarFill);

  const topbar = el('div', 'sw-topbar');
  if (config.brand) {
    const brand = el('a', 'sw-brand'); brand.href = (config.brand.href || '#');
    brand.appendChild(el('span', 'sw-brand__mark'));
    const nm = el('span', 'sw-brand__name'); nm.textContent = config.brand.name || ''; brand.appendChild(nm);
    topbar.appendChild(brand);
  }
  const nav = el('nav', 'sw-nav'); if (config.nav !== false) topbar.appendChild(nav);
  if (config.cta && config.cta.label) {
    const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label;
    topbar.appendChild(c);
  }

  const stage = el('div', 'sw-stage');
  const copylayer = el('div', 'sw-copylayer');
  const route = el('div', 'sw-route');
  const hint = el('div', 'sw-hint');
  const defaultHint = config.hint || 'scroll';
  const hintText = el('span'); hintText.textContent = playbackMode ? 'Swipe for next scene' : defaultHint; hint.appendChild(hintText);
  hint.appendChild(el('i'));
  const track = el('div', 'sw-track');

  [sky, scrollbar, topbar, stage, copylayer, route, hint, track].forEach(n => container.appendChild(n));

  // segment scenes
  SEGMENTS.forEach((s, index) => {
    const scene = el('div', 'sw-scene'); scene.style.setProperty('--sw-accent', s.accent || '');
    const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = index === 0 ? 'sync' : 'async'; img.loading = index === 0 ? 'eager' : 'lazy';
    if (index === 0) img.fetchPriority = 'high';
    if (s.still) img.src = s.still;
    img.draggable = false;
    if (s.copyWords) scene.dataset.copyWords = String(s.copyWords);
    if (s.readSeconds) scene.dataset.readSeconds = s.readSeconds.toFixed(1);
    if (s.mobileW) scene.dataset.mobileVh = s.mobileW.toFixed(2);
    scene.appendChild(img); stage.appendChild(scene);
    s.el = scene; s.img = img; s.video = null; s.hasClip = false;
    s.loading = false; s.ready = false; s.cur = 0; s.target = 0; s.visible = false;
    s.objectUrl = null; s.loadToken = 0;
  });

  // per-section copy / route / nav
  const copies = [], dots = [];
  SECTIONS.forEach((s, i) => {
    const c = el('article', 'sw-copy'); c.style.setProperty('--sw-accent', s.accent || '');
    c.innerHTML =
      `<span class="sw-copy__num">${pad(i + 1)} / ${pad(N)}</span>` +
      (s.eyebrow ? `<span class="sw-copy__eyebrow">${esc(s.eyebrow)}</span>` : '') +
      (s.title ? `<h2 class="sw-copy__title">${esc(s.title)}</h2>` : '') +
      (s.body ? `<p class="sw-copy__body">${esc(s.body)}</p>` : '') +
      (s.tags && s.tags.length ? `<ul class="sw-copy__tags">${s.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (s.cta ? `<div class="sw-copy__cta">${ctaBtns(s.cta)}</div>` : '');
    copylayer.appendChild(c); copies.push(c);

    const dot = el('button', 'sw-route__dot'); dot.style.setProperty('--sw-accent', s.accent || '');
    dot.innerHTML = `<span class="sw-route__label">${esc(s.label || '')}</span><i></i>`;
    dot.addEventListener('click', () => jumpTo(i)); route.appendChild(dot); dots.push(dot);

    if (config.nav !== false) {
      const b = el('button', 'sw-nav__item'); b.textContent = s.label || '';
      b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b);
    }
  });

  // ---- math ----
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  // Per-section dwell: monotone remap of scroll→time so the camera settles mid-scene
  // (where the copy peaks) and moves quicker near the seams. L=0 linear, L=1 full
  // mid-scene pause. f(0)=0, f(1)=1 always, so seam frames are untouched.
  const lingerEase = (x, L) => { L = clamp(L); const c = x - 0.5; return (1 - L) * x + L * (4 * c * c * c + 0.5); };
  let vh = window.innerHeight, stageX = 0, totalW = 0, activeIndex = -1, ticking = false;
  let laidOutW = window.innerWidth;   // width the current layout was computed at (see onResize)

  function layout() {
    vh = window.innerHeight;
    laidOutW = window.innerWidth;
    stageX = window.innerWidth > 860 ? 4 : 0;
    let off = 0;
    SEGMENTS.forEach(s => {
      const segmentW = playbackMode && s.kind === 'dive' ? s.mobileW : s.w;
      s.start = off * vh; off += segmentW; s.end = off * vh;
    });
    totalW = off;
    track.style.height = (totalW * vh + vh) + 'px';   // +1vh so the last flight completes
    read();
  }

  function jumpTo(i) {
    const seg = SECTIONS[i]._seg;
    window.scrollTo({
      top: container.offsetTop + seg.start + (seg.end - seg.start) * 0.5,
      behavior: (reduce || playbackMode) ? 'auto' : 'smooth',
    });
  }

  function loadClip(s) {
    // Under prefers-reduced-motion we never load the clips at all — the stills stay up
    // and simply cross-dissolve as you scroll. No scrubbed video motion, no decode cost.
    if (reduce || s.loading || s.hasClip || !s.clip) return;
    s.loading = true;
    const token = ++s.loadToken;
    // Phones and lite devices receive the 720p source so sequential playback stays
    // smooth without decoding a 1080p frame on every scroll step. Full desktops keep
    // the 1080p source and deterministic blob-based scrubbing.
    const url = ((playbackMode || liteMode) && s.clipM) ? s.clipM : s.clip;

    const attachVideo = source => {
      if (token !== s.loadToken) {
        if (source.objectUrl) try { URL.revokeObjectURL(source.objectUrl); } catch (e) {}
        return;
      }
      const v = document.createElement('video');
      v.className = 'sw-scene__video';
      v.muted = true; v.playsInline = true; v.preload = playbackMode ? 'auto' : 'metadata';
      v.disablePictureInPicture = true; v.draggable = false;
      v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
      v.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback');
      s.objectUrl = source.objectUrl || null;
      v.src = source.url;
      v.addEventListener('loadedmetadata', () => { s.ready = true; read(); });
      // The poster remains visible until the browser has decoded a real frame.
      v.addEventListener('loadeddata', () => {
        s.el.classList.add('has-clip');
        if (playbackMode && s.playbackActive) playVideo(v);
        else try { v.pause(); } catch (e) {}
      }, { once: true });
      v.addEventListener('playing', () => { s.el.classList.add('has-clip'); }, { once: true });
      if (!playbackMode) v.addEventListener('seeked', () => { s.el.classList.add('has-clip'); }, { once: true });
      s.el.appendChild(v); s.video = v; s.hasClip = true; s.loading = false;
      if (playbackMode && s.playbackActive) playVideo(v);
    };

    if (playbackMode) {
      attachVideo({ url });
      return;
    }

    fetch(url).then(r => r.ok ? r.blob() : Promise.reject(new Error('404')))
      .then(blob => {
        const objectUrl = URL.createObjectURL(blob);
        attachVideo({ url: objectUrl, objectUrl });
      }).catch(() => { if (token === s.loadToken) s.loading = false; });
  }

  function unloadClip(s) {
    if (!s.video && !s.loading) return;
    s.loadToken += 1;
    s.loading = false; s.ready = false; s.hasClip = false;
    if (s.video) {
      try { s.video.pause(); s.video.removeAttribute('src'); s.video.load(); s.video.remove(); } catch (e) {}
    }
    if (s.objectUrl) {
      try { URL.revokeObjectURL(s.objectUrl); } catch (e) {}
    }
    s.video = null; s.objectUrl = null;
    s.el.classList.remove('has-clip');
  }

  function read() {
    const pageY = window.scrollY || window.pageYOffset;
    const y = Math.max(0, pageY - container.offsetTop);
    const fade = (playbackMode ? Math.max(CROSSFADE, 0.16) : CROSSFADE) * vh;
    let ci = 0;
    for (let i = 0; i < NSEG; i++) if (y >= SEGMENTS[i].start) ci = i;
    const releaseWorld = y > totalW * vh + 0.7 * vh;
    if (playbackMode) activePlaybackSegment = releaseWorld ? -1 : ci;

    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      s.playbackActive = playbackMode && !releaseWorld && i === ci;
      if (releaseWorld) {
        unloadClip(s);
      } else if (playbackMode) {
        if (i === ci) loadClip(s);
        else unloadClip(s);
      } else if (liteMode) {
        if (Math.abs(i - ci) <= 1) loadClip(s);
        else unloadClip(s);
      } else if (y > s.start - 1.2 * vh && y < s.end + 1.2 * vh) {
        loadClip(s);
      }
      const local = clamp((y - s.start) / (s.end - s.start), 0, 1);
      s.target = s.linger ? lingerEase(local, s.linger) : local;
      let outside = 0;
      if (y < s.start) outside = s.start - y; else if (y > s.end) outside = y - s.end;
      // Hold the final poster until the whole fixed world fades into the next section.
      // Without this, the scene itself disappears early and exposes a dark gap.
      if (i === NSEG - 1 && y > s.end) outside = 0;
      const op = smooth(1 - outside / fade);
      s.el.style.opacity = op; s.visible = op > 0.001;
      // Ordered stacking makes the arriving scene genuinely fade over the current one.
      // Putting the current scene on top caused an apparent cut exactly at the boundary.
      s.el.style.zIndex = String(100 + i);
      if (!s.hasClip || !s.ready) {
        const sc = reduce ? 1 : 1.03 + local * 0.14;
        s.img.style.transform = `translateX(${stageX - 2}vw) scale(${sc.toFixed(3)})`;
      }
    }

    if (playbackMode && !releaseWorld) {
      const active = SEGMENTS[ci];
      if (active && active.video && active.video.paused && !active.video.ended && !document.hidden) playVideo(active.video);
    }

    const cur = SEGMENTS[ci];
    const near = clamp(cur.kind === 'dive' ? cur.si
      : (((y - cur.start) / (cur.end - cur.start)) > 0.5 ? cur.si + 1 : cur.si), 0, N - 1);

    for (let i = 0; i < N; i++) {
      const seg = SECTIONS[i]._seg;
      const pr = clamp((y - seg.start) / (seg.end - seg.start), 0, 1);
      const before = y < seg.start, after = y > seg.end;
      let cop;
      if (playbackMode) cop = i === near ? 1 : 0;                     // stable reading state on phones
      else if (i === 0) cop = after ? 0 : smooth(1 - pr / 0.62);      // greets on landing
      else if (i === N - 1) cop = before ? 0 : smooth(pr / 0.4);       // holds CTA at the end
      else cop = (before || after) ? 0 : smooth(1 - Math.abs(pr - 0.5) / 0.5);
      const c = copies[i];
      c.style.opacity = cop;
      c.style.transform = (reduce || playbackMode) ? 'none' : `translateY(${(0.5 - pr) * 4}vh)`;
      c.style.pointerEvents = cop > 0.5 ? 'auto' : 'none';
    }

    if (near !== activeIndex) {
      activeIndex = near;
      dots.forEach((d, k) => d.classList.toggle('is-active', k === near));
      nav.querySelectorAll('.sw-nav__item').forEach((n, k) => n.classList.toggle('is-active', k === near));
      container.style.setProperty('--sw-accent', SECTIONS[near].accent || '');
    }
    const exit = smooth(clamp((y - totalW * vh) / (0.72 * vh)));
    const worldOpacity = 1 - exit;
    if (exit > 0.98) { SEGMENTS.forEach(unloadClip); activePlaybackSegment = -1; }
    [sky, scrollbar, topbar, stage, copylayer, route].forEach(node => { node.style.opacity = worldOpacity; });
    topbar.style.pointerEvents = worldOpacity > 0.08 ? '' : 'none';
    scrollbarFill.style.transform = `scaleX(${clamp(y / (totalW * vh))})`;
    hint.style.opacity = clamp(1 - y / (0.5 * vh)) * worldOpacity;
    if (particles && !liteMode) particles.style.transform = `translate3d(0, ${-y * 0.05}px, 0)`;
    ticking = false;
  }

  let scrubFrame = 0;
  function raf() {
    scrubFrame = 0;
    if (playbackMode) return;
    const eps = liteMode ? 0.025 : 0.01;   // coarser seek step on lighter devices = fewer decodes
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (!s.hasClip || !s.ready || !s.video) continue;
      // Never spend decoder time chasing clips that cannot currently be seen.
      // Snap their logical position so they seek once, at the latest frame, when shown.
      if (!s.visible || document.hidden) { s.cur = s.target; continue; }
      // Never queue a seek while the decoder is still resolving the last one.
      // On phones a fast flick would otherwise pile up seeks and freeze the clip;
      // cur keeps lerping, so we snap to the latest target the moment it's free.
      if (s.video.seeking) continue;
      s.cur += (s.target - s.cur) * (reduce ? 1 : (liteMode ? 0.3 : 0.2));
      const dur = s.video.duration || 1;
      const t = clamp(s.cur, 0, 0.999) * dur;
      if (Math.abs(s.video.currentTime - t) > eps) { try { s.video.currentTime = t; } catch (e) {} }
    }
    scrubFrame = requestAnimationFrame(raf);
  }

  function syncScrubLoop() {
    if (playbackMode && scrubFrame) { cancelAnimationFrame(scrubFrame); scrubFrame = 0; }
    else if (!playbackMode && !scrubFrame) scrubFrame = requestAnimationFrame(raf);
  }

  // Muted inline playback is allowed by modern mobile browsers. A first-touch retry
  // covers older iOS builds without polling or anti-performance workarounds.
  let userReady = false;
  function playVideo(v) {
    if (!playbackMode || !v || document.hidden || !v.paused || v.ended) return;
    try { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    catch (e) {}
  }
  function onFirstGesture() {
    if (userReady) return;
    userReady = true;
    const active = SEGMENTS[activePlaybackSegment];
    if (active) playVideo(active.video);
  }
  window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
  window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true });

  // Mobile is a discrete story deck. Native momentum scrolling made it possible to
  // land between scenes or skip copy entirely, so one vertical gesture now moves one
  // slide. The ROI section remains a normal document once the final scene exits.
  let slideLocked = false;
  let slideUnlockTimer = 0;
  let touchPaging = false;
  let touchStartX = 0;
  let touchStartY = 0;

  function isInteractiveTarget(target) {
    return Boolean(target && target.closest && target.closest('a,button,input,select,textarea,[role="button"]'));
  }

  function worldExitTop() {
    const exitTarget = document.getElementById('channels') || document.getElementById('roi');
    return exitTarget ? exitTarget.offsetTop : container.offsetTop + track.offsetHeight;
  }

  function isInsideMobileWorld() {
    const y = window.scrollY || window.pageYOffset;
    return playbackMode && y >= container.offsetTop - 2 && y < worldExitTop() - 2;
  }

  function currentSlideIndex() {
    const y = Math.max(0, (window.scrollY || window.pageYOffset) - container.offsetTop);
    let index = 0;
    for (let i = 0; i < N; i++) if (y >= SECTIONS[i]._seg.start - 2) index = i;
    return index;
  }

  function lockSlides() {
    slideLocked = true;
    clearTimeout(slideUnlockTimer);
    slideUnlockTimer = setTimeout(() => { slideLocked = false; }, reduce ? 80 : 620);
  }

  function goToMobileSlide(index) {
    const next = clamp(index, 0, N - 1);
    const seg = SECTIONS[next]._seg;
    lockSlides();
    window.scrollTo({
      top: container.offsetTop + seg.start + 1,
      behavior: reduce ? 'auto' : 'smooth',
    });
  }

  function stepMobileSlide(direction) {
    if (!playbackMode || slideLocked) return;
    const current = currentSlideIndex();
    if (direction > 0 && current === N - 1) {
      lockSlides();
      window.scrollTo({ top: worldExitTop(), behavior: reduce ? 'auto' : 'smooth' });
      return;
    }
    goToMobileSlide(current + direction);
  }

  function onSlideTouchStart(event) {
    if (!isInsideMobileWorld() || slideLocked || isInteractiveTarget(event.target) || !event.touches.length) return;
    const touch = event.touches[0];
    touchPaging = true;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
  }

  function onSlideTouchMove(event) {
    if (!touchPaging || !event.touches.length) return;
    const touch = event.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 6) event.preventDefault();
  }

  function onSlideTouchEnd(event) {
    if (!touchPaging) return;
    touchPaging = false;
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartX;
    const dy = touchStartY - touch.clientY;
    if (Math.abs(dy) < 36 || Math.abs(dy) <= Math.abs(dx)) return;
    event.preventDefault();
    stepMobileSlide(dy > 0 ? 1 : -1);
  }

  function onSlideWheel(event) {
    if (!isInsideMobileWorld() || isInteractiveTarget(event.target)) return;
    event.preventDefault();
    if (slideLocked || Math.abs(event.deltaY) < 12) return;
    stepMobileSlide(event.deltaY > 0 ? 1 : -1);
  }

  window.addEventListener('touchstart', onSlideTouchStart, { passive: true });
  window.addEventListener('touchmove', onSlideTouchMove, { passive: false });
  window.addEventListener('touchend', onSlideTouchEnd, { passive: false });
  window.addEventListener('touchcancel', () => { touchPaging = false; }, { passive: true });
  window.addEventListener('wheel', onSlideWheel, { passive: false });

  // Particles are a per-frame cost we can't afford alongside video scrubbing on a phone.
  seedParticles(particles, reduce || liteMode);
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(read); } }, { passive: true });
  // Mobile browsers fire `resize` every time the URL bar slides in/out. Re-running
  // layout() there rebuilds the track height and yanks the scroll position, so on
  // touch we ignore height-only changes and only relayout when the width actually
  // changes (rotation still comes through orientationchange). layout() records the
  // width it laid out at.
  function onResize() {
    if (coarse && window.innerWidth === laidOutW) return;
    const nextLiteMode = isLite();
    const nextPlaybackMode = isMobile();
    if (nextPlaybackMode !== playbackMode) {
      playbackMode = nextPlaybackMode;
      activePlaybackSegment = -1;
      container.classList.toggle('sw-playback', playbackMode);
      hintText.textContent = playbackMode ? 'Swipe for next scene' : defaultHint;
      SEGMENTS.forEach(unloadClip);
      syncScrubLoop();
    }
    if (nextLiteMode !== liteMode) {
      liteMode = nextLiteMode;
      container.classList.toggle('sw-lite', liteMode);
      SEGMENTS.forEach(unloadClip);
      particles.replaceChildren();
      seedParticles(particles, reduce || liteMode);
    }
    layout();
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', layout);
  document.addEventListener('visibilitychange', () => {
    if (!playbackMode) return;
    const active = SEGMENTS[activePlaybackSegment];
    if (!active || !active.video) return;
    if (document.hidden) { try { active.video.pause(); } catch (e) {} }
    else playVideo(active.video);
  });
  window.addEventListener('load', layout);
  layout();
  syncScrubLoop();

  // ---- helpers ----
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ctaBtns(cta) {
    let h = '';
    if (cta.primary) h += `<a class="sw-btn sw-btn--primary" href="${esc(cta.primary.href || '#')}">${esc(cta.primary.label)}</a>`;
    if (cta.secondary) h += `<a class="sw-btn sw-btn--ghost" href="${esc(cta.secondary.href || '#')}">${esc(cta.secondary.label)}</a>`;
    return h;
  }
}

function seedParticles(host, reduce) {
  if (!host || reduce) return;
  const kinds = ['dot', 'dot', 'ring'];
  const seeds = [7, 23, 41, 58, 71, 88, 12, 34, 52, 66, 83, 95, 18, 29, 47, 63, 77, 91, 5, 38, 55, 69, 82, 97];
  for (let k = 0; k < 20; k++) {
    const s = document.createElement('span');
    s.className = 'sw-pt sw-pt--' + kinds[k % kinds.length];
    s.style.left = seeds[k % seeds.length] + 'vw';
    s.style.top = ((seeds[(k * 3) % seeds.length] * 1.3) % 100) + 'vh';
    s.style.setProperty('--sw-sc', (0.5 + ((seeds[(k * 5) % seeds.length] % 60) / 60) * 1.1).toFixed(2));
    const dur = 14 + (seeds[(k * 7) % seeds.length] % 22);
    s.style.animationDuration = dur + 's';
    s.style.animationDelay = (-(seeds[(k * 2) % seeds.length] % dur)) + 's';
    host.appendChild(s);
  }
}

function injectCSS() {
  if (document.getElementById('sw-css')) return;
  const css = `
  .sw-root{--sw-bg:#F5EDE0;--sw-ink:#241d2b;--sw-ink-soft:#6a6072;--sw-accent:#8a7bb5;
    --sw-font-display:ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;
    --sw-font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    color:var(--sw-ink);font-family:var(--sw-font-body);}
  html,body{margin:0;background:var(--sw-bg,#F5EDE0);overflow-x:hidden;}
  .sw-sky{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:var(--sw-bg);}
  .sw-sky__grad{position:absolute;inset:-10%;background:linear-gradient(178deg,color-mix(in srgb,var(--sw-accent) 12%,var(--sw-bg)) 0%,var(--sw-bg) 55%,color-mix(in srgb,var(--sw-accent) 6%,var(--sw-bg)) 100%);}
  .sw-sky__glow{position:absolute;inset:0;background:radial-gradient(60% 42% at 74% 16%,color-mix(in srgb,var(--sw-accent) 22%,transparent),transparent 70%),radial-gradient(46% 34% at 50% 50%,color-mix(in srgb,#fff 45%,transparent),transparent 70%);}
  .sw-particles{position:absolute;inset:-6% -2%;will-change:transform;}
  .sw-pt{position:absolute;width:13px;height:13px;transform:scale(var(--sw-sc,1));opacity:0;animation:sw-drift linear infinite;}
  .sw-pt::before{content:"";position:absolute;inset:0;border-radius:50%;}
  .sw-pt--dot::before{background:radial-gradient(circle at 34% 30%,color-mix(in srgb,var(--sw-accent) 60%,#000),#000 82%);}
  .sw-pt--ring::before{background:transparent;border:2px solid color-mix(in srgb,var(--sw-accent) 55%,transparent);}
  @keyframes sw-drift{0%{opacity:0;transform:scale(var(--sw-sc)) translate(0,12vh) rotate(0)}12%{opacity:.5}88%{opacity:.45}100%{opacity:0;transform:scale(var(--sw-sc)) translate(4vw,-22vh) rotate(210deg)}}
  .sw-scrollbar{position:fixed;top:0;left:0;right:0;height:3px;z-index:60;background:color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-scrollbar span{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(0);background:var(--sw-accent);}
  .sw-topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:clamp(14px,2.4vw,26px) clamp(18px,5vw,64px);}
  .sw-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--sw-ink);}
  .sw-brand__mark{width:24px;height:28px;border-radius:7px 7px 10px 10px;background:linear-gradient(160deg,var(--sw-accent),color-mix(in srgb,var(--sw-accent) 60%,#000));box-shadow:0 6px 14px color-mix(in srgb,var(--sw-accent) 40%,transparent);}
  .sw-brand__name{font-family:var(--sw-font-display);font-weight:700;font-size:1.1rem;}
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#fff;background:var(--sw-accent);}
  .sw-topcta{text-decoration:none;font-weight:600;font-size:.9rem;color:#fff;background:var(--sw-ink);padding:10px 20px;border-radius:999px;white-space:nowrap;}
  .sw-stage{position:fixed;inset:0;z-index:10;pointer-events:none;}
  .sw-scene{position:absolute;inset:0;opacity:0;overflow:hidden;will-change:opacity;}
  .sw-scene__video,.sw-scene__still{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;}
  .sw-scene__still{will-change:transform;} .sw-scene.has-clip .sw-scene__still{opacity:0;} .sw-scene__video{z-index:1;}
  .sw-copylayer{position:fixed;inset:0;z-index:20;pointer-events:none;}
  .sw-copylayer::before{content:"";position:absolute;inset:0;width:min(58vw,780px);background:linear-gradient(90deg,var(--sw-bg) 0%,color-mix(in srgb,var(--sw-bg) 82%,transparent) 34%,color-mix(in srgb,var(--sw-bg) 40%,transparent) 62%,transparent 100%);}
  .sw-copy{position:absolute;left:clamp(18px,5vw,64px);top:50%;transform:translateY(-50%);width:min(42vw,460px);opacity:0;will-change:opacity,transform;}
  .sw-copy__num{font-family:ui-monospace,Menlo,monospace;font-size:.74rem;letter-spacing:.12em;color:var(--sw-ink-soft);}
  .sw-copy__eyebrow{display:block;margin-top:18px;font-family:var(--sw-font-display);font-weight:700;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);}
  .sw-copy__title{font-family:var(--sw-font-display);font-weight:700;color:var(--sw-ink);font-size:clamp(2rem,4.4vw,3.5rem);line-height:1.03;margin:12px 0 0;letter-spacing:-.01em;text-shadow:0 2px 20px color-mix(in srgb,var(--sw-bg) 70%,transparent);}
  .sw-copy__body{margin-top:18px;font-size:clamp(1rem,1.25vw,1.14rem);line-height:1.55;color:color-mix(in srgb,var(--sw-ink) 78%,var(--sw-ink-soft));max-width:40ch;text-shadow:0 1px 12px color-mix(in srgb,var(--sw-bg) 90%,transparent);}
  .sw-copy__tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0;padding:0;}
  .sw-copy__tags li{font-size:.82rem;font-weight:600;color:color-mix(in srgb,var(--sw-accent) 70%,#000);padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--sw-accent) 14%,#fff);border:1px solid color-mix(in srgb,var(--sw-accent) 30%,transparent);}
  .sw-copy__cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px;pointer-events:auto;}
  .sw-btn{text-decoration:none;font-weight:600;font-size:.95rem;padding:13px 24px;border-radius:999px;transition:transform .2s;}
  .sw-btn--primary{color:#fff;background:var(--sw-ink);} .sw-btn--primary:hover{transform:translateY(-2px);}
  .sw-btn--ghost{color:var(--sw-ink);border:1.5px solid color-mix(in srgb,var(--sw-ink) 25%,transparent);} .sw-btn--ghost:hover{transform:translateY(-2px);}
  .sw-route{position:fixed;right:clamp(14px,2.4vw,30px);top:50%;z-index:40;transform:translateY(-50%);display:flex;flex-direction:column;gap:22px;padding:18px 10px;}
  .sw-route::before{content:"";position:absolute;left:50%;top:22px;bottom:22px;width:2px;transform:translateX(-50%);background:var(--sw-accent);opacity:.28;}
  .sw-route__dot{position:relative;border:0;background:transparent;cursor:pointer;width:14px;height:14px;display:grid;place-items:center;}
  .sw-route__dot i{width:9px;height:9px;border-radius:50%;background:color-mix(in srgb,var(--sw-accent) 40%,transparent);transition:transform .3s,background .3s,box-shadow .3s;}
  .sw-route__dot:hover i{transform:scale(1.25);background:var(--sw-accent);}
  .sw-route__dot.is-active i{background:var(--sw-accent);transform:scale(1.4);box-shadow:0 0 0 5px color-mix(in srgb,var(--sw-accent) 22%,transparent);}
  .sw-route__label{position:absolute;right:24px;top:50%;transform:translateY(-50%) translateX(6px);white-space:nowrap;font-size:.78rem;font-weight:600;color:var(--sw-ink);background:color-mix(in srgb,#fff 85%,transparent);backdrop-filter:blur(6px);padding:5px 11px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;border:1px solid color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-route__dot:hover .sw-route__label,.sw-route__dot.is-active .sw-route__label{opacity:1;transform:translateY(-50%) translateX(0);}
  .sw-hint{position:fixed;left:50%;bottom:26px;z-index:30;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sw-ink-soft);transition:opacity .3s;}
  .sw-hint i{width:22px;height:34px;border-radius:12px;border:2px solid color-mix(in srgb,var(--sw-ink) 28%,transparent);position:relative;}
  .sw-hint i::after{content:"";position:absolute;left:50%;top:7px;width:4px;height:7px;border-radius:2px;background:var(--sw-accent);transform:translateX(-50%);animation:sw-wheel 1.7s ease-in-out infinite;}
  @keyframes sw-wheel{0%{opacity:0;top:6px}40%{opacity:1}100%{opacity:0;top:17px}}
  .sw-track{position:relative;z-index:1;width:100%;pointer-events:none;}
  @media (max-width:860px){
    .sw-nav{display:none;}
    .sw-copylayer::before{width:100%;height:60%;top:auto;bottom:0;background:linear-gradient(0deg,var(--sw-bg) 8%,color-mix(in srgb,var(--sw-bg) 70%,transparent) 46%,transparent 100%);}
    /* Anchor copy to the bottom, clear of the home indicator / collapsing URL bar.
       dvh + env() are progressive: browsers that lack them keep the vh fallback line. */
    .sw-copy{left:clamp(18px,5vw,64px);right:clamp(18px,5vw,64px);top:auto;bottom:clamp(64px,14vh,120px);transform:none;width:auto;max-width:560px;}
    .sw-copy{bottom:calc(clamp(56px,12dvh,110px) + env(safe-area-inset-bottom));}
    .sw-copy__title{font-size:clamp(1.9rem,7.5vw,2.7rem);}
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);} .sw-scene__video,.sw-scene__still{object-position:center 46%;}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:6px;} .sw-route__label{display:none;}
  }
  /* Portrait phones crop a 16:9 clip hard; keep the framing centred so the focal
     subject (which the camera dives toward) stays in view. */
  @media (max-width:860px) and (orientation:portrait){
    .sw-scene__video,.sw-scene__still{object-position:center 44%;}
  }
  /* Touch: give the route dots a finger-sized hit area without growing the visible dot. */
  @media (hover:none) and (pointer:coarse){
    .sw-route{padding:14px 6px;}
    .sw-route__dot{width:28px;height:28px;}
    .sw-btn{padding:15px 26px;}
  }
  .sw-root.sw-lite .sw-nav,.sw-root.sw-lite .sw-route__label{backdrop-filter:none;}
  .sw-root.sw-lite .sw-pt{display:none;}
  .sw-root.sw-lite .sw-scene,.sw-root.sw-lite .sw-copy{will-change:auto;}
  @media (prefers-reduced-motion:reduce){ .sw-hint i::after{animation:none;} .sw-pt{display:none;} }
  `;
  // Wrap in a cascade layer so the page's own theme tokens (unlayered
  // :root / .sw-root { --sw-bg / --sw-ink / --sw-accent … }) always win over
  // these defaults, regardless of injection order. Enables clean dark themes.
  const style = document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  document.head.appendChild(style);
}

// Expose for module + global use.
if (typeof module !== 'undefined' && module.exports) module.exports = { mountScrollWorld };
if (typeof window !== 'undefined') window.mountScrollWorld = mountScrollWorld;
