const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  buildFilterLiteral,
  buildFullDetailsQuery,
  avenueBLongitudeAt,
  extractOpenAiOutputText,
  latestActiveAt,
  listingDetailsAgentSource,
  matchesLandlordListingCriteria,
  normalizeExternalAgentResult,
  normalizeLandlordListingForDashboard,
  normalizeUserState,
  parseSearchParams,
  passesAvenueBBoundary,
  readUserState,
  writeUserState,
} = require("./server");

test("parses the default downtown search criteria", () => {
  const criteria = parseSearchParams(new URLSearchParams());

  assert.equal(criteria.hours, 24);
  assert.equal(criteria.areas.length, 12);
  assert.equal(criteria.noFeeOnly, false);
  assert.equal(criteria.avenueBSide, "west");
  assert.equal(criteria.includeSourceListings, false);
});

test("parses the broker source scan toggle", () => {
  const criteria = parseSearchParams(
    new URLSearchParams({ includeSourceListings: "true" }),
  );

  assert.equal(criteria.includeSourceListings, true);
});

test("builds typed GraphQL filters without quoting enum values", () => {
  const criteria = parseSearchParams(
    new URLSearchParams({
      areas: "105,107",
      minPrice: "3000",
      maxPrice: "4500",
      minBedrooms: "1",
      petsAllowed: "true",
      amenities: "WASHER_DRYER,ELEVATOR",
    }),
  );
  const literal = buildFilterLiteral(criteria);

  assert.match(literal, /areas: \[105, 107\]/);
  assert.match(literal, /price: \{ lowerBound: 3000, upperBound: 4500 \}/);
  assert.match(literal, /rentalStatus: ACTIVE/);
  assert.match(literal, /amenities: \[WASHER_DRYER, ELEVATOR\]/);
});

test("builds the native rental detail query", () => {
  const query = buildFullDetailsQuery("5091098");

  assert.match(query, /rentalByListingId\(id: "5091098"\)/);
  assert.match(query, /description/);
  assert.match(query, /media \{/);
  assert.match(query, /propertyDetails \{/);
  assert.match(query, /buildingByRentalListingId/);
  assert.match(query, /transitStations/);
});

test("uses the latest ACTIVE transition as the public listing time", () => {
  const listedAt = latestActiveAt([
    { status: "DRAFT", changedAt: "2026-06-27T12:00:00-04:00" },
    { status: "ACTIVE", changedAt: "2026-06-28T12:00:00-04:00" },
    { status: "OFF_MARKET", changedAt: "2026-06-28T13:00:00-04:00" },
    { status: "ACTIVE", changedAt: "2026-06-29T12:00:00-04:00" },
  ]);

  assert.equal(listedAt, "2026-06-29T12:00:00-04:00");
});

test("rejects an inverted price range", () => {
  assert.throws(
    () =>
      parseSearchParams(
        new URLSearchParams({ minPrice: "5000", maxPrice: "4000" }),
      ),
    /Minimum rent cannot exceed maximum rent/,
  );
});

test("follows Avenue B's angled centerline", () => {
  assert.ok(Math.abs(avenueBLongitudeAt(40.725073) - -73.981211) < 0.000001);

  const westListing = {
    geoPoint: { latitude: 40.725073, longitude: -73.982 },
  };
  const eastListing = {
    geoPoint: { latitude: 40.725073, longitude: -73.9805 },
  };

  assert.equal(passesAvenueBBoundary(westListing, "west"), true);
  assert.equal(passesAvenueBBoundary(westListing, "east"), false);
  assert.equal(passesAvenueBBoundary(eastListing, "west"), false);
  assert.equal(passesAvenueBBoundary(eastListing, "east"), true);
  assert.equal(passesAvenueBBoundary(eastListing, "any"), true);
});

test("normalizes saved listing IDs", () => {
  const state = normalizeUserState({
    viewedListings: [5091098, "5091098"],
    likedListings: ["5091099"],
    hiddenListings: [],
  });

  assert.deepEqual(state.viewedListings, ["5091098"]);
  assert.deepEqual(state.likedListings, ["5091099"]);
  assert.throws(
    () =>
      normalizeUserState({
        viewedListings: ["not a valid id"],
        likedListings: [],
        hiddenListings: [],
      }),
    /invalid listing ID/,
  );
});

test("persists saved listing state across reads", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "first-look-state-"));
  const filePath = join(directory, "user-state.json");
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.equal(readUserState(filePath).initialized, false);

  const written = writeUserState(
    {
      viewedListings: ["5091098"],
      likedListings: ["5091099"],
      hiddenListings: ["5091100"],
    },
    filePath,
  );
  const stored = readUserState(filePath);

  assert.equal(written.initialized, true);
  assert.deepEqual(stored.viewedListings, ["5091098"]);
  assert.deepEqual(stored.likedListings, ["5091099"]);
  assert.deepEqual(stored.hiddenListings, ["5091100"]);
  assert.match(stored.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("extracts text from a Responses API message output", () => {
  const text = extractOpenAiOutputText({
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "{\"landlord\":\"Open Market Realty\",\"listings\":[]}",
          },
        ],
      },
    ],
  });

  assert.equal(text, "{\"landlord\":\"Open Market Realty\",\"listings\":[]}");
});

test("normalizes the generic source-site agent result shape", () => {
  const result = normalizeExternalAgentResult(
    {
      broker: "Open Market Realty",
      website: "https://example-broker.test",
      listings: [{ url: "https://example-broker.test/rentals/1" }],
    },
    { sourceGroupLabel: "StreetEasy source" },
  );

  assert.equal(result.landlord, "Open Market Realty");
  assert.equal(result.website, "https://example-broker.test");
  assert.equal(result.sourceUrl, "https://example-broker.test");
  assert.equal(result.listings.length, 1);
  assert.equal(result.agentSteps[0].agent, "Broker-site agent");
});

test("filters and normalizes generic source listings for the main map", () => {
  const criteria = parseSearchParams(
    new URLSearchParams({
      areas: "107",
      minPrice: "3000",
      maxPrice: "4500",
      minBedrooms: "1",
    }),
  );
  const seed = {
    id: "5091098",
    areaName: "Soho",
    buildingType: "RENTAL",
    street: "117 Sullivan Street",
    unit: "#3C",
    listedAt: "2026-07-09T10:00:00-04:00",
    ageHours: 2,
    neighborhoodMedian: 5000,
    streetEasyUrl: "https://streeteasy.com/rental/5091098",
    geoPoint: { latitude: 40.725, longitude: -74.002 },
  };
  const sourceListing = {
    source: "Open Market Realty",
    address: "117 Sullivan Street",
    unit: "#4D",
    price: "4200",
    bedrooms: 1,
    bathrooms: 1,
    squareFeet: 720,
    latitude: 40.726,
    longitude: -74.0024,
    availableOn: "2026-08-01",
    url: "https://example-broker.test/rentals/117-sullivan-4d",
  };

  assert.equal(
    matchesLandlordListingCriteria(sourceListing, seed, criteria),
    true,
  );
  assert.equal(
    matchesLandlordListingCriteria(
      { ...sourceListing, price: "5200" },
      seed,
      criteria,
    ),
    false,
  );
  assert.equal(
    matchesLandlordListingCriteria(
      { ...sourceListing, areaName: "Upper East Side" },
      seed,
      criteria,
    ),
    false,
  );

  const normalized = normalizeLandlordListingForDashboard(
    sourceListing,
    seed,
    criteria,
  );

  assert.match(normalized.id, /^broker_[a-f0-9]{18}$/);
  assert.equal(normalized.sourceOrigin, "broker_site");
  assert.equal(normalized.sourceLabel, "Open Market Realty");
  assert.equal(normalized.areaName, "Soho");
  assert.deepEqual(normalized.geoPoint, {
    latitude: 40.726,
    longitude: -74.0024,
  });
  assert.equal(normalized.price, 4200);
  assert.equal(normalized.bedroomCount, 1);
  assert.equal(normalized.fullBathroomCount, 1);
  assert.equal(normalized.availableAt, "2026-08-01");
  assert.equal(normalized.streetEasyUrl, sourceListing.url);
  assert.ok(normalized.flags.includes("Assumed off StreetEasy"));
});

test("builds a source-agent seed from First Look listing details", () => {
  assert.equal(
    listingDetailsAgentSource({
      property: {
        address: {
          street: "117 Sullivan Street",
          unit: "#3C",
        },
      },
    }),
    "117 Sullivan Street #3C",
  );

  assert.equal(
    listingDetailsAgentSource({
      property: { address: {} },
      building: { address: { street: "117 Sullivan Street" } },
    }),
    "117 Sullivan Street",
  );
});
