const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  buildFilterLiteral,
  buildFullDetailsQuery,
  extractLandlordSources,
  avenueBLongitudeAt,
  latestActiveAt,
  normalizeUserState,
  normalizeStreetSlug,
  parseManhattanSkylineUnits,
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

test("normalizes a street address into a landlord-site slug", () => {
  assert.equal(normalizeStreetSlug("117 Sullivan St."), "117-sullivan-street");
  assert.equal(normalizeStreetSlug("205 E. 66th St"), "205-east-66th-street");
});

test("normalizes Manhattan Skyline unit feed results", () => {
  const listings = parseManhattanSkylineUnits(
    {
      units: {
        data: [
          {
            number: "3C",
            slug: "ggtranqx",
            bedrooms: 1,
            bathrooms: 1,
            price: "4495.00",
            body: "<p>Spacious one-bedroom apartment.</p>",
            featured: "Yes",
            videos: "https://vimeo.com/example",
            url: "https://manhattanskyline.com/buildings/soho/117-sullivan-street/apartment-ggtranqx",
            building: {
              name: "117 Sullivan Street",
              address: { display_name: "Sullivan Mews, New York, NY 10012" },
            },
            card_images: [
              {
                card: "https://manhattanskyline.com/storage/example.jpg",
              },
            ],
          },
        ],
      },
    },
    "https://manhattanskyline.com/api/units?buildings=117-sullivan-street",
  );

  assert.equal(listings.length, 1);
  assert.equal(listings[0].source, "Manhattan Skyline");
  assert.equal(listings[0].unit, "#3C");
  assert.equal(listings[0].price, 4495);
  assert.deepEqual(listings[0].facts.slice(0, 2), ["1 bed", "1 bath"]);
  assert.ok(listings[0].flags.includes("Featured"));
  assert.equal(listings[0].description, "Spacious one-bedroom apartment.");
});

test("extracts pasted StreetEasy sources for batch scans", () => {
  const sources = extractLandlordSources(`
    Saved rentals
    https://streeteasy.com/building/117-sullivan-street-new_york/302
    https://streeteasy.com/building/117-sullivan-street-new_york/302,
    205 E 66th St
  `);

  assert.deepEqual(sources, [
    "https://streeteasy.com/building/117-sullivan-street-new_york/302",
    "205 E 66th St",
  ]);

  assert.deepEqual(extractLandlordSources(["117 Sullivan Street", "117 Sullivan Street"]), [
    "117 Sullivan Street",
  ]);
});
