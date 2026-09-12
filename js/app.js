(() => {
  const GENRES = ["pop","rock","jazz","classical","electronic","dance","house","techno","trance","hip hop","rap","rnb","country","folk","blues","soul","reggae","metal","punk","indie","alternative","oldies","80s","90s","hits","news","talk","sports","ambient","chillout","latin","world","gospel","lofi","k-pop","soundtrack"];
  const QUICK = ["jazz","classical","news","lofi","metal","afrobeats","country","talk"];
  const STORAGE = { favs: "ww.favs", recents: "ww.recents", dead: "ww.dead", vol: "ww.vol", theme: "ww.theme", recordings: "ww.recMeta" };
  const MAX_REC_MS = 3 * 60 * 60 * 1000;
  const REC_BITRATE = 48000;
  const PAGE = 36;
  const el = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  const state = {
    view: "discover", query: "", tag: "", country: "", countrycode: "", order: "votes", offset: 0,
    stations: [], countries: [], current: null, playing: false,
    dead: new Set(readStore(STORAGE.dead, [])),
    favs: readStore(STORAGE.favs, []),
    recents: readStore(STORAGE.recents, []),
    recordings: readStore(STORAGE.recordings, []),
    recBlobs: new Map(),
    apiBase: "https://de1.api.radio-browser.info",
    hideBroken: true,
    sleepTimer: null
  };

  const audio = el("audio");
  if (audio) {
    audio.volume = Number(localStorage.getItem(STORAGE.vol) || 0.85);
    const vol = el("vol");
    if (vol) vol.value = audio.volume;
  }

  let audioGraph = null, mediaRecorder = null, recChunks = [], recStarted = 0, recTick = null, recSegments = [], recActive = false;

  function toast(msg) {
    const t = el("toast");
    if (!t) return;
    t.hidden = false;
    t.textContent = msg;
    clearTimeout(toast._id);
    toast._id = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function save(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

  async function fetchJson(url, ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function discoverApi() {
    const fallbacks = [
      "https://de1.api.radio-browser.info",
      "https://all.api.radio-browser.info",
      "https://fi1.api.radio-browser.info"
    ];
    for (const base of fallbacks) {
      try {
        await fetchJson(base + "/json/stats", 5000);
        state.apiBase = base;
        return base;
      } catch {}
    }
    return state.apiBase;
  }

  async function api(path, params = {}) {
    const build = (base) => {
      const url = new URL(base + path);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
      });
      return url.toString();
    };
    try {
      return await fetchJson(build(state.apiBase));
    } catch {
      await discoverApi();
      return fetchJson(build(state.apiBase));
    }
  }

  function isDead(s) {
    if (!s) return true;
    if (state.dead.has(s.stationuuid)) return true;
    if (state.hideBroken && Number(s.lastcheckok) === 0) return true;
    if (!s.url_resolved && !s.url) return true;
    return false;
  }

  function markDead(station, reason) {
    if (!station || !station.stationuuid) return;
    state.dead.add(station.stationuuid);
    save(STORAGE.dead, [...state.dead].slice(-2000));
    toast((station.name || "Station") + " looks dead — hidden" + (reason ? " (" + reason + ")" : ""));
    renderStations(state.stations.filter((s) => !isDead(s)));
  }

  function streamUrl(s) { return s.url_resolved || s.url; }
  function tagsOf(s) { return (s.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 4); }
  function locOf(s) { return [s.state, s.country].filter(Boolean).join(", "); }
  function fallbackArt(name) {
    const letter = encodeURIComponent((name || "W").slice(0, 1).toUpperCase());
    return "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect fill='%231a1d27' width='64' height='64' rx='14'/><text x='50%' y='56%' text-anchor='middle' fill='%23e8b86d' font-size='28' font-family='Georgia'>" + letter + "</text></svg>";
  }
  function art(s) { return s.favicon || fallbackArt(s.name); }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (ch) => {
      if (ch === "&") return "\u0026amp;";
      if (ch === "<") return "\u0026lt;";
      if (ch === ">") return "\u0026gt;";
      if (ch === '"') return "\u0026quot;";
      return "\u0026#39;";
    });
  }
  function escapeAttr(str) { return escapeHtml(str).replace(/`/g, ""); }

  function ensureAudioGraph() {
    if (audioGraph) return audioGraph;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    const dest = ctx.createMediaStreamDestination();
    source.connect(analyser);
    analyser.connect(ctx.destination);
    source.connect(dest);
    audioGraph = { ctx: ctx, source: source, analyser: analyser, dest: dest };
    drawViz();
    return audioGraph;
  }

  function drawViz() {
    const canvas = el("viz");
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    const loop = () => {
      requestAnimationFrame(loop);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      if (!audioGraph || !audio || audio.paused) return;
      const data = new Uint8Array(audioGraph.analyser.frequencyBinCount);
      audioGraph.analyser.getByteFrequencyData(data);
      const w = canvas.width / data.length;
      data.forEach((v, i) => {
        const h = (v / 255) * canvas.height;
        ctx2d.fillStyle = "rgba(232,184,109," + (0.35 + v / 400) + ")";
        ctx2d.fillRect(i * w, canvas.height - h, w - 1, h);
      });
    };
    loop();
  }

  async function playStation(station) {
    if (!station || !audio) return;
    state.current = station;
    updateNowPlaying();
    $$(".card").forEach((c) => c.classList.toggle("playing", c.dataset.uuid === station.stationuuid));
    audio.crossOrigin = "anonymous";
    const url = streamUrl(station);
    audio.src = url;
    try {
      ensureAudioGraph();
      if (audioGraph.ctx.state === "suspended") await audioGraph.ctx.resume();
    } catch {}
    try {
      await audio.play();
      state.playing = true;
      el("playBtn").textContent = "\u275A\u275A";
      api("/json/url/" + station.stationuuid).catch(() => {});
      pushRecent(station);
      if (recActive) recSegments.push({ at: Date.now(), name: station.name });
      setupMediaSession(station);
    } catch (err) {
      if (audio.crossOrigin) {
        audio.removeAttribute("crossorigin");
        audio.src = url;
        try {
          await audio.play();
          state.playing = true;
          el("playBtn").textContent = "\u275A\u275A";
          pushRecent(station);
          toast("Playing — this stream blocks capture, so recording may be silent");
          return;
        } catch {}
      }
      markDead(station, "stream failed");
      state.playing = false;
      el("playBtn").textContent = "\u25B6";
    }
  }

  function stopPlayback() {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    state.playing = false;
    el("playBtn").textContent = "\u25B6";
  }

  function togglePlay() {
    if (!state.current) { surprise(); return; }
    if (audio.paused) {
      audio.play().then(() => {
        state.playing = true;
        el("playBtn").textContent = "\u275A\u275A";
      }).catch(() => playStation(state.current));
    } else {
      audio.pause();
      state.playing = false;
      el("playBtn").textContent = "\u25B6";
    }
  }

  function setupMediaSession(station) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: station.name,
      artist: locOf(station) || "Worldwave",
      album: tagsOf(station)[0] || "Radio"
    });
    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => togglePlay());
    navigator.mediaSession.setActionHandler("nexttrack", () => surprise());
  }

  function isFav(s) { return state.favs.some((f) => f.stationuuid === s.stationuuid); }

  function slim(s) {
    return {
      stationuuid: s.stationuuid, name: s.name, url: s.url, url_resolved: s.url_resolved,
      favicon: s.favicon, tags: s.tags, country: s.country, countrycode: s.countrycode,
      state: s.state, language: s.language, codec: s.codec, bitrate: s.bitrate,
      homepage: s.homepage, lastcheckok: s.lastcheckok, votes: s.votes, clickcount: s.clickcount
    };
  }

  function toggleFav(station) {
    if (!station) return;
    if (isFav(station)) {
      state.favs = state.favs.filter((f) => f.stationuuid !== station.stationuuid);
      toast("Removed from favorites");
    } else {
      state.favs.unshift(slim(station));
      state.favs = state.favs.slice(0, 400);
      toast("Saved to favorites");
    }
    save(STORAGE.favs, state.favs);
    updateNowPlaying();
    if (state.view === "favorites") showFavorites();
    else renderStations(state.stations);
  }

  function pushRecent(station) {
    state.recents = [slim(station), ...state.recents.filter((r) => r.stationuuid !== station.stationuuid)].slice(0, 80);
    save(STORAGE.recents, state.recents);
  }

  function updateNowPlaying() {
    const s = state.current;
    el("nowName").textContent = s ? s.name : "Nothing playing";
    el("nowMeta").textContent = s ? [locOf(s), s.codec, s.bitrate ? s.bitrate + " kbps" : "", tagsOf(s)[0]].filter(Boolean).join(" \u00b7 ") : "Pick a station to start";
    el("nowArt").src = s ? art(s) : fallbackArt("W");
    el("favNowBtn").textContent = s && isFav(s) ? "\u2665" : "\u2661";
  }

  function stationCard(s) {
    const tags = tagsOf(s).map((t) => "<span class=\"tag\">" + escapeHtml(t) + "</span>").join("");
    const playing = state.current && state.current.stationuuid === s.stationuuid ? " playing" : "";
    return "<article class=\"card" + playing + "\" data-uuid=\"" + s.stationuuid + "\">" +
      "<div class=\"card-top\"><img src=\"" + escapeAttr(art(s)) + "\" alt=\"\" />" +
      "<div><h3>" + escapeHtml(s.name) + "</h3><div class=\"meta\">" +
      escapeHtml(locOf(s) || "Unknown location") + " \u00b7 " + escapeHtml((s.codec || "").toUpperCase()) + " " + (s.bitrate || "") +
      "</div></div></div><div class=\"tags\">" + tags + "</div><div class=\"card-actions\">" +
      "<button class=\"play\" data-act=\"play\">Play</button>" +
      "<button data-act=\"fav\">" + (isFav(s) ? "\u2665 Saved" : "\u2661 Save") + "</button></div></article>";
  }

  function renderStations(list, opts) {
    opts = opts || {};
    const append = !!opts.append;
    const live = list.filter((s) => !isDead(s));
    state.stations = append ? state.stations.concat(live) : live;
    const grid = el("grid");
    const html = live.map(stationCard).join("");
    if (append) grid.insertAdjacentHTML("beforeend", html);
    else grid.innerHTML = html;
    el("empty").hidden = live.length > 0;
    if (!live.length) {
      el("empty").hidden = false;
      el("empty").innerHTML = "<h3>No working stations in this slice</h3><p>Try another genre, country, or search.</p>";
    }
    el("resultMeta").textContent = state.stations.length + " working station" + (state.stations.length === 1 ? "" : "s");
    const cards = append ? [...grid.querySelectorAll(".card")].slice(-live.length) : [...grid.querySelectorAll(".card")];
    cards.forEach((card) => {
      const station = state.stations.find((s) => s.stationuuid === card.dataset.uuid);
      card.addEventListener("click", (ev) => {
        if (ev.target.dataset.act === "fav") toggleFav(station);
        else playStation(station);
      });
    });
  }

  function setView(view, title, lede) {
    state.view = view;
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    el("pageTitle").textContent = title;
    el("pageLede").textContent = lede;
    el("chipRow").innerHTML = "";
    el("moreBtn").hidden = true;
  }

  async function loadStations(params, opts) {
    opts = opts || {};
    const append = !!opts.append;
    el("resultMeta").textContent = "Tuning catalog\u2026";
    const query = {
      hidebroken: state.hideBroken ? "true" : "false",
      limit: PAGE,
      offset: append ? state.offset : 0,
      order: state.order,
      reverse: state.order === "name" ? "false" : "true"
    };
    Object.keys(params || {}).forEach((k) => { query[k] = params[k]; });
    if (state.order === "random") { query.order = "random"; delete query.reverse; }
    try {
      const rows = await api("/json/stations/search", query);
      const list = Array.isArray(rows) ? rows : [];
      const clean = list.filter((s) => !isDead(s));
      state.offset = (append ? state.offset : 0) + list.length;
      renderStations(clean, { append: append });
      el("moreBtn").hidden = list.length < PAGE;
      el("moreBtn").onclick = () => loadStations(params, { append: true });
    } catch (e) {
      el("resultMeta").textContent = "Could not reach the station catalog";
      el("empty").hidden = false;
      el("empty").innerHTML = "<h3>Catalog request failed</h3><p>Refresh, or run from a local server / GitHub Pages instead of a raw file:// page.</p>";
      toast("Could not reach radio-browser.info");
    }
  }

  function showDiscover() {
    setView("discover", "Tune the planet", "Highest-voted working stations from the global public catalog.");
    renderQuick();
    loadStations({});
  }

  function renderQuick() {
    el("quickPills").innerHTML = QUICK.map((g) => "<button class=\"pill\" data-tag=\"" + g + "\">" + g + "</button>").join("");
    $$("#quickPills .pill").forEach((b) => { b.onclick = () => openGenre(b.dataset.tag); });
  }

  function showGenres() {
    setView("genres", "By genre", "Open any lane to hear live stations that actually resolve.");
    el("grid").innerHTML = GENRES.map((g) => "<button class=\"card genre-card\" data-tag=\"" + g + "\"><div class=\"eyebrow\">Genre</div><h3>" + g + "</h3><div class=\"count\">\u2192</div></button>").join("");
    $$(".genre-card").forEach((c) => { c.onclick = () => openGenre(c.dataset.tag); });
    el("resultMeta").textContent = GENRES.length + " genres";
  }

  function openGenre(tag) {
    state.tag = tag; state.country = ""; state.countrycode = "";
    setView("discover", tag.charAt(0).toUpperCase() + tag.slice(1), "Working stations tagged \"" + tag + "\".");
    paintFilters();
    loadStations({ tag: tag });
  }

  async function showPlaces() {
    setView("places", "By location", "Every country in the directory, with station counts.");
    if (!state.countries.length) {
      el("resultMeta").textContent = "Loading countries\u2026";
      const rows = await api("/json/countries", { order: "stationcount", reverse: "true" });
      state.countries = (rows || []).filter((c) => c.iso_3166_1 && c.stationcount > 0);
    }
    const q = (el("searchInput").value || "").trim().toLowerCase();
    const rows = state.countries.filter((c) => !q || c.name.toLowerCase().includes(q) || c.iso_3166_1.toLowerCase() === q);
    el("grid").innerHTML = rows.map((c) => "<button class=\"card place-card\" data-cc=\"" + c.iso_3166_1 + "\" data-name=\"" + escapeAttr(c.name) + "\"><div class=\"eyebrow\">" + c.iso_3166_1 + "</div><h3>" + escapeHtml(c.name) + "</h3><div class=\"count\">" + c.stationcount.toLocaleString() + "</div></button>").join("");
    $$(".place-card").forEach((c) => { c.onclick = () => openCountry(c.dataset.cc, c.dataset.name); });
    el("resultMeta").textContent = rows.length + " countries";
  }

  function openCountry(code, name) {
    state.countrycode = code; state.country = name; state.tag = "";
    setView("discover", name, "Stations broadcasting from " + name + ".");
    paintFilters();
    loadStations({ countrycode: code });
  }

  function paintFilters() {
    const box = el("activeFilters");
    const bits = [];
    if (state.tag) bits.push(["genre", state.tag]);
    if (state.country) bits.push(["place", state.country]);
    if (state.query) bits.push(["search", state.query]);
    box.hidden = !bits.length;
    box.innerHTML = bits.map((kv) => "<span class=\"filter-tag\">" + kv[0] + ": " + escapeHtml(kv[1]) + "</span>").join("") +
      (bits.length ? "<button class=\"chip\" id=\"clearFilters\">Clear</button>" : "");
    const clear = el("clearFilters");
    if (clear) clear.onclick = () => {
      state.tag = ""; state.country = ""; state.countrycode = ""; state.query = "";
      el("searchInput").value = "";
      showDiscover();
    };
  }

  function showFavorites() {
    setView("favorites", "Favorites", "Stored only in this browser.");
    const live = state.favs.filter((s) => !isDead(s));
    renderStations(live);
    if (!live.length) {
      el("empty").hidden = false;
      el("empty").innerHTML = "<h3>No favorites yet</h3><p>Heart a station while it plays, or tap Save on a card.</p>";
    }
  }

  function showRecent() {
    setView("recent", "Recently played", "Your last tuned stations on this device.");
    renderStations(state.recents.filter((s) => !isDead(s)));
  }

  function showLibrary() {
    setView("library", "Recordings", "48 kbps, max 3 hours. Changing stations does not stop a take.");
    if (!state.recordings.length) {
      el("grid").innerHTML = "";
      el("empty").hidden = false;
      el("empty").innerHTML = "<h3>No takes yet</h3><p>Hit Rec while a station is playing.</p>";
      el("resultMeta").textContent = "0 recordings";
      return;
    }
    el("empty").hidden = true;
    el("grid").innerHTML = state.recordings.map((r) => "<article class=\"card\" data-id=\"" + r.id + "\"><h3>" + escapeHtml(r.title) + "</h3><div class=\"meta\">" + escapeHtml(r.when) + " \u00b7 " + escapeHtml(r.duration) + " \u00b7 48 kbps</div><div class=\"meta\">" + escapeHtml((r.stations || []).join(" \u2192 ")) + "</div><div class=\"card-actions\"><button class=\"play\" data-act=\"dl\">Download</button></div></article>").join("");
    el("resultMeta").textContent = state.recordings.length + " recording" + (state.recordings.length === 1 ? "" : "s");
    $$("#grid .card").forEach((card) => {
      card.querySelector("[data-act=dl]").onclick = () => {
        const rec = state.recordings.find((x) => x.id === card.dataset.id);
        const blob = state.recBlobs.get(rec.id);
        if (!blob) { toast("This take is gone after reload"); return; }
        downloadBlob(blob, rec.file);
      };
    });
  }

  async function surprise() {
    try {
      const params = { hidebroken: "true", order: "random", limit: 12 };
      if (state.tag) params.tag = state.tag;
      if (state.countrycode) params.countrycode = state.countrycode;
      const rows = (await api("/json/stations/search", params)).filter((s) => !isDead(s));
      if (!rows.length) { toast("No random station in this filter"); return; }
      const pick = rows[Math.floor(Math.random() * rows.length)];
      toast("Random: " + pick.name);
      playStation(pick);
    } catch {
      toast("Could not fetch a random station");
    }
  }

  function pickMime() {
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  }

  async function startRecording() {
    if (recActive) return stopRecording();
    if (!state.current) { toast("Play a station first"); return; }
    if (!window.MediaRecorder) { toast("This browser cannot record"); return; }
    try {
      ensureAudioGraph();
      if (audioGraph.ctx.state === "suspended") await audioGraph.ctx.resume();
    } catch (e) {
      toast("Cannot tap this stream for recording (CORS). Try another station.");
      return;
    }
    let stream = audioGraph && audioGraph.dest && audioGraph.dest.stream;
    if (!stream || !stream.getAudioTracks().length) {
      if (audio.captureStream) stream = audio.captureStream();
      else if (audio.mozCaptureStream) stream = audio.mozCaptureStream();
    }
    if (!stream) { toast("Recording unavailable for this stream"); return; }
    recChunks = [];
    recSegments = [{ at: Date.now(), name: state.current.name }];
    const mime = pickMime();
    try { mediaRecorder = new MediaRecorder(stream, { mimeType: mime || undefined, audioBitsPerSecond: REC_BITRATE }); }
    catch { mediaRecorder = new MediaRecorder(stream); }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = finalizeRecording;
    mediaRecorder.start(1000);
    recActive = true;
    recStarted = Date.now();
    el("recBtn").classList.add("on");
    el("recBtn").textContent = "\u25A0 Stop";
    recTick = setInterval(updateRecClock, 250);
    toast("Recording — change stations anytime, the take keeps going");
    setTimeout(() => { if (recActive) stopRecording(); }, MAX_REC_MS);
  }

  function updateRecClock() {
    const ms = Math.min(Date.now() - recStarted, MAX_REC_MS);
    el("recTime").textContent = fmt(ms);
    if (ms >= MAX_REC_MS && recActive) stopRecording();
  }

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return h + ":" + m + ":" + sec;
  }

  function stopRecording() {
    if (!recActive || !mediaRecorder) return;
    recActive = false;
    clearInterval(recTick);
    el("recBtn").classList.remove("on");
    el("recBtn").textContent = "\u25CF Rec";
    try { mediaRecorder.stop(); } catch {}
  }

  function finalizeRecording() {
    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    const ext = blob.type.indexOf("mp4") >= 0 ? "m4a" : blob.type.indexOf("ogg") >= 0 ? "ogg" : "webm";
    const names = [];
    recSegments.forEach((s) => { if (names.indexOf(s.name) < 0) names.push(s.name); });
    const title = names[0] + (names.length > 1 ? " +" + (names.length - 1) : "");
    const id = "r" + Date.now();
    const file = "worldwave-" + slug(title) + "-" + Date.now() + "." + ext;
    const rec = { id: id, title: title, file: file, when: new Date().toLocaleString(), duration: fmt(Date.now() - recStarted), stations: names };
    state.recordings.unshift(rec);
    state.recBlobs.set(id, blob);
    save(STORAGE.recordings, state.recordings.slice(0, 40));
    downloadBlob(blob, file);
    toast("Saved " + rec.duration + " at 48 kbps");
    if (state.view === "library") showLibrary();
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "take";
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function runSearch(q) {
    state.query = q.trim();
    if (!state.query) {
      if (state.view === "places") return showPlaces();
      return showDiscover();
    }
    setView("discover", "Search", "Results for \"" + state.query + "\".");
    paintFilters();
    const countryHit = state.countries.find((c) => c.name.toLowerCase() === state.query.toLowerCase() || c.iso_3166_1.toLowerCase() === state.query.toLowerCase());
    const genreHit = GENRES.find((g) => g.toLowerCase() === state.query.toLowerCase());
    if (countryHit) return openCountry(countryHit.iso_3166_1, countryHit.name);
    if (genreHit) return openGenre(genreHit);
    await loadStations({ name: state.query });
  }

  function bind() {
    $$(".nav-btn").forEach((b) => {
      b.onclick = () => {
        const v = b.dataset.view;
        if (v === "discover") {
          state.tag = ""; state.country = ""; state.countrycode = ""; state.query = "";
          el("searchInput").value = "";
          el("activeFilters").hidden = true;
          showDiscover();
        }
        if (v === "genres") showGenres();
        if (v === "places") showPlaces();
        if (v === "favorites") showFavorites();
        if (v === "recent") showRecent();
        if (v === "library") showLibrary();
        el("sidebar").classList.remove("open");
      };
    });
    el("menuBtn").onclick = () => el("sidebar").classList.toggle("open");
    el("randomBtn").onclick = surprise;
    el("playBtn").onclick = togglePlay;
    el("stopBtn").onclick = stopPlayback;
    el("favNowBtn").onclick = () => toggleFav(state.current);
    el("recBtn").onclick = startRecording;
    el("muteBtn").onclick = () => {
      audio.muted = !audio.muted;
      el("muteBtn").textContent = audio.muted ? "\uD83D\uDD07" : "\uD83D\uDD0A";
    };
    el("vol").oninput = (e) => {
      audio.volume = Number(e.target.value);
      localStorage.setItem(STORAGE.vol, audio.volume);
    };
    el("sortSelect").onchange = (e) => {
      state.order = e.target.value;
      if (state.view === "discover") {
        const params = {};
        if (state.tag) params.tag = state.tag;
        if (state.countrycode) params.countrycode = state.countrycode;
        if (state.query) params.name = state.query;
        loadStations(params);
      }
    };
    el("hideBroken").onchange = (e) => {
      state.hideBroken = e.target.checked;
      if (state.view === "discover") {
        loadStations({
          tag: state.tag || undefined,
          countrycode: state.countrycode || undefined,
          name: state.query || undefined
        });
      }
    };
    el("sleepSelect").onchange = (e) => {
      clearTimeout(state.sleepTimer);
      const mins = Number(e.target.value);
      if (!mins) return;
      state.sleepTimer = setTimeout(() => {
        stopPlayback();
        if (recActive) stopRecording();
        toast("Sleep timer ended");
        el("sleepSelect").value = "0";
      }, mins * 60 * 1000);
      toast("Sleep in " + mins + " min");
    };
    el("themeBtn").onclick = () => {
      const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next === "dark" ? "" : "light");
      localStorage.setItem(STORAGE.theme, next);
    };
    let t;
    el("searchInput").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => runSearch(e.target.value), 280);
    });
    audio.addEventListener("error", () => {
      if (state.current) markDead(state.current, "playback error");
    });
    document.addEventListener("keydown", (e) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].indexOf(e.target.tagName) >= 0;
      if (e.key === "/" && !typing) { e.preventDefault(); el("searchInput").focus(); }
      if (typing) return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      if (e.key === "r" || e.key === "R") surprise();
      if (e.key === "f" || e.key === "F") toggleFav(state.current);
    });
  }

  function init() {
    try {
      const theme = localStorage.getItem(STORAGE.theme);
      if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
      bind();
      renderQuick();
      updateNowPlaying();
      showDiscover();
      discoverApi().catch(() => {});
      api("/json/countries", { order: "stationcount", reverse: "true" }).then((rows) => {
        state.countries = (rows || []).filter((c) => c.iso_3166_1 && c.stationcount > 0);
      }).catch(() => { state.countries = []; });
    } catch (err) {
      const meta = el("resultMeta");
      if (meta) meta.textContent = "Player failed to start";
      console.error(err);
    }
  }

  init();
})();
