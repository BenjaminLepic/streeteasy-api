const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFilterLiteral,
  buildFullDetailsQuery,
  avenueBLongitudeAt,
  latestActiveAt,
  parseSearchParams,
  passesAvenueBBoundary,
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
