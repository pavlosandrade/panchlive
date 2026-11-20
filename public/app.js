(() => {
  "use strict";

  const state = {
    account: null,
    dashboardTitle: "PanchLive Dashboard",
    guildId: "all",
    range: "30d",
    activePage: "dashboard",
    activeAdminTab: "accounts",
    liveTimer: null,
    lastInviteCode: "",
  };

  const $ = (id) => document.getElementById(id);

  function showToast(message, type = "info") {
    const container = $("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type === "success" ? "toast-success" : type === "error" ? "toast-error" : ""}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 4200);
  }

  function clearEl(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function safeHttpUrl(url) {
    if (typeof url !== "string") return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return parsed.toString();
      }
    } catch {
      return null;
    }
    return null;
  }

  function safeHttpsUrl(url) {
    if (typeof url !== "string") return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {
      return null;
    }
    return null;
  }

  function formatDurationShort(ms) {
    const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  function formatTrackClock(ms, isStream) {
    if (isStream) return "AO VIVO";
    const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  }

  function formatDateTime(input) {
    if (!input) return "—";
    const date = typeof input === "number" ? new Date(input) : new Date(input);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function api(path, options = {}) {
    const method = options.method || "GET";
    const headers = { "X-Requested-With": "fetch" };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Erro HTTP ${res.status}`);
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  function applyDashboardTitle(title) {
    state.dashboardTitle = title || "PanchLive Dashboard";
    document.title = state.dashboardTitle;
    document.querySelectorAll("[data-dashboard-title]").forEach((node) => {
      node.textContent = state.dashboardTitle;
    });
  }

  function showOnlyView(viewId) {
    ["loading-view", "https-blocked-view", "setup-view", "auth-view", "app-view"].forEach((id) => {
      $(id).classList.toggle("hidden", id !== viewId);
    });
  }

  function stopLivePolling() {
    if (state.liveTimer) {
      clearInterval(state.liveTimer);
      state.liveTimer = null;
    }
  }

  function startLivePolling() {
    stopLivePolling();
    state.liveTimer = setInterval(() => {
      if (!document.hidden && state.account && state.activePage === "dashboard") {
        void loadLive();
      }
    }, 5000);
  }

  function parseInviteFromHash() {
    const hash = window.location.hash || "";
    const match = /invite=([A-Za-z0-9-]+)/i.exec(hash);
    if (match) {
      return match[1];
    }
    return null;
  }

  function switchAuthTab(mode) {
    const isRegister = mode === "register";
    $("tab-login-btn").classList.toggle("active", !isRegister);
    $("tab-register-btn").classList.toggle("active", isRegister);
    $("login-form").classList.toggle("hidden", isRegister);
    $("register-form").classList.toggle("hidden", !isRegister);
    $("login-error").classList.add("hidden");
    $("register-error").classList.add("hidden");
    const authCard = $("auth-card");
    if (authCard) {
      authCard.classList.toggle("auth-card-wide", isRegister);
    }
    const subheading = $("auth-subheading");
    if (subheading) {
      subheading.textContent = isRegister
        ? "Use o código de convite gerado por um administrador."
        : "Entre com sua conta para acessar as estatísticas.";
    }
  }

  async function init() {
    try {
      const status = await api("/api/auth/status");
      applyDashboardTitle(status.dashboardTitle);

      if (status.httpsRequired && !status.isSecure) {
        stopLivePolling();
        showOnlyView("https-blocked-view");
        return;
      }

      if (status.needsSetup) {
        stopLivePolling();
        showOnlyView("setup-view");
        if (status.setupMode === "disabled") {
          $("setup-disabled-box").classList.remove("hidden");
          $("setup-form").classList.add("hidden");
        } else {
          $("setup-disabled-box").classList.add("hidden");
          $("setup-form").classList.remove("hidden");
          $("setup-token-group").classList.toggle("hidden", status.setupMode !== "token");
          $("setup-token").required = status.setupMode === "token";
        }
        return;
      }

      if (!status.authenticated || !status.account) {
        state.account = null;
        stopLivePolling();
        showOnlyView("auth-view");
        const hashInvite = parseInviteFromHash();
        if (hashInvite) {
          $("reg-invite").value = hashInvite;
          switchAuthTab("register");
          history.replaceState(null, "", window.location.pathname);
        }
        return;
      }

      enterAuthenticatedApp(status.account);
    } catch (err) {
      showToast(err.message || "Falha ao inicializar.", "error");
    }
  }

  const SIDEBAR_STORAGE_KEY = "panchlive_sidebar_collapsed";

  function applySidebarCollapsed(collapsed) {
    const shell = $("app-view");
    const toggleBtn = $("sidebar-toggle-btn");
    shell.classList.toggle("sidebar-collapsed", collapsed);
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", String(!collapsed));
      toggleBtn.setAttribute(
        "aria-label",
        collapsed ? "Expandir menu lateral" : "Recolher menu lateral",
      );
      toggleBtn.title = collapsed ? "Expandir menu" : "Recolher menu";
    }
  }

  function loadSidebarPreference() {
    try {
      return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function saveSidebarPreference(collapsed) {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // Ignora se localStorage estiver bloqueado
    }
  }

  function enterAuthenticatedApp(account) {
    state.account = account;
    const roleLabel = account.role === "admin" ? "Admin" : "Viewer";
    const fullRoleLabel = account.role === "admin" ? "Administrador" : "Visualizador";
    const initial = (account.displayName || account.username || "P").trim().slice(0, 1).toUpperCase();
    const avatarEl = $("sidebar-avatar");
    if (avatarEl) {
      avatarEl.title = `${account.displayName} (${roleLabel})`;
    }
    $("current-user-name").textContent = account.displayName;
    const roleBadge = $("current-user-role");
    roleBadge.textContent = roleLabel;
    roleBadge.className = `badge ${account.role === "admin" ? "badge-accent" : ""}`;

    // Página Minha Conta
    $("account-page-avatar").textContent = initial;
    $("account-page-name").textContent = account.displayName;
    const pageRole = $("account-page-role");
    pageRole.textContent = fullRoleLabel;
    pageRole.className = "badge account-profile-badge";
    $("my-account-username").textContent = `@${account.username}`;

    document.querySelectorAll(".admin-only").forEach((section) => {
      section.classList.toggle("hidden", account.role !== "admin");
    });

    applySidebarCollapsed(loadSidebarPreference());
    showOnlyView("app-view");
    switchPage("dashboard");
    startLivePolling();
    void loadGuilds().then(() => loadDashboardData());
  }

  function switchPage(page) {
    const safePage =
      page === "admin" && (!state.account || state.account.role !== "admin") ? "dashboard" : page;
    state.activePage = safePage;
    $("page-dashboard").classList.toggle("hidden", safePage !== "dashboard");
    $("page-account").classList.toggle("hidden", safePage !== "account");
    $("page-admin").classList.toggle("hidden", safePage !== "admin");
    $("nav-dashboard-btn").classList.toggle("active", safePage === "dashboard");
    $("nav-account-btn").classList.toggle("active", safePage === "account");
    $("nav-admin-btn").classList.toggle("active", safePage === "admin");

    if (safePage === "admin") {
      switchAdminTab(state.activeAdminTab);
      void loadAdminPage();
    } else if (safePage === "dashboard") {
      void loadLive();
    }
  }

  function switchAdminTab(tab) {
    const valid = tab === "invites" || tab === "preferences" ? tab : "accounts";
    state.activeAdminTab = valid;
    ["accounts", "invites", "preferences"].forEach((name) => {
      const isCurrent = name === valid;
      $(`admin-tab-${name}`).classList.toggle("hidden", !isCurrent);
      const btn = $(`admin-tab-btn-${name}`);
      btn.classList.toggle("active", isCurrent);
      btn.setAttribute("aria-selected", String(isCurrent));
    });
  }

  async function loadGuilds() {
    try {
      const { guilds } = await api("/api/guilds");
      const select = $("guild-select");
      const current = state.guildId;
      clearEl(select);

      const allOpt = el("option", "", "Todos os servidores");
      allOpt.value = "all";
      select.appendChild(allOpt);

      for (const guild of guilds) {
        const opt = el("option", "", guild.name);
        opt.value = guild.guildId;
        select.appendChild(opt);
      }

      const validValues = new Set(["all", ...guilds.map((g) => g.guildId)]);
      state.guildId = validValues.has(current) ? current : "all";
      select.value = state.guildId;
    } catch (err) {
      handleSessionError(err);
    }
  }

  function buildStatsQuery() {
    const params = new URLSearchParams();
    if (state.guildId && state.guildId !== "all") {
      params.set("guildId", state.guildId);
    }
    params.set("range", state.range);
    // Date.getTimezoneOffset() é positivo para UTC-3 (+180), invertemos para offset UTC (-180)
    params.set("tzOffset", String(-new Date().getTimezoneOffset()));
    return params.toString();
  }

  async function loadDashboardData() {
    const query = buildStatsQuery();
    try {
      const [overviewRes, tracksRes, usersRes, activityRes, recentRes] = await Promise.all([
        api(`/api/stats/overview?${query}`),
        api(`/api/stats/top-tracks?${query}&limit=20`),
        api(`/api/stats/top-users?${query}&limit=20`),
        api(`/api/stats/activity?${query}`),
        api(`/api/stats/recent?${query}&limit=30`),
      ]);

      applyDashboardTitle(overviewRes.settings.dashboardTitle);
      renderOverview(overviewRes.overview, overviewRes.settings);
      renderTopTracks(tracksRes.tracks);
      renderTopUsers(usersRes.users);
      renderDailyChart(activityRes.daily);
      renderHourlyChart(activityRes.hourly);
      renderPlatforms(activityRes.platforms);
      renderTopCommands(activityRes.topCommands);
      renderRecentPlays(recentRes.plays);
      await loadLive();
    } catch (err) {
      handleSessionError(err);
    }
  }

  async function loadLive() {
    const guildParam =
      state.guildId && state.guildId !== "all"
        ? `?guildId=${encodeURIComponent(state.guildId)}`
        : "";
    try {
      const live = await api(`/api/live${guildParam}`);
      renderLive(live);
    } catch (err) {
      handleSessionError(err);
    }
  }

  function renderLive(live) {
    const nodesBox = $("lavalink-nodes-badges");
    clearEl(nodesBox);
    for (const node of live.nodes) {
      const badge = el(
        "span",
        `badge ${node.connected ? "badge-success" : "badge-danger"}`,
        `${node.id}: ${node.connected ? "conectado" : "offline"}`,
      );
      nodesBox.appendChild(badge);
    }

    const activePlayers = live.players.filter((p) => p.currentTrack);
    const liveSection = $("live-section");
    const hasActive = activePlayers.length > 0;
    liveSection.classList.toggle("live-active", hasActive);
    liveSection.classList.toggle("live-idle", !hasActive);
    $("live-indicator").classList.toggle("playing", activePlayers.some((p) => p.playing && !p.paused));

    const container = $("live-content");
    clearEl(container);
    container.classList.toggle("hidden", !hasActive);

    if (!hasActive) {
      return;
    }

    for (const player of activePlayers) {
      const card = el("div", "live-player-card");
      const head = el("div", "live-player-head");
      const guildLabel = el(
        "div",
        "small-text muted",
        player.voiceChannelName ? `${player.guildName} • #${player.voiceChannelName}` : player.guildName,
      );
      const statusBadge = el(
        "span",
        `badge ${player.paused ? "badge-warning" : "badge-success"}`,
        player.paused ? "Pausado" : "Tocando",
      );
      head.append(guildLabel, statusBadge);
      card.appendChild(head);

      const track = player.currentTrack;
      const row = el("div", "live-track-row");
      const art = safeHttpsUrl(track.artworkUrl);
      if (art) {
        const img = document.createElement("img");
        img.src = art;
        img.alt = "";
        img.className = "track-cover";
        img.loading = "lazy";
        row.appendChild(img);
      } else {
        row.appendChild(el("div", "track-cover-placeholder", "♪"));
      }

      const info = el("div", "rank-main");
      const linkUrl = safeHttpUrl(track.uri);
      if (linkUrl) {
        const a = el("a", "rank-title", track.title);
        a.href = linkUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        info.appendChild(a);
      } else {
        info.appendChild(el("div", "rank-title", track.title));
      }
      const metaParts = [];
      if (track.author) metaParts.push(track.author);
      if (track.requesterName) metaParts.push(`Pedido por ${track.requesterName}`);
      info.appendChild(el("div", "rank-meta", metaParts.join(" • ") || "Em reprodução"));
      row.appendChild(info);
      card.appendChild(row);

      const pct =
        !track.isStream && track.durationMs > 0
          ? Math.min(100, Math.max(0, Math.round((player.positionMs / track.durationMs) * 100)))
          : 100;
      const progWrap = el("div", "progress-track");
      const progFill = el("div", "progress-fill");
      progFill.style.width = `${pct}%`;
      progWrap.appendChild(progFill);
      card.appendChild(progWrap);

      const foot = el("div", "bar-row-head muted");
      const clockText = track.isStream
        ? "AO VIVO"
        : `${formatTrackClock(player.positionMs, false)} / ${formatTrackClock(track.durationMs, false)}`;
      foot.append(
        el("span", "", clockText),
        el("span", "", `${player.queueLength} na fila • Loop: ${player.repeatMode}`),
      );
      card.appendChild(foot);

      container.appendChild(card);
    }
  }

  function renderOverview(overview, settings) {
    $("kpi-total-plays").textContent = overview.totalPlays.toLocaleString("pt-BR");
    $("kpi-completion-rate").textContent = `${overview.completionRate}% concluídas (${overview.completedPlays} completas)`;
    $("kpi-total-time").textContent = formatDurationShort(overview.totalListenedMs);
    $("kpi-unique-tracks").textContent = `${overview.uniqueTracks.toLocaleString("pt-BR")} músicas únicas`;
    $("kpi-unique-users").textContent = overview.uniqueUsers.toLocaleString("pt-BR");
    $("kpi-total-commands").textContent = overview.totalCommands.toLocaleString("pt-BR");

    const loopHint = settings.ignoreLoopInRankings ? "sem loop" : "com loop";
    $("ranking-rules-hint").textContent = `Mín. ${settings.minPlaySeconds}s • ${loopHint}`;
  }

  function renderTopTracks(tracks) {
    const box = $("top-tracks-list");
    clearEl(box);
    if (!tracks.length) {
      box.appendChild(el("div", "empty-state", "Nenhuma música registrada neste período ainda."));
      return;
    }

    tracks.forEach((track, idx) => {
      const item = el("div", "rank-item");
      const pos = el("div", `rank-pos ${idx < 3 ? `top-${idx + 1}` : ""}`, `#${idx + 1}`);
      item.appendChild(pos);

      const art = safeHttpsUrl(track.artworkUrl);
      if (art) {
        const img = document.createElement("img");
        img.src = art;
        img.alt = "";
        img.className = "track-cover";
        img.loading = "lazy";
        item.appendChild(img);
      } else {
        item.appendChild(el("div", "track-cover-placeholder", "♪"));
      }

      const main = el("div", "rank-main");
      const href = safeHttpUrl(track.uri);
      if (href) {
        const a = el("a", "rank-title", track.title);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        main.appendChild(a);
      } else {
        main.appendChild(el("div", "rank-title", track.title));
      }

      const meta = el("div", "rank-meta");
      const platLabel = track.platform === "spotify" ? "Spotify" : "YouTube";
      meta.textContent = `${track.author || "Artista desconhecido"} • ${platLabel} • ${track.uniqueRequesters} ouvinte(s)`;
      main.appendChild(meta);
      item.appendChild(main);

      const metric = el("div", "rank-metric");
      metric.append(
        el("div", "rank-metric-main", `${track.playCount}x`),
        el("div", "rank-metric-sub", formatDurationShort(track.totalListenedMs)),
      );
      item.appendChild(metric);

      box.appendChild(item);
    });
  }

  function renderTopUsers(users) {
    const box = $("top-users-list");
    clearEl(box);
    if (!users.length) {
      box.appendChild(el("div", "empty-state", "Nenhum uso registrado neste período ainda."));
      return;
    }

    users.forEach((user, idx) => {
      const item = el("div", "rank-item");
      const pos = el("div", `rank-pos ${idx < 3 ? `top-${idx + 1}` : ""}`, `#${idx + 1}`);
      item.appendChild(pos);

      const avatar = safeHttpsUrl(user.avatarUrl);
      if (avatar) {
        const img = document.createElement("img");
        img.src = avatar;
        img.alt = "";
        img.className = "avatar";
        img.loading = "lazy";
        item.appendChild(img);
      } else {
        const initial = (user.displayName || user.username || "?").slice(0, 1).toUpperCase();
        item.appendChild(el("div", "avatar-fallback", initial));
      }

      const main = el("div", "rank-main");
      main.appendChild(el("div", "rank-title", user.displayName));
      const fav = user.favoritePlatform === "spotify" ? " • Prefere Spotify" : user.favoritePlatform === "youtube" ? " • Prefere YouTube" : "";
      main.appendChild(
        el("div", "rank-meta", `@${user.username} • ${user.commandsUsed} comando(s)${fav}`),
      );
      item.appendChild(main);

      const metric = el("div", "rank-metric");
      metric.append(
        el("div", "rank-metric-main", `${user.tracksRequested} música(s)`),
        el("div", "rank-metric-sub", formatDurationShort(user.totalListenedMs)),
      );
      item.appendChild(metric);

      box.appendChild(item);
    });
  }

  function renderBarChartSvg(container, items, labelFn, valueFn, tooltipFn, color) {
    clearEl(container);
    if (!items.length || items.every((i) => valueFn(i) === 0)) {
      container.appendChild(el("div", "empty-state", "Sem atividade suficiente para gerar o gráfico."));
      return;
    }

    const svgNs = "http://www.w3.org/2000/svg";
    const width = 560;
    const height = 200;
    const padLeft = 32;
    const padRight = 10;
    const padTop = 14;
    const padBottom = 28;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    const maxVal = Math.max(1, ...items.map(valueFn));

    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("class", "chart-svg");

    // Linhas horizontais guia
    for (let step = 0; step <= 2; step++) {
      const y = padTop + (plotH * step) / 2;
      const line = document.createElementNS(svgNs, "line");
      line.setAttribute("x1", String(padLeft));
      line.setAttribute("x2", String(width - padRight));
      line.setAttribute("y1", String(y));
      line.setAttribute("y2", String(y));
      line.setAttribute("stroke", "rgba(22, 20, 18, 0.08)");
      svg.appendChild(line);

      const tickVal = Math.round(maxVal * (1 - step / 2));
      const text = document.createElementNS(svgNs, "text");
      text.setAttribute("x", String(padLeft - 6));
      text.setAttribute("y", String(y + 4));
      text.setAttribute("text-anchor", "end");
      text.setAttribute("fill", "#767168");
      text.setAttribute("font-size", "10");
      text.textContent = String(tickVal);
      svg.appendChild(text);
    }

    const slotW = plotW / items.length;
    const barW = Math.max(4, Math.min(26, slotW * 0.68));
    const labelEvery = Math.max(1, Math.ceil(items.length / 8));

    items.forEach((item, idx) => {
      const val = valueFn(item);
      const barH = (val / maxVal) * plotH;
      const x = padLeft + idx * slotW + (slotW - barW) / 2;
      const y = padTop + plotH - barH;

      const rect = document.createElementNS(svgNs, "rect");
      rect.setAttribute("x", x.toFixed(1));
      rect.setAttribute("y", y.toFixed(1));
      rect.setAttribute("width", barW.toFixed(1));
      rect.setAttribute("height", Math.max(val > 0 ? 2 : 0, barH).toFixed(1));
      rect.setAttribute("rx", "3");
      rect.setAttribute("fill", color);

      const title = document.createElementNS(svgNs, "title");
      title.textContent = tooltipFn(item);
      rect.appendChild(title);
      svg.appendChild(rect);

      if (idx % labelEvery === 0 || idx === items.length - 1) {
        const lbl = document.createElementNS(svgNs, "text");
        lbl.setAttribute("x", (x + barW / 2).toFixed(1));
        lbl.setAttribute("y", String(height - 8));
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("fill", "#767168");
        lbl.setAttribute("font-size", "10");
        lbl.textContent = labelFn(item);
        svg.appendChild(lbl);
      }
    });

    container.appendChild(svg);
  }

  function renderDailyChart(daily) {
    const total = daily.reduce((acc, d) => acc + d.plays, 0);
    $("daily-chart-meta").textContent = `${total} reprodução(ões) em ${daily.length} dia(s)`;
    renderBarChartSvg(
      $("daily-chart"),
      daily,
      (d) => d.date.slice(5).replace("-", "/"),
      (d) => d.plays,
      (d) => `${d.date}: ${d.plays} música(s), ${d.commands} comando(s), ${formatDurationShort(d.listenedMs)}`,
      "#f5a600",
    );
  }

  function renderHourlyChart(hourly) {
    renderBarChartSvg(
      $("hourly-chart"),
      hourly,
      (h) => `${String(h.hour).padStart(2, "0")}h`,
      (h) => h.plays,
      (h) => `${String(h.hour).padStart(2, "0")}:00 — ${h.plays} música(s), ${h.commands} comando(s)`,
      "#ea580c",
    );
  }

  function renderPlatforms(platforms) {
    const box = $("platforms-box");
    clearEl(box);
    const yt = platforms.youtube.plays;
    const sp = platforms.spotify.plays;
    const total = yt + sp;

    if (total === 0) {
      box.appendChild(el("div", "empty-state", "Nenhuma reprodução registrada neste período."));
      return;
    }

    const ytPct = Math.round((yt / total) * 100);
    const spPct = 100 - ytPct;

    const bar = el("div", "platform-bar");
    const segYt = el("div", "platform-seg-yt");
    segYt.style.width = `${ytPct}%`;
    const segSp = el("div", "platform-seg-sp");
    segSp.style.width = `${spPct}%`;
    bar.append(segYt, segSp);
    box.appendChild(bar);

    const grid = el("div", "platform-stats-grid");

    const ytCard = el("div", "platform-stat-card");
    ytCard.append(
      el("span", "badge badge-youtube", `YouTube • ${ytPct}%`),
      el("div", "kpi-value", String(yt)),
      el("div", "small-text muted", formatDurationShort(platforms.youtube.listenedMs)),
    );

    const spCard = el("div", "platform-stat-card");
    spCard.append(
      el("span", "badge badge-spotify", `Spotify • ${spPct}%`),
      el("div", "kpi-value", String(sp)),
      el("div", "small-text muted", formatDurationShort(platforms.spotify.listenedMs)),
    );

    grid.append(ytCard, spCard);
    box.appendChild(grid);
  }

  function renderTopCommands(commands) {
    const box = $("commands-box");
    clearEl(box);
    if (!commands.length) {
      box.appendChild(el("div", "empty-state", "Nenhum comando registrado neste período."));
      return;
    }

    const maxCount = Math.max(1, ...commands.map((c) => c.count));
    for (const cmd of commands.slice(0, 8)) {
      const row = el("div", "bar-row");
      const head = el("div", "bar-row-head");
      const label =
        cmd.interactionType === "slash"
          ? `/${cmd.commandName}`
          : `Botão: ${cmd.commandName.replace(/^music:/, "")}`;
      head.append(el("span", "", label), el("span", "muted", `${cmd.count}x`));
      const track = el("div", "bar-track");
      const fill = el("div", "bar-fill");
      fill.style.width = `${Math.max(4, Math.round((cmd.count / maxCount) * 100))}%`;
      track.appendChild(fill);
      row.append(head, track);
      box.appendChild(row);
    }
  }

  function translateEndReason(play) {
    if (play.isLoop) return { label: "Loop", cls: "badge-accent" };
    if (!play.endedAt) return { label: "Tocando", cls: "badge-success" };
    switch (play.endReason) {
      case "finished":
        return { label: "Concluída", cls: "badge-success" };
      case "replaced":
        return { label: "Pulada", cls: "badge-warning" };
      case "stopped":
        return { label: "Parada", cls: "badge-warning" };
      case "loadFailed":
      case "stuck":
        return { label: "Erro", cls: "badge-danger" };
      default:
        return { label: play.endReason || "Encerrada", cls: "" };
    }
  }

  function renderRecentPlays(plays) {
    const tbody = $("recent-plays-body");
    clearEl(tbody);

    if (!plays.length) {
      const tr = document.createElement("tr");
      const td = el("td", "empty-state", "Nenhuma reprodução registrada ainda.");
      td.colSpan = 6;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const play of plays) {
      const tr = document.createElement("tr");

      const titleTd = document.createElement("td");
      const href = safeHttpUrl(play.uri);
      if (href) {
        const a = el("a", "rank-title", play.title);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        titleTd.appendChild(a);
      } else {
        titleTd.appendChild(el("div", "rank-title", play.title));
      }
      if (play.author) {
        titleTd.appendChild(el("div", "small-text muted", play.author));
      }

      const reqTd = el(
        "td",
        "",
        play.requesterDisplayName || play.requesterUsername || "Desconhecido",
      );

      const platTd = document.createElement("td");
      platTd.appendChild(
        el(
          "span",
          `badge ${play.platform === "spotify" ? "badge-spotify" : "badge-youtube"}`,
          play.platform === "spotify" ? "Spotify" : "YouTube",
        ),
      );

      const listenedText =
        play.listenedMs !== null
          ? `${formatTrackClock(play.listenedMs, false)} / ${formatTrackClock(play.durationMs, play.isStream)}`
          : formatTrackClock(play.durationMs, play.isStream);
      const durTd = el("td", "", listenedText);

      const statusTd = document.createElement("td");
      const statusInfo = translateEndReason(play);
      statusTd.appendChild(el("span", `badge ${statusInfo.cls}`, statusInfo.label));

      const whenTd = el("td", "muted small-text", formatDateTime(play.startedAt));

      tr.append(titleTd, reqTd, platTd, durTd, statusTd, whenTd);
      tbody.appendChild(tr);
    }
  }

  /* ==================== Gerenciamento (Admin) ==================== */

  async function loadAdminPage() {
    if (!state.account || state.account.role !== "admin") {
      return;
    }
    try {
      const [settingsRes, accountsRes, invitesRes] = await Promise.all([
        api("/api/settings"),
        api("/api/accounts"),
        api("/api/invites"),
      ]);

      $("set-title").value = settingsRes.settings.dashboardTitle;
      $("set-min-seconds").value = String(settingsRes.settings.minPlaySeconds);
      $("set-session-days").value = String(settingsRes.settings.sessionTtlDays);
      $("set-ignore-loop").checked = Boolean(settingsRes.settings.ignoreLoopInRankings);

      $("admin-accounts-count").textContent = String(accountsRes.accounts.length);
      const activeInvites = invitesRes.invites.filter((i) => i.status === "active").length;
      $("admin-invites-count").textContent = String(activeInvites);

      renderAccountsTable(accountsRes.accounts);
      renderInvitesTable(invitesRes.invites);
    } catch (err) {
      handleSessionError(err);
    }
  }

  function renderInvitesTable(invites) {
    const tbody = $("invites-body");
    clearEl(tbody);

    if (!invites.length) {
      const tr = document.createElement("tr");
      const td = el("td", "empty-state", "Nenhum convite criado ainda.");
      td.colSpan = 7;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const statusMeta = {
      active: { label: "Ativo", cls: "badge-success" },
      used: { label: "Usado", cls: "badge-accent" },
      expired: { label: "Expirado", cls: "badge-warning" },
      revoked: { label: "Revogado", cls: "badge-danger" },
    };

    for (const inv of invites) {
      const tr = document.createElement("tr");
      const prefTd = document.createElement("td");
      prefTd.appendChild(el("code", "", `${inv.codePrefix}-…`));

      const roleTd = document.createElement("td");
      roleTd.appendChild(
        el("span", `badge ${inv.role === "admin" ? "badge-accent" : ""}`, inv.role),
      );

      const noteTd = el("td", "muted", inv.note || "—");

      const stTd = document.createElement("td");
      const st = statusMeta[inv.status] || { label: inv.status, cls: "" };
      stTd.appendChild(el("span", `badge ${st.cls}`, st.label));

      const expTd = el("td", "small-text muted", formatDateTime(inv.expiresAt));
      const usedTd = el("td", "small-text", inv.usedByUsername ? `@${inv.usedByUsername}` : "—");

      const actTd = document.createElement("td");
      if (inv.status === "active") {
        const revokeBtn = el("button", "btn btn-danger-outline btn-sm", "Revogar");
        revokeBtn.type = "button";
        revokeBtn.addEventListener("click", async () => {
          try {
            await api(`/api/invites/${inv.id}`, { method: "DELETE" });
            showToast("Convite revogado.", "success");
            await loadAdminPage();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
        actTd.appendChild(revokeBtn);
      } else {
        actTd.textContent = "—";
      }

      tr.append(prefTd, roleTd, noteTd, stTd, expTd, usedTd, actTd);
      tbody.appendChild(tr);
    }
  }

  function renderAccountsTable(accounts) {
    const tbody = $("accounts-body");
    clearEl(tbody);

    for (const acc of accounts) {
      const isSelf = state.account && acc.id === state.account.id;
      const tr = document.createElement("tr");

      const userTd = document.createElement("td");
      userTd.append(
        el("div", "rank-title", isSelf ? `${acc.displayName} (você)` : acc.displayName),
        el("div", "small-text muted", `@${acc.username}`),
      );

      const roleTd = document.createElement("td");
      roleTd.appendChild(
        el("span", `badge ${acc.role === "admin" ? "badge-accent" : ""}`, acc.role),
      );

      const statusTd = document.createElement("td");
      statusTd.appendChild(
        el(
          "span",
          `badge ${acc.isActive ? "badge-success" : "badge-danger"}`,
          acc.isActive ? "Ativa" : "Desativada",
        ),
      );

      const lastTd = el("td", "small-text muted", formatDateTime(acc.lastLoginAt));

      const actionsTd = document.createElement("td");
      const wrap = el("div", "actions-row");

      const toggleRoleBtn = el(
        "button",
        "btn btn-secondary btn-sm",
        acc.role === "admin" ? "Tornar viewer" : "Tornar admin",
      );
      toggleRoleBtn.type = "button";
      toggleRoleBtn.addEventListener("click", async () => {
        try {
          await api(`/api/accounts/${acc.id}`, {
            method: "PATCH",
            body: { role: acc.role === "admin" ? "viewer" : "admin" },
          });
          showToast("Papel atualizado.", "success");
          if (isSelf) {
            await init();
          } else {
            await loadAdminPage();
          }
        } catch (err) {
          showToast(err.message, "error");
        }
      });
      wrap.appendChild(toggleRoleBtn);

      const resetBtn = el("button", "btn btn-secondary btn-sm", "Resetar senha");
      resetBtn.type = "button";
      resetBtn.addEventListener("click", () => {
        $("reset-target-id").value = String(acc.id);
        $("reset-modal-title").textContent = `Resetar senha de @${acc.username}`;
        $("reset-new-password").value = "";
        refreshPasswordChecklist("reset-new-password");
        $("reset-modal").classList.remove("hidden");
      });
      wrap.appendChild(resetBtn);

      if (!isSelf) {
        const activeBtn = el(
          "button",
          "btn btn-ghost btn-sm",
          acc.isActive ? "Desativar" : "Reativar",
        );
        activeBtn.type = "button";
        activeBtn.addEventListener("click", async () => {
          try {
            await api(`/api/accounts/${acc.id}`, {
              method: "PATCH",
              body: { isActive: !acc.isActive },
            });
            showToast(acc.isActive ? "Conta desativada." : "Conta reativada.", "success");
            await loadAdminPage();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
        wrap.appendChild(activeBtn);

        const delBtn = el("button", "btn btn-danger-outline btn-sm", "Excluir");
        delBtn.type = "button";
        delBtn.addEventListener("click", async () => {
          if (!window.confirm(`Excluir permanentemente a conta @${acc.username}?`)) {
            return;
          }
          try {
            await api(`/api/accounts/${acc.id}`, { method: "DELETE" });
            showToast("Conta excluída.", "success");
            await loadAdminPage();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
        wrap.appendChild(delBtn);
      }

      actionsTd.appendChild(wrap);
      tr.append(userTd, roleTd, statusTd, lastTd, actionsTd);
      tbody.appendChild(tr);
    }
  }

  function handleSessionError(err) {
    if (err && (err.status === 401 || err.status === 426)) {
      void init();
      return;
    }
    showToast(err?.message || "Falha ao carregar dados.", "error");
  }

  /* ==================== Event Listeners ==================== */

  $("tab-login-btn").addEventListener("click", () => switchAuthTab("login"));
  $("tab-register-btn").addEventListener("click", () => switchAuthTab("register"));

  document.querySelectorAll("[data-password-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.passwordToggle;
      const input = targetId ? $(targetId) : null;
      if (!input) return;
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.classList.toggle("is-visible", !showing);
    });
  });

  $("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = $("setup-error");
    errorEl.classList.add("hidden");

    const password = $("setup-password").value;
    const confirm = $("setup-password-confirm").value;
    if (password !== confirm) {
      errorEl.textContent = "As senhas não coincidem.";
      errorEl.classList.remove("hidden");
      return;
    }

    try {
      const res = await api("/api/auth/setup", {
        method: "POST",
        body: {
          setupToken: $("setup-token").value,
          displayName: $("setup-display-name").value,
          username: $("setup-username").value,
          password,
        },
      });
      showToast("Administrador criado com sucesso.", "success");
      enterAuthenticatedApp(res.account);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    }
  });

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = $("login-error");
    errorEl.classList.add("hidden");

    try {
      const res = await api("/api/auth/login", {
        method: "POST",
        body: {
          username: $("login-username").value,
          password: $("login-password").value,
        },
      });
      $("login-password").value = "";
      enterAuthenticatedApp(res.account);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    }
  });

  $("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = $("register-error");
    errorEl.classList.add("hidden");

    const password = $("reg-password").value;
    const confirm = $("reg-password-confirm").value;
    if (password !== confirm) {
      errorEl.textContent = "As senhas não coincidem.";
      errorEl.classList.remove("hidden");
      return;
    }

    try {
      const res = await api("/api/auth/register", {
        method: "POST",
        body: {
          inviteCode: $("reg-invite").value,
          displayName: $("reg-display-name").value,
          username: $("reg-username").value,
          password,
        },
      });
      showToast("Conta criada com sucesso.", "success");
      enterAuthenticatedApp(res.account);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    }
  });

  $("nav-dashboard-btn").addEventListener("click", () => switchPage("dashboard"));
  $("nav-account-btn").addEventListener("click", () => switchPage("account"));
  $("nav-admin-btn").addEventListener("click", () => switchPage("admin"));

  document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchAdminTab(btn.dataset.adminTab || "accounts");
    });
  });

  $("sidebar-toggle-btn").addEventListener("click", () => {
    const nextCollapsed = !$("app-view").classList.contains("sidebar-collapsed");
    applySidebarCollapsed(nextCollapsed);
    saveSidebarPreference(nextCollapsed);
  });

  $("logout-btn").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // Ignora erro e força volta para login
    }
    state.account = null;
    stopLivePolling();
    showOnlyView("auth-view");
  });

  $("logout-all-btn").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout-all", { method: "POST" });
      showToast("Todas as sessões foram encerradas.", "success");
      state.account = null;
      stopLivePolling();
      showOnlyView("auth-view");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("guild-select").addEventListener("change", (e) => {
    state.guildId = e.target.value;
    void loadDashboardData();
  });

  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.range = btn.dataset.range || "30d";
      document.querySelectorAll(".range-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      void loadDashboardData();
    });
  });

  $("refresh-dashboard-btn").addEventListener("click", () => {
    void loadGuilds().then(() => loadDashboardData());
  });

  $("change-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const newPassword = $("cp-new").value;
    if (newPassword !== $("cp-confirm").value) {
      showToast("A confirmação da nova senha não coincide.", "error");
      return;
    }
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: {
          currentPassword: $("cp-current").value,
          newPassword,
        },
      });
      $("change-password-form").reset();
      showToast("Senha atualizada e demais sessões encerradas.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await api("/api/settings", {
        method: "PATCH",
        body: {
          dashboardTitle: $("set-title").value,
          minPlaySeconds: Number($("set-min-seconds").value),
          sessionTtlDays: Number($("set-session-days").value),
          ignoreLoopInRankings: $("set-ignore-loop").checked,
        },
      });
      applyDashboardTitle(res.settings.dashboardTitle);
      showToast("Preferências salvas.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  function closeModal(modalId) {
    $(modalId).classList.add("hidden");
  }

  function openModal(modalId) {
    $(modalId).classList.remove("hidden");
  }

  $("open-create-account-btn").addEventListener("click", () => {
    $("create-account-form").reset();
    refreshPasswordChecklist("acc-password");
    openModal("create-account-modal");
    $("acc-display").focus();
  });

  $("create-account-modal-close").addEventListener("click", () => {
    closeModal("create-account-modal");
  });

  $("open-create-invite-btn").addEventListener("click", () => {
    $("create-invite-form").reset();
    $("invite-hours").value = "48";
    openModal("create-invite-modal");
    $("invite-note").focus();
  });

  $("create-invite-modal-close").addEventListener("click", () => {
    closeModal("create-invite-modal");
  });

  $("dismiss-invite-banner-btn").addEventListener("click", () => {
    $("new-invite-banner").classList.add("hidden");
  });

  $("create-invite-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await api("/api/invites", {
        method: "POST",
        body: {
          role: $("invite-role").value,
          expiresInHours: Number($("invite-hours").value),
          note: $("invite-note").value,
        },
      });
      state.lastInviteCode = res.code;
      $("new-invite-code").textContent = res.code;
      $("new-invite-banner").classList.remove("hidden");
      $("create-invite-form").reset();
      $("invite-hours").value = "48";
      closeModal("create-invite-modal");
      showToast("Convite gerado.", "success");
      await loadAdminPage();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("copy-invite-code-btn").addEventListener("click", async () => {
    if (!state.lastInviteCode) return;
    try {
      await navigator.clipboard.writeText(state.lastInviteCode);
      showToast("Código copiado.", "success");
    } catch {
      showToast("Não foi possível copiar automaticamente.", "error");
    }
  });

  $("copy-invite-link-btn").addEventListener("click", async () => {
    if (!state.lastInviteCode) return;
    const link = `${window.location.origin}/#invite=${encodeURIComponent(state.lastInviteCode)}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast("Link de convite copiado.", "success");
    } catch {
      showToast("Não foi possível copiar automaticamente.", "error");
    }
  });

  $("create-account-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/accounts", {
        method: "POST",
        body: {
          displayName: $("acc-display").value,
          username: $("acc-username").value,
          password: $("acc-password").value,
          role: $("acc-role").value,
        },
      });
      $("create-account-form").reset();
      closeModal("create-account-modal");
      showToast("Conta criada com sucesso.", "success");
      await loadAdminPage();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("reset-modal-close").addEventListener("click", () => {
    closeModal("reset-modal");
  });

  ["reset-modal", "create-account-modal", "create-invite-modal"].forEach((modalId) => {
    $(modalId).addEventListener("click", (e) => {
      if (e.target === $(modalId)) {
        closeModal(modalId);
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ["reset-modal", "create-account-modal", "create-invite-modal"].forEach((modalId) => {
        if (!$(modalId).classList.contains("hidden")) {
          closeModal(modalId);
        }
      });
    }
  });

  $("reset-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const targetId = $("reset-target-id").value;
    try {
      await api(`/api/accounts/${encodeURIComponent(targetId)}`, {
        method: "PATCH",
        body: { newPassword: $("reset-new-password").value },
      });
      $("reset-modal").classList.add("hidden");
      showToast("Senha redefinida e sessões encerradas.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  const PASSWORD_RULES = [
    { key: "length", label: "Mínimo 8 caracteres", test: (v) => v.length >= 8 },
    { key: "upper", label: "1 letra maiúscula", test: (v) => /[A-Z]/.test(v) },
    { key: "lower", label: "1 letra minúscula", test: (v) => /[a-z]/.test(v) },
    { key: "number", label: "1 número", test: (v) => /\d/.test(v) },
  ];

  const passwordRuleUpdaters = new Map();

  function initPasswordRuleChecklists() {
    const svgNs = "http://www.w3.org/2000/svg";

    document.querySelectorAll("[data-password-rules-for]").forEach((container) => {
      const inputId = container.dataset.passwordRulesFor;
      const input = inputId ? $(inputId) : null;
      if (!input) return;

      clearEl(container);
      container.dataset.score = "0";

      const meter = el("div", "pw-meter");
      for (let i = 0; i < PASSWORD_RULES.length; i++) {
        meter.appendChild(el("span", "pw-meter-seg"));
      }
      container.appendChild(meter);

      const list = el("ul", "pw-checklist");
      const itemMap = new Map();

      for (const rule of PASSWORD_RULES) {
        const li = el("li", "pw-rule");
        const dot = el("span", "pw-rule-dot");
        dot.setAttribute("aria-hidden", "true");

        const svg = document.createElementNS(svgNs, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "11");
        svg.setAttribute("height", "11");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "3");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        const poly = document.createElementNS(svgNs, "polyline");
        poly.setAttribute("points", "20 6 9 17 4 12");
        svg.appendChild(poly);
        dot.appendChild(svg);

        const text = el("span", "", rule.label);
        li.append(dot, text);
        list.appendChild(li);
        itemMap.set(rule.key, li);
      }

      container.appendChild(list);

      const update = () => {
        const value = input.value || "";
        let score = 0;
        for (const rule of PASSWORD_RULES) {
          const met = rule.test(value);
          if (met) score += 1;
          itemMap.get(rule.key)?.classList.toggle("met", met);
        }
        container.dataset.score = String(score);
      };

      passwordRuleUpdaters.set(inputId, update);
      input.addEventListener("input", update);
      input.form?.addEventListener("reset", () => {
        setTimeout(update, 0);
      });
      update();
    });
  }

  function refreshPasswordChecklist(inputId) {
    const updater = passwordRuleUpdaters.get(inputId);
    if (updater) updater();
  }

  initPasswordRuleChecklists();

  void init();
})();
