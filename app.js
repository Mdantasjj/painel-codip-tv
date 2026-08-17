(function () {
  "use strict";

  const CONFIG = window.TV_DASHBOARD_CONFIG || {};
  const BASE = window.TV_BASE_DATA || {};
  const DATA = {
    generatedAt: BASE.generatedAt,
    summary: BASE.summary || {},
    municipalityGeo: BASE.municipalityGeo || [],
    byMunicipio: BASE.effectiveByMunicipio || [],
    byVehicleMunicipio: BASE.vehiclesByMunicipio || [],
    vehicleSituations: BASE.vehicleSituations || [],
    vehicleTypes: BASE.vehicleTypes || [],
    regionTotals: BASE.regionTotals || [],
    validation: BASE.validation || {},
    sources: BASE.sources || {},
    movimentacoesEstudo: {
      summary: BASE.movementSummary || {},
      modalities: BASE.movementModalities || []
    }
  };
  const CRIME = BASE.crime || {};
  const number = new Intl.NumberFormat("pt-BR");
  const colors = {
    "CARIRI": "#9ddf83",
    "CENTRO SUL": "#5ca8f5",
    "GRANDE FORTALEZA": "#36d51e",
    "LITORAL LESTE": "#ce91e8",
    "LITORAL NORTE": "#74d5a5",
    "LITORAL OESTE/VALE DO CURU": "#8495a9",
    "MACIÇO DO BATURITÉ": "#2f9345",
    "SERRA DA IBIAPABA": "#9b79dc",
    "SERTÃO CENTRAL": "#83bff1",
    "SERTÃO DE CANINDÉ": "#b9c2bd",
    "SERTÃO DE INHAMUNS": "#8e9cdd",
    "SERTÃO DE SOBRAL": "#766dc9",
    "SERTÃO DOS CRATEÚS": "#3ebbd3",
    "VALE DO JAGUARIBE": "#5d9ce5"
  };
  const MAP_HOME = { x: 35, y: 10, width: 535, height: 500 };
  const regions = Object.keys(colors);
  const initialRegion = "GRANDE FORTALEZA";
  let regionIndex = Math.max(0, regions.indexOf(initialRegion));
  let mapAutoplay = true;
  let mapPointerInside = false;
  let selectedMunicipality = "";
  let mapView = { ...MAP_HOME };
  let mapDrag = null;
  let mapDragged = false;
  let mapSuppressClickUntil = 0;
  let refreshSeconds = Math.max(1, CONFIG.refreshMinutes || 15) * 60;

  const byId = id => document.getElementById(id);
  const fmt = value => number.format(Math.round(Number(value) || 0));
  const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
  const escapeHtml = value => String(value || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  const monthNames = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

  function formatPeriod(period) {
    if (!period) return "Base atual";
    if (typeof period === "string") return period;
    const parse = value => {
      const parts = String(value || "").split("-");
      return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : String(value || "");
    };
    if (period.inicio && period.fim) return `${parse(period.inicio)} a ${parse(period.fim)}`;
    return "Base atual";
  }

  function monthLabel(row) {
    const match = String(row.periodo || "").match(/^(\d{4})-(\d{2})$/);
    if (match) return `${monthNames[Number(match[2]) - 1]}/${match[1].slice(-2)}`;
    return String(row.mesLabel || row.periodo || "").slice(0, 8).toUpperCase();
  }

  function formatMonthRange(period) {
    if (!period || typeof period !== "object") return "Base atual";
    const start = String(period.inicio || "").match(/^(\d{4})-(\d{2})/);
    const end = String(period.fim || "").match(/^(\d{4})-(\d{2})/);
    if (!start || !end) return formatPeriod(period);
    const startLabel = monthNames[Number(start[2]) - 1] || start[2];
    const endLabel = monthNames[Number(end[2]) - 1] || end[2];
    if (start[1] === end[1]) return start[2] === end[2] ? `${startLabel}/${start[1]}` : `${startLabel}–${endLabel}/${start[1]}`;
    return `${startLabel}/${start[1]}–${endLabel}/${end[1]}`;
  }

  function fitStage() {
    const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    byId("tvStage").style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  function project(point) {
    const [lon, lat] = point;
    return [38 + ((lon + 41.5) / 4.35) * 530, 16 + ((-lat - 2.72) / 5.18) * 485];
  }

  function geometryPath(geometry) {
    const polygonPath = polygon => polygon.map(ring => {
      const coords = ring.map(project);
      return `M${coords.map(point => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join("L")}Z`;
    }).join("");
    if (!geometry) return "";
    if (geometry.type === "Polygon") return polygonPath(geometry.coordinates);
    if (geometry.type === "MultiPolygon") return geometry.coordinates.map(polygonPath).join("");
    return "";
  }

  function constrainMapView(view) {
    const minWidth = MAP_HOME.width / 6;
    const width = Math.min(MAP_HOME.width, Math.max(minWidth, view.width));
    const height = width * MAP_HOME.height / MAP_HOME.width;
    const x = Math.min(MAP_HOME.x + MAP_HOME.width - width, Math.max(MAP_HOME.x, view.x));
    const y = Math.min(MAP_HOME.y + MAP_HOME.height - height, Math.max(MAP_HOME.y, view.y));
    return { x, y, width, height };
  }

  function applyMapView(view, animated = true) {
    mapView = constrainMapView(view);
    const svg = byId("cearaMap");
    svg.classList.toggle("map-view-animated", animated);
    svg.setAttribute("viewBox", `${mapView.x.toFixed(2)} ${mapView.y.toFixed(2)} ${mapView.width.toFixed(2)} ${mapView.height.toFixed(2)}`);
    byId("mapZoomLevel").textContent = `${Math.round(MAP_HOME.width / mapView.width * 100)}%`;
  }

  function resetMapView(animated = true) {
    applyMapView({ ...MAP_HOME }, animated);
  }

  function zoomMap(factor, anchor) {
    const targetWidth = mapView.width * factor;
    const targetHeight = targetWidth * MAP_HOME.height / MAP_HOME.width;
    const point = anchor || { x: mapView.x + mapView.width / 2, y: mapView.y + mapView.height / 2 };
    const ratio = targetWidth / mapView.width;
    applyMapView({
      x: point.x - (point.x - mapView.x) * ratio,
      y: point.y - (point.y - mapView.y) * ratio,
      width: targetWidth,
      height: targetHeight
    }, false);
  }

  function fitMapToPaths(paths, minimumWidth = 115) {
    const boxes = paths.map(path => path.getBBox()).filter(box => box.width && box.height);
    if (!boxes.length) return;
    const minX = Math.min(...boxes.map(box => box.x));
    const minY = Math.min(...boxes.map(box => box.y));
    const maxX = Math.max(...boxes.map(box => box.x + box.width));
    const maxY = Math.max(...boxes.map(box => box.y + box.height));
    const padding = Math.max(10, Math.min(26, Math.max(maxX - minX, maxY - minY) * .12));
    let width = Math.max(minimumWidth, maxX - minX + padding * 2);
    let height = maxY - minY + padding * 2;
    const aspect = MAP_HOME.width / MAP_HOME.height;
    if (width / height > aspect) height = width / aspect;
    else width = height * aspect;
    applyMapView({
      x: (minX + maxX) / 2 - width / 2,
      y: (minY + maxY) / 2 - height / 2,
      width,
      height
    });
  }

  function focusRegion(region) {
    fitMapToPaths(Array.from(document.querySelectorAll("#cearaMap path")).filter(path => path.dataset.region === region), 150);
  }

  function focusMunicipality(key) {
    const path = Array.from(document.querySelectorAll("#cearaMap path")).find(node => node.dataset.key === key);
    if (path) fitMapToPaths([path], 100);
  }

  function buildMapData(features) {
    const regional = Object.fromEntries(DATA.regionTotals.map(row => [row.macrorregiao, {
      name: row.macrorregiao,
      occurrences: Number(row.ocorrencias) || 0,
      effective: Number(row.efetivo) || 0,
      available: Number(row.disponivel) || 0,
      vehicles: Number(row.viaturas) || 0,
      operating: Number(row.viaturasOperando) || 0,
      municipalities: Number(row.municipios) || 0
    }]));
    regions.forEach(name => {
      if (!regional[name]) regional[name] = { name, occurrences: 0, effective: 0, available: 0, vehicles: 0, operating: 0, municipalities: 0 };
    });

    const crimeByMunicipality = new Map((CRIME.byMunicipio || []).map(row => [normalize(row.municipio), row]));
    const municipalities = new Map();
    features.forEach(feature => {
      const key = normalize(feature.municipio);
      const crimeRow = crimeByMunicipality.get(key) || {};
      municipalities.set(key, {
        name: feature.municipio,
        region: crimeRow.macrorregiao || "SEM CLASSIFICAÇÃO",
        occurrences: Number(crimeRow.total) || 0,
        principalCrime: crimeRow.principalCrime || "Não informado",
        effective: 0,
        available: 0,
        vehicles: 0,
        operating: 0
      });
    });
    (DATA.byMunicipio || []).forEach(row => {
      const item = municipalities.get(normalize(row.municipio));
      if (!item) return;
      item.effective += Number(row.total) || 0;
      item.available += Number(row.disponivel) || 0;
    });
    (DATA.byVehicleMunicipio || []).forEach(row => {
      const item = municipalities.get(normalize(row.municipio));
      if (!item) return;
      item.vehicles += Number(row.total) || 0;
      item.operating += Number(row.operando) || 0;
    });
    return { regional, municipalities };
  }

  function setActiveRegion(selected) {
    const select = byId("activeRegion");
    select.value = selected;
    select.style.borderColor = colors[selected] || "#19854b";
    select.style.setProperty("--region-color", colors[selected] || "#19854b");
  }

  function renderMap(features, regional, municipalities) {
    const svg = byId("cearaMap");
    if (!features.length) {
      byId("mapMessage").hidden = false;
      return;
    }
    byId("activeRegion").innerHTML = regions.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    svg.innerHTML = features.map(feature => {
      const key = normalize(feature.municipio);
      const item = municipalities.get(key) || {};
      const region = item.region;
      const label = `${feature.municipio}, ${region}: ${fmt(item.occurrences)} ocorrências, ${fmt(item.available)} policiais disponíveis de ${fmt(item.effective)} e ${fmt(item.operating)} viaturas operando de ${fmt(item.vehicles)}`;
      return `<path d="${geometryPath(feature.geometry)}" fill="${colors[region] || "#d6dfd8"}" data-region="${escapeHtml(region)}" data-key="${escapeHtml(key)}" data-name="${escapeHtml(feature.municipio)}" role="button" tabindex="0" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title></path>`;
    }).join("");
    byId("regionLegend").innerHTML = `<span class="map-source"><strong>14 macrorregiões oficiais</strong><i></i><span class="municipality-key"><b aria-hidden="true"></b>184 municípios</span><i></i> passe o cursor ou clique</span>`;

    const ranked = Object.values(regional).sort((a, b) => b.occurrences - a.occurrences).slice(0, 5);
    const max = Math.max(...ranked.map(item => item.occurrences), 1);
    byId("regionRanking").innerHTML = ranked.map((item, index) => `
      <button class="rank-row" type="button" data-region="${escapeHtml(item.name)}" aria-label="${index + 1}º lugar: ${escapeHtml(item.name)}, ${fmt(item.occurrences)} ocorrências">
        <span class="rank-number">${index + 1}</span><span class="rank-name">${escapeHtml(item.name)}</span>
        <div class="rank-track"><div class="rank-bar" style="width:${Math.max(3, item.occurrences / max * 100)}%;background:${colors[item.name]};animation-delay:${index * 90}ms"></div></div>
        <span class="rank-value">${fmt(item.occurrences)}</span>
      </button>`).join("");
    setupMapInteraction(regional, municipalities);
    updateRegion(regional, initialRegion);
  }

  function setMapAutoplay(active) {
    mapAutoplay = active;
    const button = byId("mapAutoButton");
    button.setAttribute("aria-pressed", String(active));
    button.title = active ? "Pausar rotação automática" : "Retomar rotação automática";
    button.querySelector(".map-auto-icon").textContent = active ? "Ⅱ" : "▶";
    byId("mapAutoLabel").textContent = active ? "Automático" : "Pausado";
  }

  function selectRegion(regional, selected, manual = false) {
    selectedMunicipality = "";
    regionIndex = Math.max(0, regions.indexOf(selected));
    if (manual) setMapAutoplay(false);
    updateRegion(regional, selected);
    if (manual) focusRegion(selected);
  }

  function showMunicipality(item, pinned = false) {
    if (!item) return;
    if (pinned) {
      selectedMunicipality = normalize(item.name);
      setMapAutoplay(false);
    }
    document.querySelectorAll("#cearaMap path").forEach(path => {
      path.classList.toggle("municipality-selected", path.dataset.key === normalize(item.name));
      path.classList.toggle("dimmed", path.dataset.key !== normalize(item.name));
      path.classList.remove("highlighted");
    });
    setActiveRegion(item.region);
    byId("regionSummary").style.borderLeftColor = colors[item.region] || "#19854b";
    byId("regionSummary").innerHTML = `
      <div class="summary-name">${escapeHtml(item.name)}</div>
      <div class="summary-kicker">Município · ${escapeHtml(item.region)}${pinned ? " · selecionado" : ""}</div>
      <dl>
        <dt>Ocorrências</dt><dd>${fmt(item.occurrences)}</dd>
        <dt>Efetivo total</dt><dd>${fmt(item.effective)}</dd>
        <dt>Disponíveis</dt><dd>${fmt(item.available)}</dd>
        <dt>Frota total</dt><dd>${fmt(item.vehicles)}</dd>
        <dt>Operando</dt><dd>${fmt(item.operating)}</dd>
      </dl>`;
    if (pinned) focusMunicipality(selectedMunicipality);
  }

  function positionMapTooltip(event, item) {
    const tooltip = byId("mapTooltip");
    const wrap = document.querySelector(".map-wrap");
    const rect = wrap.getBoundingClientRect();
    const scaleX = rect.width / wrap.offsetWidth || 1;
    const scaleY = rect.height / wrap.offsetHeight || 1;
    tooltip.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.region)}</span><br>${fmt(item.occurrences)} ocorr. · ${fmt(item.available)}/${fmt(item.effective)} efetivo · ${fmt(item.operating)}/${fmt(item.vehicles)} viaturas`;
    tooltip.style.left = `${Math.min(wrap.offsetWidth - 245, Math.max(8, (event.clientX - rect.left) / scaleX))}px`;
    tooltip.style.top = `${Math.min(wrap.offsetHeight - 25, Math.max(25, (event.clientY - rect.top) / scaleY))}px`;
    tooltip.hidden = false;
  }

  function setupMapInteraction(regional, municipalities) {
    const svg = byId("cearaMap");
    const wrap = document.querySelector(".map-wrap");
    const restore = () => {
      byId("mapTooltip").hidden = true;
      document.querySelectorAll("#cearaMap path").forEach(path => path.classList.remove("hovered"));
      if (selectedMunicipality) showMunicipality(municipalities.get(selectedMunicipality), false);
      else updateRegion(regional, regions[regionIndex]);
    };
    const activatePath = path => {
      if (!path) return;
      if (performance.now() < mapSuppressClickUntil) return;
      const item = municipalities.get(path.dataset.key);
      if (selectedMunicipality === path.dataset.key) {
        selectedMunicipality = "";
        updateRegion(regional, item.region);
        focusRegion(item.region);
      } else showMunicipality(item, true);
    };

    svg.addEventListener("pointermove", event => {
      if (mapDrag) {
        const rect = svg.getBoundingClientRect();
        const dx = (event.clientX - mapDrag.clientX) * mapDrag.view.width / rect.width;
        const dy = (event.clientY - mapDrag.clientY) * mapDrag.view.height / rect.height;
        if (Math.abs(event.clientX - mapDrag.clientX) + Math.abs(event.clientY - mapDrag.clientY) > 4) mapDragged = true;
        applyMapView({ ...mapDrag.view, x: mapDrag.view.x - dx, y: mapDrag.view.y - dy }, false);
        byId("mapTooltip").hidden = true;
        return;
      }
      const path = event.target.closest("path[data-key]");
      if (!path) return;
      const item = municipalities.get(path.dataset.key);
      document.querySelectorAll("#cearaMap path.hovered").forEach(node => node.classList.remove("hovered"));
      path.classList.add("hovered");
      positionMapTooltip(event, item);
      if (!selectedMunicipality) showMunicipality(item, false);
    });
    svg.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      mapDrag = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, view: { ...mapView } };
      mapDragged = false;
      svg.setPointerCapture(event.pointerId);
      wrap.classList.add("is-panning");
    });
    const endPan = event => {
      if (!mapDrag || (event.pointerId !== undefined && mapDrag.pointerId !== event.pointerId)) return;
      if (mapDragged) mapSuppressClickUntil = performance.now() + 250;
      mapDrag = null;
      mapDragged = false;
      wrap.classList.remove("is-panning");
    };
    svg.addEventListener("pointerup", endPan);
    svg.addEventListener("pointercancel", endPan);
    svg.addEventListener("wheel", event => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const anchor = {
        x: mapView.x + (event.clientX - rect.left) / rect.width * mapView.width,
        y: mapView.y + (event.clientY - rect.top) / rect.height * mapView.height
      };
      zoomMap(event.deltaY < 0 ? .78 : 1.28, anchor);
    }, { passive: false });
    svg.addEventListener("pointerleave", restore);
    svg.addEventListener("click", event => activatePath(event.target.closest("path[data-key]")));
    svg.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const path = event.target.closest("path[data-key]");
      if (!path) return;
      event.preventDefault();
      activatePath(path);
    });
    wrap.addEventListener("pointerenter", () => { mapPointerInside = true; wrap.classList.add("is-interactive"); });
    wrap.addEventListener("pointerleave", () => { mapPointerInside = false; wrap.classList.remove("is-interactive"); });
    byId("activeRegion").addEventListener("change", event => selectRegion(regional, event.target.value, true));
    byId("regionRanking").addEventListener("click", event => {
      const button = event.target.closest("button[data-region]");
      if (button) selectRegion(regional, button.dataset.region, true);
    });
    byId("mapAutoButton").addEventListener("click", () => {
      selectedMunicipality = "";
      const nextState = !mapAutoplay;
      setMapAutoplay(nextState);
      updateRegion(regional, regions[regionIndex]);
      if (nextState) resetMapView();
    });
    byId("mapZoomIn").addEventListener("click", () => zoomMap(.78));
    byId("mapZoomOut").addEventListener("click", () => zoomMap(1.28));
    byId("mapReset").addEventListener("click", () => {
      selectedMunicipality = "";
      updateRegion(regional, regions[regionIndex]);
      resetMapView();
    });
  }

  function updateRegion(regional, selected) {
    const item = regional[selected];
    if (!item) return;
    setActiveRegion(selected);
    byId("regionSummary").style.borderLeftColor = colors[selected] || "#19854b";
    document.querySelectorAll("#cearaMap path").forEach(path => {
      path.classList.toggle("highlighted", path.dataset.region === selected);
      path.classList.toggle("dimmed", path.dataset.region !== selected);
      path.classList.remove("municipality-selected");
    });
    document.querySelectorAll(".rank-row[data-region]").forEach(button => button.classList.toggle("active", button.dataset.region === selected));
    byId("regionSummary").innerHTML = `
      <div class="summary-name">${escapeHtml(selected)}</div>
      <div class="summary-kicker">Macrorregião oficial selecionada</div>
      <dl>
        <dt>Ocorrências</dt><dd>${fmt(item.occurrences)}</dd>
        <dt>Efetivo total</dt><dd>${fmt(item.effective)}</dd>
        <dt>Disponíveis</dt><dd>${fmt(item.available)}</dd>
        <dt>Frota total</dt><dd>${fmt(item.vehicles)}</dd>
        <dt>Operando</dt><dd>${fmt(item.operating)}</dd>
        <dt>Municípios</dt><dd>${fmt(item.municipalities)}</dd>
      </dl>`;
  }

  function renderOccurrenceChart(rows) {
    const host = byId("occurrenceChart");
    if (!rows.length) return;
    const w = 820, h = 160, left = 48, right = 18, top = 20, bottom = 34;
    const max = Math.max(...rows.map(row => Number(row.total) || 0), 1) * 1.12;
    const step = (w - left - right) / Math.max(rows.length - 1, 1);
    const y = value => top + (h - top - bottom) * (1 - value / max);
    const points = rows.map((row, index) => [left + index * step, y(Number(row.total) || 0)]);
    const line = points.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(" ");
    const area = `${line} L${points.at(-1)[0]},${h - bottom} L${points[0][0]},${h - bottom} Z`;
    const grids = [0, .5, 1].map(t => `<line class="grid-line" x1="${left}" y1="${top + (h - top - bottom) * t}" x2="${w - right}" y2="${top + (h - top - bottom) * t}"/>`).join("");
    host.innerHTML = `<svg viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a8de00" stop-opacity=".28"/><stop offset="1" stop-color="#a8de00" stop-opacity="0"/></linearGradient></defs>
      ${grids}<path class="trend-area" d="${area}"/><path class="trend-line" d="${line}"/>
      ${points.map((point, index) => `<circle class="trend-point" cx="${point[0]}" cy="${point[1]}" r="5"/><text class="value-label" x="${point[0]}" y="${point[1] - 11}" text-anchor="middle">${fmt(rows[index].total)}</text><text class="axis-label" x="${point[0]}" y="${h - 13}" text-anchor="middle">${monthLabel(rows[index])}</text>`).join("")}
    </svg>`;
    const first = Number(rows[0].total) || 0;
    const last = Number(rows.at(-1).total) || 0;
    const delta = first ? (last - first) / first * 100 : 0;
    byId("trendCaption").textContent = `${delta >= 0 ? "+" : ""}${delta.toFixed(1).replace(".", ",")}% no período`;
  }

  function renderVehicleChart(rows) {
    const host = byId("vehicleChart");
    if (!rows.length) return;
    const palette = { OPERANDO: "#78b900", INSERVIVEL: "#e4572e", BAIXADA: "#f2a900", DESCARGA: "#64748b", INATIVO: "#9ca3af" };
    const labels = { OPERANDO: "OPERANDO", INSERVIVEL: "INSERVÍVEL", BAIXADA: "BAIXADA", DESCARGA: "DESCARGA", INATIVO: "INATIVO" };
    const w = 980, h = 160, left = 140, right = 95, top = 5, rowHeight = 30;
    const max = Math.max(...rows.map(row => Number(row.total) || 0), 1);
    const total = rows.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
    host.innerHTML = `<svg viewBox="0 0 ${w} ${h}">
      ${rows.map((row, index) => {
        const status = String(row.situacao_viatura || "").toUpperCase();
        const value = Number(row.total) || 0;
        const width = Math.max(value ? 2 : 0, value / max * (w - left - right));
        const y = top + index * rowHeight;
        const pct = total ? value / total * 100 : 0;
        return `<text class="fleet-status-label" x="${left - 12}" y="${y + 16}" text-anchor="end">${escapeHtml(labels[status] || status)}</text><rect class="fleet-status-track" x="${left}" y="${y + 2}" width="${w - left - right}" height="18" rx="4"/><rect class="fleet-status-bar" x="${left}" y="${y + 2}" width="${width}" height="18" rx="4" fill="${palette[status] || "#94a3b8"}" style="animation-delay:${index * 90}ms"/><text class="fleet-status-value" x="${Math.min(w - 4, left + width + 9)}" y="${y + 16}">${fmt(value)} · ${pct.toFixed(1).replace(".", ",")}%</text>`;
      }).join("")}
    </svg>`;
  }

  function fillIndicators() {
    const summary = DATA.summary || {};
    const crimeSummary = CRIME.summary || {};
    const movement = DATA.movimentacoesEstudo.summary || {};
    const operatingPct = summary.viaturas ? summary.viaturasOperando / summary.viaturas * 100 : 0;
    byId("effectiveTotal").textContent = fmt(summary.total);
    byId("effectiveHint").textContent = `${fmt(summary.disponivel)} disponíveis`;
    byId("vehicleTotal").textContent = fmt(summary.viaturas);
    byId("operatingVehicles").textContent = fmt(summary.viaturasOperando);
    byId("operatingVehicleHint").textContent = `${operatingPct.toFixed(1).replace(".", ",")}% da frota`;
    byId("movementTotal").textContent = fmt(movement.total);
    byId("movementPeriod").textContent = movement.periodo || "Período da base";
    const modalityLabels = {
      "TRANSFERÊNCIA": "TRANSFERÊNCIAS",
      "PERMUTA": "PERMUTAS",
      "CLASSIFICAÇÃO": "CLASSIFICAÇÕES",
      "DISPOSIÇÃO": "DISPOSIÇÕES",
      "REVERTIDO BSP": "REVERTIDOS BSP",
      "CESSÃO": "CESSÕES"
    };
    byId("movementModalities").innerHTML = DATA.movimentacoesEstudo.modalities
      .map(row => `<span title="${escapeHtml(row.modalidade)}"><b>${fmt(row.total)}</b>${escapeHtml(modalityLabels[row.modalidade] || row.modalidade)}</span>`)
      .join("");
    byId("crimeTotal").textContent = fmt(crimeSummary.ocorrencias);
    const territorialPeriod = formatMonthRange(CRIME.periodo);
    const stateCrimePeriod = CRIME.cvpSource?.periodoLabel || CRIME.cvliSource?.periodoLabel || formatMonthRange(CRIME.cvpPeriodo || CRIME.cvliPeriodo || CRIME.periodo);
    byId("crimeDelta").textContent = `${territorialPeriod} · base detalhada`;
    byId("cvpTotal").textContent = fmt(crimeSummary.cvp);
    byId("cvpHint").textContent = `${CRIME.cvpSource?.periodoLabel || formatPeriod(CRIME.cvpPeriodo || CRIME.periodo)} · SSPDS`;
    byId("cvliTotal").textContent = fmt(crimeSummary.cvli);
    byId("cvliHint").textContent = `${CRIME.cvliSource?.periodoLabel || formatPeriod(CRIME.cvliPeriodo || CRIME.periodo)} · SSPDS`;
    byId("crimePeriod").textContent = "Períodos nos cartões";
    byId("territorialPeriod").textContent = `Leitura territorial · ${territorialPeriod}`;
    byId("rankingPeriod").textContent = `Ocorrências · ${territorialPeriod}`;
    byId("updatedAt").textContent = DATA.generatedAt || "—";
    byId("territorialUpdatedAt").textContent = territorialPeriod;
    byId("stateCrimeUpdatedAt").textContent = stateCrimePeriod;
    byId("fleetBaseDate").textContent = `Frota: ${DATA.sources.vehiclesUpdatedAt || DATA.generatedAt || "base atual"}`;
    const checksOk = DATA.validation.territorialChecks?.todosConferem === true;
    byId("dataQuality").textContent = checksOk ? "Totais territoriais conferidos" : "Revisar validação territorial";
  }

  function startTicker() {
    const summary = DATA.summary || {};
    const movement = DATA.movimentacoesEstudo.summary || {};
    const availablePct = summary.total ? summary.disponivel / summary.total * 100 : 0;
    const operatingPct = summary.viaturas ? summary.viaturasOperando / summary.viaturas * 100 : 0;
    const messages = [
      `Efetivo disponível: ${fmt(summary.disponivel)} (${availablePct.toFixed(1).replace(".", ",")}%)`,
      `${fmt(summary.viaturasOperando)} de ${fmt(summary.viaturas)} viaturas operando (${operatingPct.toFixed(1).replace(".", ",")}%)`,
      `CVP em 2026: ${fmt(CRIME.summary?.cvp)} ocorrências até julho · SSPDS`,
      `CVLI em 2026: ${fmt(CRIME.summary?.cvli)} vítimas até julho · SSPDS`,
      `${fmt(movement.entradas)} entradas e ${fmt(movement.saidas)} saídas no período`,
      `Modalidades: ${DATA.movimentacoesEstudo.modalities.map(row => `${row.modalidade} ${fmt(row.total)}`).join(" · ")}`,
      `Mapa validado nos 184 municípios e 14 macrorregiões oficiais`,
      `Próxima atualização automática em ${CONFIG.refreshMinutes || 15} minutos`
    ];
    const group = `<div class="ticker-group">${messages.map(message => `<span>${message}</span>`).join("")}</div>`;
    byId("tickerTrack").innerHTML = group + group;
  }

  function tickClock() {
    const now = new Date();
    byId("clock").textContent = now.toLocaleTimeString("pt-BR", { hour12: false });
    refreshSeconds -= 1;
    if (refreshSeconds <= 0) window.location.reload();
    const min = Math.floor(refreshSeconds / 60), sec = refreshSeconds % 60;
    byId("refreshCountdown").textContent = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function setupFullscreen() {
    byId("fullscreenButton").addEventListener("click", async () => {
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
        else await document.exitFullscreen();
      } catch (_) { /* O modo quiosque do navegador continua disponível. */ }
    });
  }

  function init() {
    fitStage();
    fillIndicators();
    const features = DATA.municipalityGeo || [];
    const mapData = buildMapData(features);
    renderMap(features, mapData.regional, mapData.municipalities);
    renderOccurrenceChart(CRIME.cvliByMonth?.length ? CRIME.cvliByMonth : (CRIME.byMonth || []));
    renderVehicleChart(DATA.vehicleSituations);
    startTicker();
    setupFullscreen();
    tickClock();
    setInterval(tickClock, 1000);
    setInterval(() => {
      if (!mapAutoplay || mapPointerInside || selectedMunicipality) return;
      regionIndex = (regionIndex + 1) % regions.length;
      updateRegion(mapData.regional, regions[regionIndex]);
    }, Math.max(3, CONFIG.regionRotationSeconds || 7) * 1000);
    window.addEventListener("resize", fitStage);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
