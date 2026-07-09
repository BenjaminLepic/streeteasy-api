const elements = {
  form: document.querySelector("#agent-form"),
  source: document.querySelector("#agent-source"),
  sync: document.querySelector("#agent-sync"),
  syncLabel: document.querySelector("#agent-sync-label"),
  notice: document.querySelector("#agent-notice"),
  resultCount: document.querySelector("#agent-result-count"),
  resultLabel: document.querySelector("#agent-result-label"),
  sourceLinks: document.querySelector("#agent-source-links"),
  summary: document.querySelector("#agent-summary"),
  steps: document.querySelector("#agent-steps"),
  listingGrid: document.querySelector("#agent-listing-grid"),
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function makeTextElement(tagName, text, className = "") {
  const element = document.createElement(tagName);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function makeLink(label, href) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function setLoading(loading) {
  elements.form.querySelector("button").disabled = loading;
  elements.source.disabled = loading;
  elements.sync.classList.toggle("is-loading", loading);
  if (loading) {
    elements.sync.classList.remove("is-live");
    elements.syncLabel.textContent = "Agents running";
  }
}

function showNotice(message = "") {
  elements.notice.hidden = !message;
  elements.notice.textContent = message;
}

function emptyState(title, message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const mark = makeTextElement("span", "0", "empty-mark");
  mark.setAttribute("aria-hidden", "true");
  empty.append(mark, makeTextElement("h3", title), makeTextElement("p", message));
  return empty;
}

function renderSteps(steps = []) {
  elements.steps.replaceChildren();
  steps.forEach((step) => {
    const item = document.createElement("li");
    item.className = `agent-step is-${step.status || "complete"}`;
    const heading = document.createElement("div");
    heading.append(
      makeTextElement("strong", step.agent || "Agent"),
      makeTextElement("span", step.status || "complete"),
    );
    item.append(heading, makeTextElement("p", step.detail || ""));
    if (step.url) item.append(makeLink("Source", step.url));
    elements.steps.append(item);
  });
}

function renderSummaryItems(items) {
  elements.summary.hidden = false;
  elements.summary.replaceChildren();

  items.forEach(([label, value]) => {
    const row = document.createElement("p");
    row.append(makeTextElement("span", label), makeTextElement("strong", value));
    elements.summary.append(row);
  });
}

function renderSummary(payload) {
  renderSummaryItems(
    [
      ["Landlord", payload.landlord],
      ["Address", payload.address],
      ["Generated", new Date(payload.generatedAt).toLocaleString()],
    ].filter(([, value]) => value),
  );

  elements.sourceLinks.replaceChildren();
  if (payload.streetEasyUrl) {
    elements.sourceLinks.append(makeLink("StreetEasy", payload.streetEasyUrl));
  }
  if (payload.buildingUrl) {
    elements.sourceLinks.append(makeLink("Landlord page", payload.buildingUrl));
  }
  if (payload.sourceUrl) {
    elements.sourceLinks.append(makeLink("Unit feed", payload.sourceUrl));
  }
}

function renderBatchSummary(payload) {
  renderSummaryItems([
    ["Inputs", String(payload.sourceCount || 0)],
    ["Resolved", String(payload.successCount || 0)],
    ["Generated", new Date(payload.generatedAt).toLocaleString()],
  ]);
  elements.sourceLinks.replaceChildren();
}

function formatPrice(price) {
  return Number.isFinite(Number(price)) ? `${currency.format(Number(price))}/mo` : "Price on request";
}

function truncateDescription(value = "") {
  return value.length > 260 ? `${value.slice(0, 260).trim()}...` : value;
}

function renderListing(listing, index) {
  const article = document.createElement("article");
  article.className = "agent-listing-card";

  const visual = document.createElement("div");
  visual.className = "agent-listing-visual";
  if (listing.imageUrl) {
    const image = document.createElement("img");
    image.src = listing.imageUrl;
    image.alt = `${listing.building || "Apartment"} ${listing.unit || ""}`.trim();
    image.loading = "lazy";
    visual.append(image);
  } else {
    visual.classList.add("has-no-photo");
  }
  visual.append(makeTextElement("span", String(index + 1).padStart(2, "0")));

  const main = document.createElement("div");
  main.className = "agent-listing-main";
  main.append(
    makeTextElement(
      "p",
      [listing.landlord || listing.source, listing.address].filter(Boolean).join(" / "),
      "section-kicker",
    ),
    makeTextElement(
      "h3",
      [listing.building, listing.unit].filter(Boolean).join(" "),
    ),
    makeTextElement("strong", formatPrice(listing.price), "agent-listing-price"),
  );

  const facts = document.createElement("div");
  facts.className = "listing-facts";
  (listing.facts || []).forEach((fact) => facts.append(makeTextElement("span", fact)));
  main.append(facts);

  const flags = document.createElement("div");
  flags.className = "listing-flags";
  (listing.flags || []).forEach((flag) => flags.append(makeTextElement("span", flag)));
  if (listing.flags?.length) main.append(flags);

  main.append(
    makeTextElement(
      "p",
      truncateDescription(listing.description || "No description was published."),
      "agent-listing-description",
    ),
  );

  const actions = document.createElement("div");
  actions.className = "agent-listing-actions";
  if (listing.url) actions.append(makeLink("Open listing", listing.url));
  if (listing.streetEasyUrl) actions.append(makeLink("StreetEasy", listing.streetEasyUrl));

  article.append(visual, main, actions);
  return article;
}

function renderPayload(payload) {
  const listings = payload.listings || [];
  elements.resultCount.textContent = String(listings.length);
  elements.resultLabel.textContent =
    listings.length === 1 ? "landlord listing" : "landlord listings";
  renderSummary(payload);
  renderSteps(payload.agentSteps || []);
  elements.listingGrid.replaceChildren();
  if (!listings.length) {
    elements.listingGrid.append(
      emptyState(
        "No source listings found",
        "The landlord was identified, but no active units were returned by the landlord site.",
      ),
    );
    return;
  }
  listings.forEach((listing, index) => {
    elements.listingGrid.append(renderListing(listing, index));
  });
}

function renderBatchPayload(payload) {
  const listings = payload.listings || [];
  elements.resultCount.textContent = String(listings.length);
  elements.resultLabel.textContent =
    listings.length === 1 ? "landlord listing" : "landlord listings";
  renderBatchSummary(payload);
  renderSteps(
    (payload.sources || []).map((item) => ({
      agent: item.ok ? item.result.landlord : "Listing scout",
      status: item.ok ? "complete" : "partial",
      detail: item.ok
        ? `${item.result.listings.length} source listing${
            item.result.listings.length === 1 ? "" : "s"
          } found for ${item.source}`
        : `${item.source}: ${item.error}`,
      url: item.ok ? item.result.streetEasyUrl : null,
    })),
  );

  elements.listingGrid.replaceChildren();
  if (!listings.length) {
    elements.listingGrid.append(
      emptyState(
        "No source listings found",
        payload.errorCount
          ? "The scan ran, but none of the resolved landlords returned active units."
          : "The landlords were identified, but no active units were returned by source sites.",
      ),
    );
    return;
  }
  listings.forEach((listing, index) => {
    elements.listingGrid.append(renderListing(listing, index));
  });
}

async function runAgent(event) {
  event.preventDefault();
  const source = elements.source.value.trim();
  if (!source) {
    showNotice("Enter a StreetEasy listing URL or address.");
    return;
  }

  setLoading(true);
  showNotice();
  try {
    const response = await fetch("/api/landlord-listings/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: source }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "The landlord agent could not finish.");
    }
    renderBatchPayload(payload);
    const generatedAt = new Date(payload.generatedAt).toLocaleTimeString(
      "en-US",
      { hour: "numeric", minute: "2-digit" },
    );
    elements.sync.classList.add("is-live");
    elements.syncLabel.textContent = `Scanned ${payload.sourceCount} / ${generatedAt}`;
  } catch (error) {
    elements.resultCount.textContent = "0";
    elements.resultLabel.textContent = "landlord listings";
    elements.summary.hidden = true;
    elements.sourceLinks.replaceChildren();
    renderSteps([]);
    elements.listingGrid.replaceChildren(
      emptyState(
        "Agent stopped",
        error instanceof Error
          ? error.message
          : "The landlord agent could not complete the search.",
      ),
    );
    elements.sync.classList.remove("is-live");
    elements.syncLabel.textContent = "Agent stopped";
    showNotice(error instanceof Error ? error.message : "Agent search failed.");
  } finally {
    setLoading(false);
  }
}

elements.form.addEventListener("submit", runAgent);

const params = new URLSearchParams(window.location.search);
if (params.get("source")) {
  elements.source.value = params.get("source");
  elements.form.requestSubmit();
}
