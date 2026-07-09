const AREAS = [
  { id: 105, name: "Tribeca" },
  { id: 106, name: "Stuyvesant Town/PCV" },
  { id: 107, name: "Soho" },
  { id: 108, name: "Little Italy" },
  { id: 110, name: "Chinatown" },
  { id: 112, name: "Battery Park City" },
  { id: 115, name: "Chelsea" },
  { id: 116, name: "Greenwich Village" },
  { id: 117, name: "East Village" },
  { id: 146, name: "Hudson Yards" },
  { id: 157, name: "West Village" },
  { id: 162, name: "Nolita" },
];

const VIEWED_STORAGE_KEY = "first-look:viewed-listings:v1";
const LIKED_STORAGE_KEY = "first-look:liked-listings:v1";
const HIDDEN_STORAGE_KEY = "first-look:hidden-listings:v1";

function loadStoredIds(storageKey) {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return new Set(Array.isArray(stored) ? stored.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveStoredIds(storageKey, ids) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...ids]));
  } catch {
    // The visible state still works when storage is unavailable.
  }
}

function userStateSnapshot() {
  return {
    viewedListings: [...state.viewedListings],
    likedListings: [...state.likedListings],
    hiddenListings: [...state.hiddenListings],
  };
}

function cacheUserState(value) {
  saveStoredIds(VIEWED_STORAGE_KEY, value.viewedListings);
  saveStoredIds(LIKED_STORAGE_KEY, value.likedListings);
  saveStoredIds(HIDDEN_STORAGE_KEY, value.hiddenListings);
}

function applyUserState(value) {
  state.viewedListings = new Set(value.viewedListings.map(String));
  state.likedListings = new Set(value.likedListings.map(String));
  state.hiddenListings = new Set(value.hiddenListings.map(String));
  cacheUserState(state);
}

async function saveUserStateSnapshot(snapshot) {
  const response = await fetch("/api/user-state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Saved-listing sync failed.");
  }
  return payload;
}

let userStateSaveQueue = Promise.resolve();

function queueUserStateSave() {
  const snapshot = userStateSnapshot();
  userStateSaveQueue = userStateSaveQueue
    .then(() => saveUserStateSnapshot(snapshot))
    .catch(() => {
      showNotice(
        "Changes are saved on this device, but cross-device sync is temporarily unavailable.",
      );
    });
}

async function hydrateUserState() {
  try {
    const response = await fetch("/api/user-state");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Saved-listing sync failed.");
    }

    if (payload.initialized) {
      applyUserState(payload);
    } else {
      await saveUserStateSnapshot(userStateSnapshot());
    }
  } catch {
    // Keep using the local copy when the server is temporarily unavailable.
  }
}

const state = {
  selectedAreas: new Set(AREAS.map((area) => area.id)),
  listings: [],
  sort: "newest",
  loading: false,
  likedOnly: false,
  view: "list",
  map: null,
  mapLayer: null,
  mapMarkers: new Map(),
  mapListingSignature: "",
  selectedMapListingId: null,
  drawingPolygon: false,
  polygonPoints: [],
  polygonShape: null,
  polygonVertices: null,
  detailPhotos: [],
  detailPhotoIndex: 0,
  detailRequest: null,
  viewedListings: loadStoredIds(VIEWED_STORAGE_KEY),
  likedListings: loadStoredIds(LIKED_STORAGE_KEY),
  hiddenListings: loadStoredIds(HIDDEN_STORAGE_KEY),
};

const elements = {
  addArea: document.querySelector("#add-area"),
  addAreaButton: document.querySelector("#add-area-button"),
  areaChips: document.querySelector("#area-chips"),
  clearPolygon: document.querySelector("#clear-polygon"),
  clearViewed: document.querySelector("#clear-viewed"),
  drawPolygon: document.querySelector("#draw-polygon"),
  detailAddress: document.querySelector("#detail-address"),
  detailAmenities: document.querySelector("#detail-amenities"),
  detailArea: document.querySelector("#detail-area"),
  detailBuildingName: document.querySelector("#detail-building-name"),
  detailBuildingStats: document.querySelector("#detail-building-stats"),
  detailCity: document.querySelector("#detail-city"),
  detailDescription: document.querySelector("#detail-description"),
  detailFacts: document.querySelector("#detail-facts"),
  detailFlags: document.querySelector("#detail-flags"),
  detailOpenHouses: document.querySelector("#detail-open-houses"),
  detailPhoto: document.querySelector("#detail-photo"),
  detailPhotoCount: document.querySelector("#detail-photo-count"),
  detailPhotoNext: document.querySelector("#detail-photo-next"),
  detailPhotoPrevious: document.querySelector("#detail-photo-previous"),
  detailPrice: document.querySelector("#detail-price"),
  detailThumbnails: document.querySelector("#detail-thumbnails"),
  detailTransit: document.querySelector("#detail-transit"),
  finishPolygon: document.querySelector("#finish-polygon"),
  filterForm: document.querySelector("#filter-form"),
  heroHours: document.querySelector("#hero-hours"),
  hours: document.querySelector("#hours"),
  hoursOutput: document.querySelector("#hours-output"),
  listingGrid: document.querySelector("#listing-grid"),
  includeSourceListings: document.querySelector("#include-source-listings"),
  listingDetail: document.querySelector("#listing-detail"),
  listingDetailError: document.querySelector("#listing-detail-error"),
  listingDetailErrorMessage: document.querySelector(
    "#listing-detail-error-message",
  ),
  listingDetailLoading: document.querySelector("#listing-detail-loading"),
  listingDetailScroll: document.querySelector("#listing-detail-scroll"),
  listingTemplate: document.querySelector("#listing-template"),
  listingViewer: document.querySelector("#listing-viewer"),
  listingViewerClose: document.querySelector("#listing-viewer-close"),
  listingViewerExternal: document.querySelector("#listing-viewer-external"),
  listingViewerTitle: document.querySelector("#listing-viewer-title"),
  likedOnly: document.querySelector("#liked-only"),
  listViewButton: document.querySelector("#list-view-button"),
  listingMap: document.querySelector("#listing-map"),
  mapSelection: document.querySelector("#map-selection"),
  mapView: document.querySelector("#map-view"),
  mapViewButton: document.querySelector("#map-view-button"),
  mobileFilterSummary: document.querySelector("#mobile-filter-summary"),
  mobileFilterToggle: document.querySelector("#mobile-filter-toggle"),
  notice: document.querySelector("#notice"),
  polygonInstruction: document.querySelector("#polygon-instruction"),
  polygonStatus: document.querySelector("#polygon-status"),
  resetFilters: document.querySelector("#reset-filters"),
  restoreHidden: document.querySelector("#restore-hidden"),
  resultCount: document.querySelector("#result-count"),
  resultLabel: document.querySelector("#result-label"),
  sortOrder: document.querySelector("#sort-order"),
  sync: document.querySelector(".sync"),
  syncLabel: document.querySelector("#sync-label"),
  timelineLabels: document.querySelector("#timeline-labels"),
  timelineMarkers: document.querySelector("#timeline-markers"),
  undoPolygon: document.querySelector("#undo-polygon"),
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const mobileViewport = window.matchMedia("(max-width: 700px)");

function formatFilterPrice(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && value !== ""
    ? currency.format(amount)
    : "Any";
}

function updateMobileFilterSummary() {
  const minPrice = document.querySelector("#min-price").value;
  const maxPrice = document.querySelector("#max-price").value;
  const price =
    minPrice || maxPrice
      ? `${formatFilterPrice(minPrice)}–${formatFilterPrice(maxPrice)}`
      : "Any rent";
  const sourceSuffix = elements.includeSourceListings?.checked
    ? " · source sites"
    : "";
  elements.mobileFilterSummary.textContent =
    `${price} · ${state.selectedAreas.size} ${
      state.selectedAreas.size === 1 ? "area" : "areas"
    } · ${elements.hours.value}h${sourceSuffix}`;
}

function setMobileFiltersOpen(open) {
  document.querySelector(".filters").classList.toggle("is-open", open);
  elements.mobileFilterToggle.setAttribute("aria-expanded", String(open));
}

function renderAreas() {
  elements.areaChips.replaceChildren();

  AREAS.filter((area) => state.selectedAreas.has(area.id)).forEach((area) => {
    const chip = document.createElement("button");
    chip.className = "area-chip";
    chip.type = "button";
    chip.textContent = area.name;
    chip.setAttribute("aria-label", `Remove ${area.name}`);
    chip.addEventListener("click", () => {
      if (state.selectedAreas.size === 1) {
        showNotice("Keep at least one neighborhood in the search.");
        return;
      }
      state.selectedAreas.delete(area.id);
      renderAreas();
    });
    elements.areaChips.append(chip);
  });

  const previousValue = elements.addArea.value;
  elements.addArea.replaceChildren(new Option("Add neighborhood…", ""));
  AREAS.filter((area) => !state.selectedAreas.has(area.id)).forEach((area) => {
    elements.addArea.add(new Option(area.name, String(area.id)));
  });
  if (previousValue && !state.selectedAreas.has(Number(previousValue))) {
    elements.addArea.value = previousValue;
  }
  updateMobileFilterSummary();
}

function addSelectedArea() {
  const id = Number(elements.addArea.value);
  if (!id) return;
  state.selectedAreas.add(id);
  renderAreas();
}

function setLoading(loading) {
  state.loading = loading;
  const button = elements.filterForm.querySelector(".primary-button");
  button.disabled = loading;
  button.querySelector("span:first-child").textContent = loading
    ? "Scanning StreetEasy…"
    : "Scan new listings";
  elements.sync.classList.toggle("is-loading", loading);
  if (loading) {
    elements.sync.classList.remove("is-live");
    elements.syncLabel.textContent = "Scanning now";
    elements.listingGrid.innerHTML = Array.from(
      { length: 4 },
      () => '<div class="skeleton" aria-hidden="true"></div>',
    ).join("");
  }
}

function showNotice(message = "") {
  elements.notice.hidden = !message;
  elements.notice.textContent = message;
}

function buildSearchParams() {
  const formData = new FormData(elements.filterForm);
  const params = new URLSearchParams({
    areas: [...state.selectedAreas].join(","),
    hours: elements.hours.value,
  });

  ["minPrice", "maxPrice", "minBedrooms", "minBathrooms"].forEach((name) => {
    const value = formData.get(name);
    if (value !== null && String(value).trim() !== "") {
      params.set(name, String(value));
    }
  });

  if (document.querySelector("#no-fee").checked) {
    params.set("noFeeOnly", "true");
  }
  if (document.querySelector("#pets-allowed").checked) {
    params.set("petsAllowed", "true");
  }
  if (elements.includeSourceListings.checked) {
    params.set("includeSourceListings", "true");
  }

  const amenities = formData.getAll("amenity");
  if (amenities.length) params.set("amenities", amenities.join(","));
  params.set("avenueBSide", formData.get("avenueBSide") || "west");
  return params;
}

function formatAge(hours) {
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `Live ${minutes}m ago`;
  }
  if (hours < 24) return `Live ${Math.round(hours)}h ago`;
  const days = Math.floor(hours / 24);
  const remainingHours = Math.round(hours % 24);
  return `Live ${days}d ${remainingHours}h ago`;
}

function bedroomLabel(count) {
  if (count === null || count === undefined) return null;
  if (count === 0) return "Studio";
  return `${count} bed`;
}

function bathroomLabel(listing) {
  const count =
    Number(listing.fullBathroomCount || 0) +
    Number(listing.halfBathroomCount || 0) * 0.5;
  return count ? `${count} bath` : null;
}

function pointInPolygon(point, vertices) {
  let inside = false;
  for (
    let current = 0, previous = vertices.length - 1;
    current < vertices.length;
    previous = current, current += 1
  ) {
    const currentPoint = vertices[current];
    const previousPoint = vertices[previous];
    const crossesLatitude =
      currentPoint.latitude > point.latitude !==
      previousPoint.latitude > point.latitude;
    if (!crossesLatitude) continue;
    const edgeLongitude =
      ((previousPoint.longitude - currentPoint.longitude) *
        (point.latitude - currentPoint.latitude)) /
        (previousPoint.latitude - currentPoint.latitude) +
      currentPoint.longitude;
    if (point.longitude < edgeLongitude) inside = !inside;
  }
  return inside;
}

function renderTimeline(listings) {
  elements.timelineMarkers.replaceChildren();
  const windowHours = Number(elements.hours.value);
  elements.timelineLabels.replaceChildren(
    ...[0, 0.25, 0.5, 0.75, 1].map((fraction) =>
      makeTextElement(
        "span",
        fraction === 0 ? "Now" : `${Math.round(windowHours * fraction)}h`,
      ),
    ),
  );

  listings.forEach((listing, index) => {
    const marker = document.createElement("button");
    marker.className = "timeline-marker";
    marker.type = "button";
    marker.dataset.listingId = listing.id;
    marker.classList.toggle(
      "is-viewed",
      state.viewedListings.has(String(listing.id)),
    );
    marker.style.setProperty(
      "--position",
      `${Math.min(100, (listing.ageHours / windowHours) * 100)}%`,
    );
    marker.style.setProperty("--lane", `${20 + (index % 4) * 18}px`);
    marker.setAttribute(
      "aria-label",
      `${listing.street} ${listing.unit}, ${formatAge(listing.ageHours)}`,
    );
    marker.title =
      `${listing.street} ${listing.unit} · ${formatAge(listing.ageHours)}`;
    marker.addEventListener("click", () => {
      if (state.view === "map") {
        selectMapListing(listing.id, true);
        elements.mapView.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const card = document.querySelector(`[data-listing-id="${listing.id}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("is-highlighted");
      window.setTimeout(() => card.classList.remove("is-highlighted"), 1500);
    });
    elements.timelineMarkers.append(marker);
  });
}

function getSortedListings() {
  let visibleListings = state.listings.filter(
    (listing) => !state.hiddenListings.has(String(listing.id)),
  );
  if (!state.drawingPolygon && state.polygonPoints.length >= 3) {
    visibleListings = visibleListings.filter((listing) => {
      const latitude = Number(listing.geoPoint?.latitude);
      const longitude = Number(listing.geoPoint?.longitude);
      return (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        pointInPolygon({ latitude, longitude }, state.polygonPoints)
      );
    });
  }
  const listings = state.likedOnly
    ? visibleListings.filter((listing) =>
        state.likedListings.has(String(listing.id)),
      )
    : visibleListings;
  if (state.sort === "value") {
    return listings.sort(
      (left, right) =>
        right.valueScore - left.valueScore ||
        Date.parse(right.listedAt) - Date.parse(left.listedAt),
    );
  }
  if (state.sort === "price-asc") {
    return listings.sort((left, right) => left.price - right.price);
  }
  return listings.sort(
    (left, right) => Date.parse(right.listedAt) - Date.parse(left.listedAt),
  );
}

function makeTextElement(tagName, text) {
  const element = document.createElement(tagName);
  element.textContent = text;
  return element;
}

function updateViewedControls() {
  const count = state.viewedListings.size;
  elements.clearViewed.disabled = count === 0;
  elements.clearViewed.textContent =
    count === 0 ? "Clear viewed" : `Clear viewed (${count})`;
}

function updateLikedControls() {
  const count = state.likedListings.size;
  elements.likedOnly.disabled = count === 0 && !state.likedOnly;
  elements.likedOnly.textContent = `Liked (${count})`;
  elements.likedOnly.setAttribute("aria-pressed", String(state.likedOnly));
  elements.likedOnly.classList.toggle("is-active", state.likedOnly);
}

function updateHiddenControls() {
  const count = state.hiddenListings.size;
  elements.restoreHidden.disabled = count === 0;
  elements.restoreHidden.textContent =
    count === 0 ? "Restore hidden" : `Restore hidden (${count})`;
}

function polygonIsActive() {
  return !state.drawingPolygon && state.polygonPoints.length >= 3;
}

function updatePolygonControls(visibleCount = getSortedListings().length) {
  const active = polygonIsActive();
  const pointCount = state.polygonPoints.length;
  elements.drawPolygon.setAttribute(
    "aria-pressed",
    String(state.drawingPolygon),
  );
  elements.drawPolygon.textContent = state.drawingPolygon
    ? "Placing points…"
    : active
      ? "Redraw polygon"
      : "Draw polygon";
  elements.drawPolygon.disabled = state.drawingPolygon;
  elements.undoPolygon.disabled = !state.drawingPolygon || pointCount === 0;
  elements.finishPolygon.disabled =
    !state.drawingPolygon || pointCount < 3;
  elements.clearPolygon.disabled = pointCount === 0;
  elements.polygonStatus.hidden = !active;
  elements.polygonStatus.textContent = active
    ? `Polygon · ${visibleCount} result${visibleCount === 1 ? "" : "s"}`
    : "";
  elements.polygonInstruction.textContent = state.drawingPolygon
    ? `${pointCount} point${pointCount === 1 ? "" : "s"} placed. Add at least three, then finish.`
    : "Click Draw, then place at least three points.";
  elements.mapView.classList.toggle("is-drawing", state.drawingPolygon);
}

function updatePolygonShape() {
  if (!state.map) return;
  if (state.polygonShape) {
    state.polygonShape.remove();
    state.polygonShape = null;
  }
  if (state.polygonVertices) {
    state.polygonVertices.remove();
    state.polygonVertices = null;
  }
  if (!state.polygonPoints.length) return;

  const latLngs = state.polygonPoints.map((point) => [
    point.latitude,
    point.longitude,
  ]);
  const style = {
    color: "#1749c6",
    weight: 2,
    dashArray: state.drawingPolygon ? "6 5" : null,
    fillColor: "#1749c6",
    fillOpacity: state.drawingPolygon ? 0.06 : 0.13,
    interactive: false,
  };
  state.polygonShape =
    latLngs.length >= 3
      ? window.L.polygon(latLngs, style).addTo(state.map)
      : window.L.polyline(latLngs, style).addTo(state.map);

  if (state.drawingPolygon) {
    state.polygonVertices = window.L.layerGroup(
      latLngs.map((latLng) =>
        window.L.circleMarker(latLng, {
          radius: 5,
          color: "#ffffff",
          weight: 2,
          fillColor: "#1749c6",
          fillOpacity: 1,
          interactive: false,
        }),
      ),
    ).addTo(state.map);
  }
}

function startPolygonDrawing() {
  const hadActivePolygon = polygonIsActive();
  state.drawingPolygon = true;
  state.polygonPoints = [];
  state.mapListingSignature = "";
  updatePolygonShape();
  updatePolygonControls();
  if (hadActivePolygon) renderListings();
}

function undoPolygonPoint() {
  if (!state.drawingPolygon || !state.polygonPoints.length) return;
  state.polygonPoints.pop();
  updatePolygonShape();
  updatePolygonControls();
}

function finishPolygonDrawing() {
  if (!state.drawingPolygon || state.polygonPoints.length < 3) return;
  state.drawingPolygon = false;
  state.mapListingSignature = "";
  updatePolygonShape();
  renderListings();
}

function clearPolygon(render = true) {
  state.drawingPolygon = false;
  state.polygonPoints = [];
  state.mapListingSignature = "";
  updatePolygonShape();
  updatePolygonControls();
  if (render) renderListings();
}

function applyViewedState(card, listingId) {
  const viewed = state.viewedListings.has(String(listingId));
  card.classList.toggle("is-viewed", viewed);
  card.querySelector(".viewed-badge").hidden = !viewed;
}

function applyLikedState(card, listingId) {
  const liked = state.likedListings.has(String(listingId));
  const button = card.querySelector(".like-button");
  card.classList.toggle("is-liked", liked);
  button.setAttribute("aria-pressed", String(liked));
  button.setAttribute("aria-label", liked ? "Unlike listing" : "Like listing");
  button.querySelector("span").textContent = liked ? "♥" : "♡";
}

function markListingViewed(listingId, card) {
  const id = String(listingId);
  const wasViewed = state.viewedListings.has(id);
  state.viewedListings.add(id);
  saveStoredIds(VIEWED_STORAGE_KEY, state.viewedListings);
  if (!wasViewed) queueUserStateSave();
  applyViewedState(card, id);
  document
    .querySelector(`.timeline-marker[data-listing-id="${id}"]`)
    ?.classList.add("is-viewed");
  refreshMapMarker(id);
  updateViewedControls();
}

function clearViewedListings() {
  if (state.viewedListings.size === 0) return;
  state.viewedListings.clear();
  saveStoredIds(VIEWED_STORAGE_KEY, state.viewedListings);
  queueUserStateSave();
  renderListings();
}

function toggleListingLiked(listingId, card) {
  const id = String(listingId);
  const wasLiked = state.likedListings.has(id);
  if (wasLiked) {
    state.likedListings.delete(id);
  } else {
    state.likedListings.add(id);
  }
  saveStoredIds(LIKED_STORAGE_KEY, state.likedListings);
  queueUserStateSave();

  if (state.likedOnly && wasLiked) {
    renderListings();
    return;
  }
  applyLikedState(card, id);
  refreshMapMarker(id);
  updateLikedControls();
}

function toggleLikedOnly() {
  if (state.likedListings.size === 0 && !state.likedOnly) return;
  state.likedOnly = !state.likedOnly;
  renderListings();
}

function hideListing(listingId) {
  const id = String(listingId);
  state.hiddenListings.add(id);
  state.likedListings.delete(id);
  saveStoredIds(HIDDEN_STORAGE_KEY, state.hiddenListings);
  saveStoredIds(LIKED_STORAGE_KEY, state.likedListings);
  queueUserStateSave();
  renderListings();
}

function restoreHiddenListings() {
  if (state.hiddenListings.size === 0) return;
  state.hiddenListings.clear();
  saveStoredIds(HIDDEN_STORAGE_KEY, state.hiddenListings);
  queueUserStateSave();
  renderListings();
}

function closeListingViewer() {
  state.detailRequest?.abort();
  state.detailRequest = null;
  if (elements.listingViewer.open) elements.listingViewer.close();
  document.body.classList.remove("viewer-open");
}

function humanizeDetailLabel(value) {
  return String(value)
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function makeDetailChip(text, className = "") {
  const chip = makeTextElement("span", text);
  if (className) chip.className = className;
  return chip;
}

function renderDetailChips(container, values, emptyMessage) {
  container.replaceChildren();
  const uniqueValues = [...new Set(values.filter(Boolean))];
  if (!uniqueValues.length) {
    const empty = makeTextElement("p", emptyMessage);
    empty.className = "detail-muted";
    container.append(empty);
    return;
  }
  uniqueValues.forEach((value) =>
    container.append(makeDetailChip(humanizeDetailLabel(value))),
  );
}

function updateDetailPhoto() {
  const total = state.detailPhotos.length;
  if (!total) {
    elements.detailPhoto.removeAttribute("src");
    elements.detailPhoto.alt = "";
    elements.detailPhotoCount.textContent = "No photos";
    elements.detailPhotoPrevious.disabled = true;
    elements.detailPhotoNext.disabled = true;
    return;
  }

  const photo = state.detailPhotos[state.detailPhotoIndex];
  elements.detailPhoto.src = photo.url;
  elements.detailPhoto.alt =
    `${elements.listingViewerTitle.textContent}, photo ${
      state.detailPhotoIndex + 1
    } of ${total}`;
  elements.detailPhotoCount.textContent =
    `${state.detailPhotoIndex + 1} / ${total}${
      photo.type === "floor-plan" ? " · Floor plan" : ""
    }`;
  elements.detailPhotoPrevious.disabled = total < 2;
  elements.detailPhotoNext.disabled = total < 2;
  elements.detailThumbnails
    .querySelectorAll("button")
    .forEach((button, index) => {
      button.classList.toggle("is-active", index === state.detailPhotoIndex);
      button.setAttribute(
        "aria-current",
        index === state.detailPhotoIndex ? "true" : "false",
      );
    });
}

function moveDetailPhoto(direction) {
  if (state.detailPhotos.length < 2) return;
  state.detailPhotoIndex =
    (state.detailPhotoIndex + direction + state.detailPhotos.length) %
    state.detailPhotos.length;
  updateDetailPhoto();
}

function renderDetailGallery(details, listing) {
  state.detailPhotos = [
    ...(details.media?.photos || []).map((url) => ({ url, type: "photo" })),
    ...(details.media?.floorPlans || []).map((url) => ({
      url,
      type: "floor-plan",
    })),
  ];
  if (!state.detailPhotos.length && listing.imageUrl) {
    state.detailPhotos.push({ url: listing.imageUrl, type: "photo" });
  }
  state.detailPhotoIndex = 0;
  elements.detailThumbnails.replaceChildren();
  state.detailPhotos.forEach((photo, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(
      "aria-label",
      photo.type === "floor-plan"
        ? `View floor plan ${index + 1}`
        : `View photo ${index + 1}`,
    );
    const image = document.createElement("img");
    image.src = photo.url;
    image.alt = "";
    image.loading = "lazy";
    button.append(image);
    button.addEventListener("click", () => {
      state.detailPhotoIndex = index;
      updateDetailPhoto();
    });
    elements.detailThumbnails.append(button);
  });
  updateDetailPhoto();
}

function renderDetailFacts(details) {
  const property = details.property || {};
  const bathroomCount =
    Number(property.fullBathroomCount || 0) +
    Number(property.halfBathroomCount || 0) * 0.5;
  const facts = [
    property.bedroomCount === 0
      ? "Studio"
      : property.bedroomCount != null
        ? `${property.bedroomCount} bed`
        : null,
    bathroomCount ? `${bathroomCount} bath` : null,
    property.roomCount ? `${property.roomCount} rooms` : null,
    property.livingAreaSize
      ? `${Number(property.livingAreaSize).toLocaleString()} ft²`
      : null,
    details.availableAt
      ? `Available ${new Date(
          `${details.availableAt}T12:00:00`,
        ).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`
      : "Available now",
  ].filter(Boolean);
  elements.detailFacts.replaceChildren(
    ...facts.map((fact) => makeDetailChip(fact)),
  );
}

function renderDetailFlags(details) {
  const pricing = details.pricing || {};
  const belowMedian =
    pricing.price && details.neighborhoodMedian
      ? Math.round(
          ((details.neighborhoodMedian - pricing.price) /
            details.neighborhoodMedian) *
            100,
        )
      : null;
  const flags = [
    pricing.noFee ? "No fee" : null,
    pricing.monthsFree ? `${pricing.monthsFree} months free` : null,
    pricing.leaseTermMonths
      ? `${pricing.leaseTermMonths}-month lease`
      : null,
    belowMedian >= 5 ? `${belowMedian}% below neighborhood median` : null,
  ].filter(Boolean);
  elements.detailFlags.replaceChildren(
    ...flags.map((flag) => makeDetailChip(flag)),
  );
  elements.detailFlags.hidden = !flags.length;
}

function renderBuildingDetails(details) {
  const building = details.building;
  if (!building) {
    elements.detailBuildingName.textContent = "Building details";
    elements.detailBuildingStats.replaceChildren(
      makeTextElement("p", "Building information is not published."),
    );
    return;
  }

  elements.detailBuildingName.textContent =
    building.name || building.address?.street || "Building details";
  const petPolicy = building.petPolicy;
  const stats = [
    building.yearBuilt ? ["Built", building.yearBuilt] : null,
    building.residentialUnitCount
      ? ["Homes", building.residentialUnitCount]
      : null,
    building.type ? ["Type", humanizeDetailLabel(building.type)] : null,
    petPolicy?.dogsAllowed || petPolicy?.catsAllowed
      ? [
          "Pets",
          [
            petPolicy.dogsAllowed ? "Dogs" : null,
            petPolicy.catsAllowed ? "Cats" : null,
          ]
            .filter(Boolean)
            .join(" + "),
        ]
      : null,
  ].filter(Boolean);
  elements.detailBuildingStats.replaceChildren();
  if (!stats.length) {
    elements.detailBuildingStats.append(
      makeTextElement("p", "Building information is not published."),
    );
    return;
  }
  stats.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.append(makeTextElement("span", label), makeTextElement("strong", value));
    elements.detailBuildingStats.append(row);
  });
}

function renderTransit(details) {
  const stations = details.building?.transitStations || [];
  elements.detailTransit.replaceChildren();
  if (!stations.length) {
    const empty = makeTextElement("p", "Nearby subway data is not published.");
    empty.className = "detail-muted";
    elements.detailTransit.append(empty);
    return;
  }

  stations.slice(0, 5).forEach((station) => {
    const row = document.createElement("div");
    const name = document.createElement("div");
    name.append(
      makeTextElement("strong", station.name),
      makeTextElement(
        "small",
        `${Number(station.distance).toFixed(2)} mi`,
      ),
    );
    const routes = document.createElement("div");
    routes.className = "detail-routes";
    (station.routes || []).forEach((route) =>
      routes.append(makeDetailChip(route)),
    );
    row.append(name, routes);
    elements.detailTransit.append(row);
  });
}

function renderOpenHouses(details) {
  const openHouses = details.upcomingOpenHouses || [];
  elements.detailOpenHouses.replaceChildren();
  if (!openHouses.length) {
    const empty = makeTextElement("p", "No upcoming open houses are published.");
    empty.className = "detail-muted";
    elements.detailOpenHouses.append(empty);
    return;
  }

  openHouses.forEach((openHouse) => {
    const start = new Date(openHouse.startTime);
    const end = new Date(openHouse.endTime);
    const row = document.createElement("div");
    row.append(
      makeTextElement(
        "strong",
        start.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
      ),
      makeTextElement(
        "span",
        `${start.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })}–${end.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })}${openHouse.appointmentOnly ? " · Appointment only" : ""}`,
      ),
    );
    elements.detailOpenHouses.append(row);
  });
}

function renderListingDetails(details, listing) {
  const address = details.property?.address || {};
  const displayAddress =
    [address.street, address.unit].filter(Boolean).join(" ") ||
    `${listing.street} ${listing.unit}`.trim();
  elements.listingViewerTitle.textContent = displayAddress;
  elements.detailAddress.textContent = displayAddress;
  elements.detailArea.textContent =
    details.building?.areaName || listing.areaName;
  elements.detailCity.textContent = [
    address.city ? humanizeDetailLabel(address.city) : null,
    address.state,
    address.zipCode,
  ]
    .filter(Boolean)
    .join(" · ");
  elements.detailPrice.textContent =
    `${currency.format(details.pricing?.price || listing.price)}/mo`;
  elements.detailDescription.textContent =
    details.description || "No description was published for this rental.";

  renderDetailGallery(details, listing);
  renderDetailFacts(details);
  renderDetailFlags(details);
  renderDetailChips(
    elements.detailAmenities,
    [
      ...(details.property?.features || []),
      ...(details.property?.amenities || []),
      ...(details.building?.policies || []),
    ],
    "No additional amenities were published.",
  );
  renderBuildingDetails(details);
  renderTransit(details);
  renderOpenHouses(details);
}

async function openListingViewer(listing, card) {
  markListingViewed(listing.id, card);
  const address = `${listing.street} ${listing.unit}`.trim();
  elements.listingViewerTitle.textContent = address;
  elements.listingViewerExternal.href = listing.streetEasyUrl;
  elements.listingDetail.hidden = true;
  elements.listingDetailError.hidden = true;
  elements.listingDetailLoading.hidden = false;
  elements.listingDetailScroll.scrollTop = 0;
  document.body.classList.add("viewer-open");
  elements.listingViewer.showModal();

  state.detailRequest?.abort();
  const controller = new AbortController();
  state.detailRequest = controller;
  try {
    const response = await fetch(
      `/api/listings/${encodeURIComponent(listing.id)}`,
      { signal: controller.signal },
    );
    const details = await response.json();
    if (!response.ok) {
      throw new Error(details.error || "Listing details could not be loaded.");
    }
    renderListingDetails(details, listing);
    elements.listingDetailLoading.hidden = true;
    elements.listingDetail.hidden = false;
  } catch (error) {
    if (error.name === "AbortError") return;
    elements.listingDetailLoading.hidden = true;
    elements.listingDetailError.hidden = false;
    elements.listingDetailErrorMessage.textContent =
      error instanceof Error
        ? error.message
        : "Listing details could not be loaded.";
  } finally {
    if (state.detailRequest === controller) state.detailRequest = null;
  }
}

function createListingCard(listing, index) {
  const card = elements.listingTemplate.content
    .cloneNode(true)
    .querySelector(".listing-card");
  card.dataset.listingId = listing.id;
  const isSourceListing = listing.sourceOrigin === "broker_site";
  card.classList.toggle("is-source-listing", isSourceListing);
  applyViewedState(card, listing.id);
  applyLikedState(card, listing.id);
  card.querySelector(".listing-index").textContent = String(index + 1).padStart(
    2,
    "0",
  );

  const photo = card.querySelector(".listing-photo");
  if (listing.imageUrl) {
    photo.src = listing.imageUrl;
    photo.alt = `Interior of ${[listing.street, listing.unit]
      .filter(Boolean)
      .join(" ")}`;
  } else {
    card.querySelector(".listing-visual").classList.add("has-no-photo");
    photo.remove();
  }
  card.querySelector(".listed-age").textContent = isSourceListing
    ? "Source site"
    : formatAge(listing.ageHours);
  const sourceBadge = card.querySelector(".source-badge");
  if (isSourceListing) {
    sourceBadge.hidden = false;
    sourceBadge.textContent = listing.sourceLabel || "Broker source";
  }
  card.querySelector(".listing-address").textContent =
    `${listing.street} ${listing.unit}`.trim();
  card.querySelector(".listing-area").textContent = listing.areaName;
  card.querySelector(".listing-price").textContent =
    `${currency.format(listing.price)}/mo`;

  const netPrice = card.querySelector(".net-price");
  if (listing.netEffectivePrice && listing.netEffectivePrice !== listing.price) {
    netPrice.textContent =
      `${currency.format(listing.netEffectivePrice)} net effective`;
  }

  const facts = [
    bedroomLabel(listing.bedroomCount),
    bathroomLabel(listing),
    listing.livingAreaSize
      ? `${listing.livingAreaSize.toLocaleString()} ft²`
      : null,
    listing.availableAt
      ? `Available ${new Date(
          `${listing.availableAt}T12:00:00`,
        ).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : "Available now",
  ].filter(Boolean);
  const factsContainer = card.querySelector(".listing-facts");
  facts.forEach((fact) => factsContainer.append(makeTextElement("span", fact)));

  const flags = [
    ...(isSourceListing ? listing.flags || [] : []),
    listing.noFee ? "No fee" : null,
    listing.monthsFree ? `${listing.monthsFree} mo. free` : null,
    listing.hasTour3d ? "3D tour" : null,
    listing.hasVideos ? "Video" : null,
    listing.isNewDevelopment ? "New development" : null,
  ].filter(Boolean);
  const flagsContainer = card.querySelector(".listing-flags");
  flags.forEach((flag) => flagsContainer.append(makeTextElement("span", flag)));

  const valueBadge = card.querySelector(".value-badge");
  if (listing.percentBelowMedian >= 5) {
    valueBadge.hidden = false;
    valueBadge.textContent =
      `${listing.percentBelowMedian}% below local median`;
  }

  const link = card.querySelector(".listing-link");
  link.href = listing.sourceUrl || listing.streetEasyUrl;
  link.firstChild.textContent = isSourceListing ? "Open source " : "View details ";
  link.setAttribute(
    "aria-label",
    `${isSourceListing ? "Open source listing for" : "View details for"} ${
      listing.street
    } ${listing.unit}`,
  );
  link.addEventListener("click", (event) => {
    if (isSourceListing) {
      markListingViewed(listing.id, card);
      return;
    }
    event.preventDefault();
    openListingViewer(listing, card);
  });
  card
    .querySelector(".like-button")
    .addEventListener("click", () => toggleListingLiked(listing.id, card));
  card
    .querySelector(".hide-button")
    .addEventListener("click", () => hideListing(listing.id));
  return card;
}

function formatMapPrice(price) {
  if (price < 1000) return currency.format(price);
  const thousands = price / 1000;
  return `$${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

function createMapMarkerIcon(listing, selected = false) {
  const classes = ["map-price-marker"];
  if (state.viewedListings.has(String(listing.id))) classes.push("is-viewed");
  if (state.likedListings.has(String(listing.id))) classes.push("is-liked");
  if (listing.sourceOrigin === "broker_site") classes.push("is-source");
  if (selected) classes.push("is-selected");

  return window.L.divIcon({
    className: "listing-map-marker-wrapper",
    html: `<span class="${classes.join(" ")}">${formatMapPrice(listing.price)}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

function initializeMap() {
  if (state.map) return true;
  if (!window.L) {
    showNotice(
      "The map library could not load. Check the network connection and try Map again.",
    );
    return false;
  }

  state.map = window.L.map(elements.listingMap, {
    zoomControl: true,
    scrollWheelZoom: true,
  }).setView([40.7244, -73.987], 14);
  window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(state.map);
  state.mapLayer = window.L.layerGroup().addTo(state.map);
  state.map.on("click", (event) => {
    if (!state.drawingPolygon) return;
    state.polygonPoints.push({
      latitude: event.latlng.lat,
      longitude: event.latlng.lng,
    });
    updatePolygonShape();
    updatePolygonControls();
  });
  return true;
}

function refreshMapMarker(listingId) {
  if (!state.map) return;
  const id = String(listingId);
  const marker = state.mapMarkers.get(id);
  const listing = state.listings.find((item) => String(item.id) === id);
  if (!marker || !listing) return;
  marker.setIcon(
    createMapMarkerIcon(listing, state.selectedMapListingId === id),
  );
}

function selectMapListing(listingId, panToMarker = false) {
  const id = String(listingId);
  const listings = getSortedListings();
  const listing = listings.find((item) => String(item.id) === id);
  if (!listing) return;

  const previousId = state.selectedMapListingId;
  state.selectedMapListingId = id;
  refreshMapMarker(previousId);
  refreshMapMarker(id);

  const index = listings.findIndex((item) => String(item.id) === id);
  elements.mapSelection.replaceChildren(createListingCard(listing, index));
  if (panToMarker && state.mapMarkers.has(id)) {
    state.map.panTo(
      [listing.geoPoint.latitude, listing.geoPoint.longitude],
      { animate: true },
    );
  }
}

function renderMap(listings) {
  if (!initializeMap()) return;
  updatePolygonShape();
  state.mapLayer.clearLayers();
  state.mapMarkers.clear();

  const points = [];
  listings.forEach((listing) => {
    const latitude = Number(listing.geoPoint?.latitude);
    const longitude = Number(listing.geoPoint?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    points.push([latitude, longitude]);
    const id = String(listing.id);
    const marker = window.L.marker([latitude, longitude], {
      icon: createMapMarkerIcon(listing, state.selectedMapListingId === id),
      keyboard: true,
      riseOnHover: true,
      title: `${listing.street} ${listing.unit}, ${currency.format(listing.price)}${
        listing.sourceOrigin === "broker_site"
          ? `, ${listing.sourceLabel || "broker source"}`
          : ""
      }`,
    }).addTo(state.mapLayer);
    marker.on("click", () => selectMapListing(id));
    state.mapMarkers.set(id, marker);
  });

  const selectedIsVisible = listings.some(
    (listing) => String(listing.id) === state.selectedMapListingId,
  );
  if (!selectedIsVisible) {
    state.selectedMapListingId = listings[0]
      ? String(listings[0].id)
      : null;
  }

  if (state.selectedMapListingId) {
    selectMapListing(state.selectedMapListingId);
  } else {
    elements.mapSelection.replaceChildren();
  }

  const polygonSignature = state.polygonPoints
    .map((point) => `${point.latitude},${point.longitude}`)
    .join(";");
  const signature = `${polygonIsActive() ? polygonSignature : "none"}|${points
    .map((point) => point.join(","))
    .join("|")}`;
  const shouldFitBounds = signature !== state.mapListingSignature;
  state.mapListingSignature = signature;
  window.requestAnimationFrame(() => {
    state.map.invalidateSize();
    if (!shouldFitBounds) return;
    if (polygonIsActive() && state.polygonShape) {
      state.map.fitBounds(state.polygonShape.getBounds(), {
        paddingTopLeft: [32, 72],
        paddingBottomRight: [32, 210],
        maxZoom: 16,
      });
    } else if (points.length === 1) {
      state.map.setView(points[0], 15);
    } else if (points.length > 1) {
      state.map.fitBounds(points, {
        paddingTopLeft: [32, 32],
        paddingBottomRight: [32, 210],
        maxZoom: 15,
      });
    }
  });
}

function setResultsView(view) {
  if (view === "map" && !window.L) {
    showNotice(
      "The map library could not load. Check the network connection and try again.",
    );
    return;
  }
  if (view === "list" && state.drawingPolygon) clearPolygon(false);
  state.view = view;
  elements.listViewButton.classList.toggle("is-active", view === "list");
  elements.mapViewButton.classList.toggle("is-active", view === "map");
  elements.listViewButton.setAttribute("aria-pressed", String(view === "list"));
  elements.mapViewButton.setAttribute("aria-pressed", String(view === "map"));
  updatePolygonControls();
  renderListings();
}

function createEmptyState(hiddenMatchCount) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const mark = makeTextElement("span", "0");
  mark.className = "empty-mark";
  mark.setAttribute("aria-hidden", "true");
  empty.append(
    mark,
    makeTextElement(
      "h3",
      state.likedOnly
        ? "No liked matches"
        : polygonIsActive()
          ? "No matches in this polygon"
        : hiddenMatchCount > 0
          ? "Everything is hidden"
          : "No fresh matches",
    ),
    makeTextElement(
      "p",
      state.likedOnly
        ? "No liked apartments are present in this search. Turn off Liked to see every match."
        : polygonIsActive()
          ? "Redraw the polygon over another part of the map."
        : hiddenMatchCount > 0
          ? "No visible apartments remain in this search. Restore hidden listings to review them again."
          : "Widen the rent range, remove a must-have, or extend the freshness window.",
    ),
  );
  return empty;
}

function renderListings() {
  const listings = getSortedListings();
  const hiddenMatchCount = state.listings.filter((listing) =>
    state.hiddenListings.has(String(listing.id)),
  ).length;
  elements.listingGrid.replaceChildren();
  elements.resultCount.textContent = String(listings.length);
  elements.resultLabel.textContent =
    listings.length === 1
      ? state.likedOnly
        ? "liked rental"
        : "matching rental"
      : state.likedOnly
        ? "liked rentals"
        : "matching rentals";
  renderTimeline(listings);
  updateViewedControls();
  updateLikedControls();
  updateHiddenControls();
  updatePolygonControls(listings.length);

  if (state.view === "map") {
    elements.listingGrid.hidden = true;
    elements.mapView.hidden = false;
    renderMap(listings);
    if (!listings.length) {
      const message = createEmptyState(hiddenMatchCount);
      message.classList.add("map-empty-message");
      elements.mapSelection.replaceChildren(message);
    }
    return;
  }

  elements.mapView.hidden = true;
  elements.listingGrid.hidden = false;
  if (!listings.length) {
    elements.listingGrid.append(createEmptyState(hiddenMatchCount));
    return;
  }

  listings.forEach((listing, index) => {
    elements.listingGrid.append(createListingCard(listing, index));
  });
}

async function scanListings() {
  if (state.loading) return;
  setLoading(true);
  showNotice();

  try {
    const response = await fetch(`/api/listings?${buildSearchParams()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Listing scan failed.");

    state.listings = payload.listings;
    renderListings();
    elements.sync.classList.remove("is-loading");
    elements.sync.classList.add("is-live");
    const syncedAt = new Date(payload.generatedAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    elements.syncLabel.textContent = payload.cached
      ? `Cached scan · ${syncedAt}`
      : `Scanned · ${syncedAt}`;

    const notices = [];
    if (payload.sourceAgent) {
      const count = payload.sourceAgent.matchedListingCount || 0;
      const searched = payload.sourceAgent.searchedSeedCount || 0;
      const failures = payload.sourceAgent.errorCount || 0;
      if (count) {
        notices.push(
          `Broker-source agents added ${count} matching source-site ${
            count === 1 ? "rental" : "rentals"
          } from ${searched} StreetEasy ${searched === 1 ? "seed" : "seeds"}.`,
        );
      } else {
        notices.push(
          failures
            ? "Broker-source agents ran, but no supported source-site rentals matched this search."
            : "Broker-source agents found no matching source-site rentals.",
        );
      }
    }
    if (payload.truncated) {
      notices.push(
        "The search hit its safety limit before reaching the end of the selected time window. Narrow the criteria to guarantee a complete result set.",
      );
    }
    showNotice(notices.join(" "));
  } catch (error) {
    state.listings = [];
    renderListings();
    elements.sync.classList.remove("is-loading", "is-live");
    elements.syncLabel.textContent = "Scan unavailable";
    showNotice(
      error instanceof Error
        ? error.message
        : "The listing scan could not be completed.",
    );
  } finally {
    setLoading(false);
  }
}

function resetFilters() {
  state.selectedAreas = new Set(AREAS.map((area) => area.id));
  elements.filterForm.reset();
  document.querySelector("#min-price").value = "3000";
  document.querySelector("#max-price").value = "4500";
  elements.hours.value = "24";
  updateHours();
  renderAreas();
  showNotice();
  clearPolygon();
}

function updateHours() {
  const hours = elements.hours.value;
  elements.hoursOutput.textContent =
    `${hours} ${hours === "1" ? "hour" : "hours"}`;
  elements.heroHours.textContent = hours;
  updateMobileFilterSummary();
}

elements.addAreaButton.addEventListener("click", addSelectedArea);
elements.addArea.addEventListener("change", addSelectedArea);
elements.clearPolygon.addEventListener("click", () => clearPolygon());
elements.clearViewed.addEventListener("click", clearViewedListings);
elements.drawPolygon.addEventListener("click", startPolygonDrawing);
elements.finishPolygon.addEventListener("click", finishPolygonDrawing);
elements.likedOnly.addEventListener("click", toggleLikedOnly);
elements.listViewButton.addEventListener("click", () => setResultsView("list"));
elements.mapViewButton.addEventListener("click", () => setResultsView("map"));
elements.polygonStatus.addEventListener("click", () => clearPolygon());
elements.restoreHidden.addEventListener("click", restoreHiddenListings);
elements.undoPolygon.addEventListener("click", undoPolygonPoint);
elements.filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (mobileViewport.matches) {
    setMobileFiltersOpen(false);
    document
      .querySelector(".results")
      .scrollIntoView({ behavior: "smooth", block: "start" });
  }
  scanListings();
});
elements.filterForm.addEventListener("input", updateMobileFilterSummary);
elements.filterForm.addEventListener("change", updateMobileFilterSummary);
elements.hours.addEventListener("input", updateHours);
elements.mobileFilterToggle.addEventListener("click", () => {
  setMobileFiltersOpen(
    elements.mobileFilterToggle.getAttribute("aria-expanded") !== "true",
  );
});
elements.listingViewerClose.addEventListener("click", closeListingViewer);
elements.listingViewer.addEventListener("click", (event) => {
  if (event.target === elements.listingViewer) closeListingViewer();
});
elements.listingViewer.addEventListener("close", () => {
  state.detailRequest?.abort();
  state.detailRequest = null;
  document.body.classList.remove("viewer-open");
});
elements.detailPhotoPrevious.addEventListener("click", () =>
  moveDetailPhoto(-1),
);
elements.detailPhotoNext.addEventListener("click", () => moveDetailPhoto(1));
elements.resetFilters.addEventListener("click", resetFilters);
elements.sortOrder.addEventListener("change", () => {
  state.sort = elements.sortOrder.value;
  renderListings();
});

async function initializeApp() {
  renderAreas();
  updateHours();
  await hydrateUserState();
  updateViewedControls();
  updateLikedControls();
  updateHiddenControls();
  updatePolygonControls();
  scanListings();
}

initializeApp();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {
      // The dashboard remains fully usable when installation is unavailable.
    });
  });
}
