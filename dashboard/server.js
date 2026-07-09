const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  createHmac,
  randomUUID,
  timingSafeEqual,
} = require("node:crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const AUTH_ENABLED = Boolean(ACCESS_PASSWORD || ACCESS_TOKEN);
const AUTH_SECRET =
  process.env.AUTH_SECRET || ACCESS_PASSWORD || ACCESS_TOKEN;
const PUBLIC_DIR = path.join(__dirname, "public");
const APP_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(PUBLIC_DIR, "manifest.webmanifest"), "utf8"),
);
const USER_STATE_FILE =
  process.env.USER_STATE_FILE ||
  path.join(process.cwd(), ".first-look-data", "user-state.json");
const MAX_STORED_LISTINGS = 5_000;
const STREETEASY_API = "https://api-v6.streeteasy.com/";
const DEFAULT_AREAS = [
  105, 106, 107, 108, 110, 112, 115, 116, 117, 146, 157, 162,
];
const ALLOWED_AMENITIES = new Set([
  "WASHER_DRYER",
  "DISHWASHER",
  "PRIVATE_OUTDOOR_SPACE",
  "CENTRAL_AC",
  "DOORMAN",
  "LAUNDRY",
  "ELEVATOR",
  "GYM",
]);
const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 5;
const CACHE_TTL_MS = 60_000;
const LANDLORD_CACHE_TTL_MS = 5 * 60_000;
const AGENT_REQUEST_TIMEOUT_MS = 20_000;
const cache = new Map();
const detailsCache = new Map();
const landlordAgentCache = new Map();

// Avenue B centerline, south to north, derived from OpenStreetMap road geometry.
// A small tolerance keeps buildings whose map pin falls just off the centerline
// classified as "on Avenue B" rather than east of it.
const AVENUE_B_CENTERLINE = [
  { latitude: 40.7214151, longitude: -73.9838696 },
  { latitude: 40.722671, longitude: -73.982964 },
  { latitude: 40.723882, longitude: -73.982083 },
  { latitude: 40.725073, longitude: -73.981211 },
  { latitude: 40.7263302, longitude: -73.9802965 },
  { latitude: 40.7275208, longitude: -73.9794301 },
  { latitude: 40.728746, longitude: -73.978536 },
  { latitude: 40.7294404, longitude: -73.9780286 },
];
const AVENUE_B_BUILDING_TOLERANCE = 0.00025;

class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

class AgentError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "AgentError";
    this.status = status;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function authToken() {
  return createHmac("sha256", AUTH_SECRET)
    .update("first-look-access-v1")
    .digest("base64url");
}

function hasValidSession(request) {
  if (!AUTH_ENABLED) return true;
  const cookie = request.headers.cookie || "";
  const session = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("first_look_session="))
    ?.slice("first_look_session=".length);
  return Boolean(session && safeEqual(session, authToken()));
}

function sessionCookie(request) {
  const forwardedProtocol = String(
    request.headers["x-forwarded-proto"] || "",
  ).split(",")[0];
  const secure =
    forwardedProtocol === "https" || Boolean(request.socket.encrypted);
  return [
    `first_look_session=${authToken()}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=31536000",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function normalizeStoredIds(value, key) {
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`);
  }

  const ids = [...new Set(value.map((id) => String(id).trim()))];
  if (ids.length > MAX_STORED_LISTINGS) {
    throw new Error(
      `${key} cannot contain more than ${MAX_STORED_LISTINGS} IDs.`,
    );
  }
  if (ids.some((id) => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) {
    throw new Error(`${key} contains an invalid listing ID.`);
  }
  return ids;
}

function normalizeUserState(value, initialized = true) {
  const source = value && typeof value === "object" ? value : {};
  return {
    initialized,
    viewedListings: normalizeStoredIds(
      source.viewedListings || [],
      "viewedListings",
    ),
    likedListings: normalizeStoredIds(
      source.likedListings || [],
      "likedListings",
    ),
    hiddenListings: normalizeStoredIds(
      source.hiddenListings || [],
      "hiddenListings",
    ),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

function readUserState(filePath = USER_STATE_FILE) {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeUserState(stored);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return normalizeUserState({}, false);
    }
    throw error;
  }
}

function writeUserState(value, filePath = USER_STATE_FILE) {
  const stored = {
    ...normalizeUserState(value),
    initialized: true,
    updatedAt: new Date().toISOString(),
  };
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
  return stored;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error("Request is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid request."));
      }
    });
    request.on("error", reject);
  });
}

function parseOptionalNumber(
  params,
  name,
  { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {},
) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return null;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number.`);
  }
  return value;
}

function parseBoolean(params, name) {
  return params.get(name) === "true";
}

function parseAvenueBSide(params) {
  const value = params.get("avenueBSide") || "west";
  if (!["any", "west", "east"].includes(value)) {
    throw new Error("avenueBSide must be any, west, or east.");
  }
  return value;
}

function parseSearchParams(params) {
  const areaSource = params.get("areas");
  const areas = (areaSource ? areaSource.split(",") : DEFAULT_AREAS)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!areas.length || areas.length > 25) {
    throw new Error("Choose between 1 and 25 neighborhoods.");
  }

  const amenities = (params.get("amenities") || "")
    .split(",")
    .filter(Boolean);
  const invalidAmenity = amenities.find(
    (amenity) => !ALLOWED_AMENITIES.has(amenity),
  );
  if (invalidAmenity) {
    throw new Error(`Unsupported amenity: ${invalidAmenity}`);
  }

  const criteria = {
    areas: [...new Set(areas)],
    hours:
      parseOptionalNumber(params, "hours", {
        min: 1,
        max: 168,
        integer: true,
      }) ?? 24,
    minPrice: parseOptionalNumber(params, "minPrice", { min: 0, max: 100_000 }),
    maxPrice: parseOptionalNumber(params, "maxPrice", { min: 0, max: 100_000 }),
    minBedrooms: parseOptionalNumber(params, "minBedrooms", {
      min: 0,
      max: 20,
    }),
    maxBedrooms: parseOptionalNumber(params, "maxBedrooms", {
      min: 0,
      max: 20,
    }),
    minBathrooms: parseOptionalNumber(params, "minBathrooms", {
      min: 0,
      max: 20,
    }),
    petsAllowed: parseBoolean(params, "petsAllowed"),
    noFeeOnly: parseBoolean(params, "noFeeOnly"),
    avenueBSide: parseAvenueBSide(params),
    amenities,
  };

  if (
    criteria.minPrice !== null &&
    criteria.maxPrice !== null &&
    criteria.minPrice > criteria.maxPrice
  ) {
    throw new Error("Minimum rent cannot exceed maximum rent.");
  }
  if (
    criteria.minBedrooms !== null &&
    criteria.maxBedrooms !== null &&
    criteria.minBedrooms > criteria.maxBedrooms
  ) {
    throw new Error("Minimum bedrooms cannot exceed maximum bedrooms.");
  }

  return criteria;
}

function graphQLRange(lowerBound, upperBound) {
  return `{ lowerBound: ${lowerBound ?? "null"}, upperBound: ${upperBound ?? "null"} }`;
}

function buildFilterLiteral(criteria) {
  const filters = [
    `areas: [${criteria.areas.join(", ")}]`,
    "rentalStatus: ACTIVE",
  ];

  if (criteria.minPrice !== null || criteria.maxPrice !== null) {
    filters.push(
      `price: ${graphQLRange(criteria.minPrice, criteria.maxPrice)}`,
    );
  }
  if (criteria.minBedrooms !== null || criteria.maxBedrooms !== null) {
    filters.push(
      `bedrooms: ${graphQLRange(criteria.minBedrooms, criteria.maxBedrooms)}`,
    );
  }
  if (criteria.minBathrooms !== null) {
    filters.push(`bathrooms: ${graphQLRange(criteria.minBathrooms, null)}`);
  }
  if (criteria.petsAllowed) filters.push("petsAllowed: true");
  if (criteria.amenities.length) {
    filters.push(`amenities: [${criteria.amenities.join(", ")}]`);
  }

  return `{ ${filters.join(", ")} }`;
}

function buildSearchQuery(criteria, page = 1) {
  const nodeFields = `
    id
    areaName
    availableAt
    bedroomCount
    buildingType
    fullBathroomCount
    halfBathroomCount
    furnished
    hasTour3d
    hasVideos
    isNewDevelopment
    geoPoint { latitude longitude }
    leadMedia { photo { key } floorPlan { key } }
    leaseTermMonths
    livingAreaSize
    mediaAssetCount
    monthsFree
    noFee
    netEffectivePrice
    price
    sourceGroupLabel
    status
    street
    unit
    urlPath
  `;

  return `
    query DashboardSearch {
      searchRentals(input: {
        sorting: { attribute: LISTED_AT, direction: DESCENDING }
        filters: ${buildFilterLiteral(criteria)}
        adStrategy: NONE
        userSearchToken: ${JSON.stringify(randomUUID())}
        perPage: ${SEARCH_PAGE_SIZE}
        page: ${page}
      }) {
        totalCount
        edges {
          __typename
          ... on OrganicRentalEdge { node { ${nodeFields} } }
          ... on FeaturedRentalEdge { node { ${nodeFields} } }
          ... on SponsoredRentalEdge { node { ${nodeFields} } }
        }
      }
    }
  `;
}

function buildDetailsQuery(ids) {
  const fields = ids.map(
    (id, index) => `
      listing${index}: rentalByListingId(id: ${JSON.stringify(id)}) {
        id
        createdAt
        status
        statusChanges { status changedAt }
        recentListingsPriceStats {
          rentalPriceStats { medianPrice }
        }
      }
    `,
  );

  return `query DashboardListingTimes { ${fields.join("\n")} }`;
}

function buildFullDetailsQuery(id) {
  return `
    query DashboardRentalDetails {
      rentalByListingId(id: ${JSON.stringify(id)}) {
        id
        availableAt
        status
        description
        media {
          photos { key }
          floorPlans { key }
          videos { imageUrl id provider }
          tour3dUrl
          assetCount
        }
        propertyDetails {
          address {
            street
            city
            state
            zipCode
            unit
          }
          roomCount
          bedroomCount
          fullBathroomCount
          halfBathroomCount
          livingAreaSize
          amenities {
            list
            doormanTypes
            parkingTypes
            sharedOutdoorSpaceTypes
            storageSpaceTypes
          }
          features {
            list
            fireplaceTypes
            privateOutdoorSpaceTypes
            views
          }
        }
        pricing {
          leaseTermMonths
          monthsFree
          noFee
          price
          priceDelta
          priceChanges { changedAt }
        }
        recentListingsPriceStats {
          rentalPriceStats { medianPrice }
        }
        upcomingOpenHouses {
          id
          startTime
          endTime
          appointmentOnly
        }
        listingSource { sourceType }
      }
      buildingByRentalListingId(id: ${JSON.stringify(id)}) {
        id
        name
        type
        residentialUnitCount
        yearBuilt
        status
        address {
          street
          city
          state
          zipCode
        }
        area { name }
        policies {
          list
          petPolicy {
            catsAllowed
            dogsAllowed
            maxDogWeight
            restrictedDogBreeds
          }
        }
        nearby {
          transitStations {
            name
            distance
            routes
          }
        }
      }
    }
  `;
}

function mediaUrl(key) {
  return key
    ? `https://photos.zillowstatic.com/fp/${key}-cc_ft_768.webp`
    : null;
}

function flattenDetailLabels(details) {
  return [
    ...(details?.list || []),
    ...(details?.doormanTypes || []),
    ...(details?.parkingTypes || []),
    ...(details?.sharedOutdoorSpaceTypes || []),
    ...(details?.storageSpaceTypes || []),
    ...(details?.fireplaceTypes || []),
    ...(details?.privateOutdoorSpaceTypes || []),
    ...(details?.views || []),
  ].filter(Boolean);
}

async function findListingDetails(id) {
  const cached = detailsCache.get(id);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  const data = await streetEasyRequest(buildFullDetailsQuery(id));
  const listing = data.rentalByListingId;
  if (!listing) throw new Error("Listing details were not found.");

  const property = listing.propertyDetails || {};
  const building = data.buildingByRentalListingId;
  const value = {
    id: String(listing.id),
    availableAt: listing.availableAt,
    status: listing.status,
    description: listing.description || "",
    media: {
      photos: (listing.media?.photos || [])
        .map((photo) => mediaUrl(photo.key))
        .filter(Boolean),
      floorPlans: (listing.media?.floorPlans || [])
        .map((floorPlan) => mediaUrl(floorPlan.key))
        .filter(Boolean),
      videos: listing.media?.videos || [],
      tour3dUrl: listing.media?.tour3dUrl || null,
    },
    property: {
      address: property.address || null,
      roomCount: property.roomCount ?? null,
      bedroomCount: property.bedroomCount ?? null,
      fullBathroomCount: property.fullBathroomCount ?? null,
      halfBathroomCount: property.halfBathroomCount ?? null,
      livingAreaSize: property.livingAreaSize ?? null,
      amenities: flattenDetailLabels(property.amenities),
      features: flattenDetailLabels(property.features),
    },
    pricing: listing.pricing || null,
    neighborhoodMedian:
      listing.recentListingsPriceStats?.rentalPriceStats?.medianPrice ?? null,
    upcomingOpenHouses: listing.upcomingOpenHouses || [],
    sourceType: listing.listingSource?.sourceType || null,
    building: building
      ? {
          id: String(building.id),
          name: building.name,
          type: building.type,
          residentialUnitCount: building.residentialUnitCount ?? null,
          yearBuilt: building.yearBuilt ?? null,
          status: building.status,
          address: building.address || null,
          areaName: building.area?.name || null,
          policies: building.policies?.list || [],
          petPolicy: building.policies?.petPolicy || null,
          transitStations: building.nearby?.transitStations || [],
        }
      : null,
    generatedAt: new Date().toISOString(),
    cached: false,
  };

  detailsCache.set(id, { savedAt: Date.now(), value });
  return value;
}

async function streetEasyRequest(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(STREETEASY_API, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Apollographql-Client-Name": "srp-frontend-service",
        "Apollographql-Client-Version":
          "version 50bef71ef923e981bdcb7c781851c3bfdb12a0c1",
        "App-Version": "1.0.0",
        "Content-Type": "application/json",
        Origin: "https://streeteasy.com",
        Os: "web",
        Referer: "https://streeteasy.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ query }),
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new UpstreamError(
        "StreetEasy temporarily rejected the automated request. Wait a few minutes, then refresh.",
        503,
      );
    }

    const payload = await response.json();
    if (!response.ok || payload.errors) {
      const message =
        payload.errors?.map((error) => error.message).join("; ") ||
        `StreetEasy returned HTTP ${response.status}.`;
      throw new UpstreamError(message, response.status >= 500 ? 502 : 503);
    }

    return payload.data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new UpstreamError(
        "StreetEasy did not respond within 20 seconds.",
        504,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function latestActiveAt(statusChanges = []) {
  return (
    statusChanges
      .filter((change) => change.status === "ACTIVE" && change.changedAt)
      .map((change) => change.changedAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
  );
}

function avenueBLongitudeAt(latitude) {
  let start = AVENUE_B_CENTERLINE[0];
  let end = AVENUE_B_CENTERLINE[1];

  if (latitude >= AVENUE_B_CENTERLINE.at(-1).latitude) {
    start = AVENUE_B_CENTERLINE.at(-2);
    end = AVENUE_B_CENTERLINE.at(-1);
  } else if (latitude > AVENUE_B_CENTERLINE[0].latitude) {
    for (let index = 1; index < AVENUE_B_CENTERLINE.length; index += 1) {
      if (latitude <= AVENUE_B_CENTERLINE[index].latitude) {
        start = AVENUE_B_CENTERLINE[index - 1];
        end = AVENUE_B_CENTERLINE[index];
        break;
      }
    }
  }

  const progress =
    (latitude - start.latitude) / (end.latitude - start.latitude);
  return (
    start.longitude + progress * (end.longitude - start.longitude)
  );
}

function passesAvenueBBoundary(listing, side) {
  if (side === "any") return true;

  const latitude = listing.geoPoint?.latitude;
  const longitude = listing.geoPoint?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return true;

  const boundaryLongitude = avenueBLongitudeAt(latitude);
  const isStrictlyEast =
    longitude > boundaryLongitude + AVENUE_B_BUILDING_TOLERANCE;
  return side === "east" ? isStrictlyEast : !isStrictlyEast;
}

async function fetchDetails(ids) {
  if (!ids.length) return new Map();
  const data = await streetEasyRequest(buildDetailsQuery(ids));
  const details = new Map();

  ids.forEach((id, index) => {
    const detail = data[`listing${index}`];
    if (detail) details.set(id, detail);
  });
  return details;
}

function decorateListing(listing, detail, now, hours) {
  const listedAt = latestActiveAt(detail?.statusChanges);
  if (!listedAt) return null;

  const ageHours = Math.max(0, (now - Date.parse(listedAt)) / 3_600_000);
  const neighborhoodMedian =
    detail?.recentListingsPriceStats?.rentalPriceStats?.medianPrice ?? null;
  const percentBelowMedian =
    neighborhoodMedian && listing.price
      ? Math.round(
          ((neighborhoodMedian - listing.price) / neighborhoodMedian) * 100,
        )
      : null;
  const valueScore = Math.round(
    clamp(percentBelowMedian ?? 0, -20, 30) * 2 +
      (listing.noFee ? 14 : 0) +
      (listing.monthsFree ? 8 : 0) +
      (listing.livingAreaSize ? 4 : 0),
  );

  return {
    ...listing,
    listedAt,
    createdAt: detail?.createdAt ?? null,
    ageHours,
    neighborhoodMedian,
    percentBelowMedian,
    valueScore,
    windowHours: hours,
    streetEasyUrl: `https://streeteasy.com${listing.urlPath}`,
    imageUrl: mediaUrl(listing.leadMedia?.photo?.key),
  };
}

async function findRecentListings(criteria) {
  const sourceCriteria = {
    ...criteria,
    noFeeOnly: false,
    avenueBSide: "any",
  };
  const cacheKey = JSON.stringify(sourceCriteria);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return applyLocalFilters(cached.value, criteria, true);
  }

  const now = Date.now();
  const cutoff = now - criteria.hours * 3_600_000;
  const listingsById = new Map();
  let totalMatching = 0;
  let searchedPages = 0;
  let reachedCutoff = false;

  for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
    const searchData = await streetEasyRequest(buildSearchQuery(criteria, page));
    const search = searchData.searchRentals;
    const nodes = search.edges.map((edge) => edge.node).filter(Boolean);
    totalMatching = search.totalCount;
    searchedPages = page;

    if (!nodes.length) {
      reachedCutoff = true;
      break;
    }

    const details = await fetchDetails(nodes.map((node) => node.id));
    const decorated = nodes
      .map((node) =>
        decorateListing(node, details.get(node.id), now, criteria.hours),
      )
      .filter(Boolean);

    decorated.forEach((listing) => {
      if (Date.parse(listing.listedAt) >= cutoff) {
        listingsById.set(listing.id, listing);
      }
    });

    const oldestOnPage = Math.min(
      ...decorated.map((listing) => Date.parse(listing.listedAt)),
    );
    if (
      nodes.length < SEARCH_PAGE_SIZE ||
      (Number.isFinite(oldestOnPage) && oldestOnPage < cutoff)
    ) {
      reachedCutoff = true;
      break;
    }
  }

  const sourceValue = {
    generatedAt: new Date(now).toISOString(),
    cutoff: new Date(cutoff).toISOString(),
    criteria: sourceCriteria,
    listings: [...listingsById.values()].sort(
      (left, right) => Date.parse(right.listedAt) - Date.parse(left.listedAt),
    ),
    totalMatching,
    searchedPages,
    truncated: !reachedCutoff,
  };

  cache.set(cacheKey, { savedAt: Date.now(), value: sourceValue });
  return applyLocalFilters(sourceValue, criteria, false);
}

function applyLocalFilters(sourceValue, criteria, cached) {
  return {
    ...sourceValue,
    criteria,
    listings: sourceValue.listings.filter(
      (listing) =>
        (!criteria.noFeeOnly || listing.noFee) &&
        passesAvenueBBoundary(listing, criteria.avenueBSide),
    ),
    cached,
  };
}

function decodeHtml(value = "") {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(value = "") {
  return decodeHtml(
    String(value)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function makeAbsoluteUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

function normalizeStreetSlug(value = "") {
  const normalized = String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/#/g, " ")
    .replace(/\b(street|st)\b/g, "street")
    .replace(/\b(avenue|ave)\b/g, "avenue")
    .replace(/\b(east|e)\b/g, "east")
    .replace(/\b(west|w)\b/g, "west")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || null;
}

function parseStreetAddressFromInput(value = "") {
  const input = String(value);
  const match = input.match(
    /\b(\d{1,5})\s+([A-Za-z][A-Za-z\s'.-]*?)\s+(street|st|avenue|ave|road|rd|place|pl|boulevard|blvd)\b/i,
  );
  if (!match) return null;
  return `${match[1]} ${match[2].trim()} ${match[3]}`;
}

function parseStreetAddressFromSlug(value = "") {
  const source = String(value)
    .toLowerCase()
    .replace(/[_-]new[_-]york.*/i, "")
    .replace(/[_-]+/g, " ");
  return parseStreetAddressFromInput(source);
}

function streetEasyUrlFromInput(value = "") {
  const input = String(value).trim();
  try {
    const url = new URL(input);
    if (url.hostname.endsWith("streeteasy.com")) return url.href;
  } catch {
    // Plain-text search input is allowed.
  }

  const urlMatch = input.match(/https?:\/\/(?:www\.)?streeteasy\.com\/[^\s]+/i);
  return urlMatch ? urlMatch[0] : null;
}

function inferKnownStreetEasyUrl(input = "") {
  const source = String(input).toLowerCase();
  if (/\b117\s+sullivan\b/.test(source)) {
    return "https://streeteasy.com/building/117-sullivan-street-new_york/302";
  }
  return null;
}

async function fetchAgentText(url, { accept = "text/html,*/*" } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: accept,
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://streeteasy.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AgentError(
        `${new URL(url).hostname} returned HTTP ${response.status}.`,
        response.status >= 500 ? 502 : response.status,
      );
    }
    return text;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AgentError(`${new URL(url).hostname} did not respond in time.`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAgentJson(url) {
  const text = await fetchAgentText(url, { accept: "application/json,*/*" });
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentError(`${new URL(url).hostname} returned invalid JSON.`);
  }
}

function extractPageTitle(html = "") {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? stripHtml(title) : null;
}

function extractMetaContent(html = "", name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${escapedName}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escapedName}["'][^>]*>`,
      "i",
    ),
  ];
  const match = regexes.map((regex) => html.match(regex)).find(Boolean);
  return match ? decodeHtml(match[1]).trim() : null;
}

function extractStreetEasyContext(input, html = "") {
  const text = stripHtml(html);
  const title = extractPageTitle(html);
  const description = extractMetaContent(html, "description");
  const address =
    parseStreetAddressFromInput(`${title || ""} ${description || ""}`) ||
    parseStreetAddressFromInput(text) ||
    parseStreetAddressFromSlug(input) ||
    parseStreetAddressFromInput(input);
  const landlord = /manhattan\s+skyline/i.test(`${html} ${input}`)
    ? "Manhattan Skyline"
    : null;

  return {
    address,
    title,
    description,
    landlord,
    streetEasyUrl: streetEasyUrlFromInput(input) || inferKnownStreetEasyUrl(input),
  };
}

function inferLandlordFromContext(context, input = "") {
  if (context.landlord) return context.landlord;

  const source = `${context.address || ""} ${context.title || ""} ${
    context.description || ""
  } ${input}`;
  const searchableSource = source.replace(/[_-]+/g, " ");
  if (/\b(10[7-9]|11[13579])\s+sullivan\b/i.test(searchableSource)) {
    return "Manhattan Skyline";
  }
  if (/\b117\s+sullivan\b/i.test(searchableSource)) return "Manhattan Skyline";
  return null;
}

function buildingSlugFromContext(context, input = "") {
  const address =
    context.address ||
    parseStreetAddressFromSlug(context.streetEasyUrl || "") ||
    parseStreetAddressFromInput(context.streetEasyUrl || "") ||
    parseStreetAddressFromSlug(input) ||
    parseStreetAddressFromInput(input);
  if (address) return normalizeStreetSlug(address);

  const url = context.streetEasyUrl || input;
  const match = String(url).match(/\/building\/([^/_?#]+(?:-[^/_?#]+)*)/i);
  return match ? match[1].replace(/-new-york$/i, "") : null;
}

async function runStreetEasyScoutAgent(input) {
  const streetEasyUrl = streetEasyUrlFromInput(input) || inferKnownStreetEasyUrl(input);
  if (!streetEasyUrl) {
    const context = extractStreetEasyContext(input);
    return {
      ...context,
      landlord: inferLandlordFromContext(context, input),
      steps: [
        {
          agent: "StreetEasy scout",
          status: "skipped",
          detail: "No StreetEasy URL was supplied, so the scout used the typed address.",
        },
      ],
    };
  }

  try {
    const html = await fetchAgentText(streetEasyUrl);
    const context = extractStreetEasyContext(streetEasyUrl, html);
    return {
      ...context,
      streetEasyUrl,
      landlord: inferLandlordFromContext(context, input),
      steps: [
        {
          agent: "StreetEasy scout",
          status: "complete",
          detail: "Fetched the StreetEasy listing page and extracted address/landlord hints.",
          url: streetEasyUrl,
        },
      ],
    };
  } catch (error) {
    const context = extractStreetEasyContext(input);
    return {
      ...context,
      streetEasyUrl,
      landlord: inferLandlordFromContext(context, input),
      steps: [
        {
          agent: "StreetEasy scout",
          status: "partial",
          detail:
            error instanceof Error
              ? error.message
              : "StreetEasy could not be fetched; using typed context.",
          url: streetEasyUrl,
        },
      ],
    };
  }
}

function normalizeManhattanSkylineUnit(unit, building, sourceUrl) {
  const image =
    unit.card_images?.find((item) => item.card || item.src) ||
    unit.images?.find((item) => item.card || item.src) ||
    null;
  const availableOn = unit.available_on || unit.availableOn || null;
  const price = Number(unit.price);
  const facts = uniqueValues([
    unit.bedrooms === 0
      ? "Studio"
      : Number.isFinite(Number(unit.bedrooms))
        ? `${Number(unit.bedrooms)} bed`
        : null,
    Number.isFinite(Number(unit.bathrooms))
      ? `${Number(unit.bathrooms)} bath`
      : null,
    unit.square_footage ? `${Number(unit.square_footage).toLocaleString()} sqft` : null,
    availableOn ? `Available ${availableOn}` : "Available now",
  ]);

  return {
    id: `manhattan-skyline:${unit.slug || unit.number || unit.url}`,
    source: "Manhattan Skyline",
    building: building?.name || building?.display_name || "Manhattan Skyline building",
    address:
      building?.address?.display_name ||
      building?.address?.street ||
      building?.name ||
      null,
    unit: unit.number ? `#${unit.number}` : null,
    price: Number.isFinite(price) ? price : null,
    bedrooms: unit.bedrooms ?? null,
    bathrooms: unit.bathrooms ?? null,
    squareFeet: unit.square_footage ?? null,
    availableOn,
    description: stripHtml(unit.body || unit.highlight || ""),
    facts,
    flags: uniqueValues([
      unit.featured === "Yes" ? "Featured" : null,
      unit.videos ? "Video" : null,
      unit.three_d_tour_url ? "3D tour" : null,
      Number(unit.concession_months_free) > 0
        ? `${Number(unit.concession_months_free)} mo. free`
        : null,
    ]),
    imageUrl: image?.card || image?.src || null,
    url: makeAbsoluteUrl(unit.url, sourceUrl),
  };
}

function parseManhattanSkylineUnits(payload, sourceUrl) {
  const data = payload?.units?.data || payload?.data || [];
  return data
    .map((unit) => normalizeManhattanSkylineUnit(unit, unit.building, sourceUrl))
    .filter((listing) => listing.url || listing.unit || listing.price);
}

async function runManhattanSkylineAgent(context, input) {
  const buildingSlug = buildingSlugFromContext(context, input);
  if (!buildingSlug) {
    throw new AgentError("The Manhattan Skyline agent could not infer a building slug.", 400);
  }

  const buildingUrl = `https://manhattanskyline.com/buildings/soho/${buildingSlug}`;
  let verifiedBuildingUrl = buildingUrl;
  let buildingHtml = "";
  try {
    buildingHtml = await fetchAgentText(buildingUrl);
  } catch (error) {
    if (buildingSlug !== "111-sullivan-street") throw error;
  }

  const embeddedSlug =
    buildingHtml.match(/<unit-list[^>]+:params="\{\s*buildings:\s*'([^']+)'/i)?.[1] ||
    buildingSlug;
  const apiUrl = `https://manhattanskyline.com/api/units?buildings=${encodeURIComponent(
    embeddedSlug,
  )}`;
  const payload = await fetchAgentJson(apiUrl);
  const listings = parseManhattanSkylineUnits(payload, apiUrl);
  if (!listings.length && buildingSlug !== "111-sullivan-street") {
    const parentUrl = "https://manhattanskyline.com/buildings/soho/111-sullivan-street";
    const parentHtml = await fetchAgentText(parentUrl);
    const parentSlug =
      parentHtml.match(/<unit-list[^>]+:params="\{\s*buildings:\s*'([^']+)'/i)?.[1] ||
      "111-sullivan-street";
    const parentApiUrl = `https://manhattanskyline.com/api/units?buildings=${encodeURIComponent(
      parentSlug,
    )}`;
    const parentPayload = await fetchAgentJson(parentApiUrl);
    verifiedBuildingUrl = parentUrl;
    return {
      website: "https://manhattanskyline.com",
      sourceUrl: parentApiUrl,
      buildingUrl: verifiedBuildingUrl,
      listings: parseManhattanSkylineUnits(parentPayload, parentApiUrl),
      steps: [
        {
          agent: "Landlord site agent",
          status: "complete",
          detail:
            "Checked the exact building endpoint, then fell back to the Sullivan Mews portfolio page.",
          url: parentApiUrl,
        },
      ],
    };
  }

  return {
    website: "https://manhattanskyline.com",
    sourceUrl: apiUrl,
    buildingUrl: verifiedBuildingUrl,
    listings,
    steps: [
      {
        agent: "Landlord site agent",
        status: "complete",
        detail: "Loaded Manhattan Skyline's public unit API for the inferred building.",
        url: apiUrl,
      },
    ],
  };
}

async function findLandlordListings(input) {
  const key = String(input || "").trim().toLowerCase();
  if (!key) throw new AgentError("Enter a StreetEasy listing URL or address.", 400);

  const cached = landlordAgentCache.get(key);
  if (cached && Date.now() - cached.savedAt < LANDLORD_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  const scout = await runStreetEasyScoutAgent(input);
  const landlord = inferLandlordFromContext(scout, input);
  if (!landlord) {
    throw new AgentError(
      "The agent could not identify a supported landlord from that listing yet.",
      422,
    );
  }

  let landlordResult;
  if (/manhattan\s+skyline/i.test(landlord)) {
    landlordResult = await runManhattanSkylineAgent({ ...scout, landlord }, input);
  } else {
    throw new AgentError(`${landlord} is not supported by a landlord-site agent yet.`, 422);
  }

  const value = {
    input,
    landlord,
    address: scout.address,
    streetEasyUrl: scout.streetEasyUrl,
    website: landlordResult.website,
    buildingUrl: landlordResult.buildingUrl,
    sourceUrl: landlordResult.sourceUrl,
    listings: landlordResult.listings,
    agentSteps: [...(scout.steps || []), ...(landlordResult.steps || [])],
    generatedAt: new Date().toISOString(),
    cached: false,
  };
  landlordAgentCache.set(key, { savedAt: Date.now(), value });
  return value;
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function serveStatic(requestPath, response) {
  const normalizedPath =
    requestPath === "/"
      ? "/index.html"
      : requestPath === "/landlord"
        ? "/landlord.html"
        : requestPath;
  const filePath = path.resolve(
    PUBLIC_DIR,
    `.${decodeURIComponent(normalizedPath)}`,
  );

  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    response.writeHead(200, {
      "Content-Type":
        MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(content);
  });
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    const unlockMatch = url.pathname.match(
      /^\/unlock\/([A-Za-z0-9_-]{20,200})$/,
    );
    if (unlockMatch && request.method === "GET") {
      if (!ACCESS_TOKEN || !safeEqual(unlockMatch[1], ACCESS_TOKEN)) {
        response.writeHead(404, { "Cache-Control": "no-store" });
        response.end("Not found");
        return;
      }

      response.writeHead(302, {
        Location: "/",
        "Set-Cookie": sessionCookie(request),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end();
      return;
    }

    if (url.pathname === "/manifest.webmanifest" && request.method === "GET") {
      sendJson(
        response,
        200,
        {
          ...APP_MANIFEST,
          start_url:
            ACCESS_TOKEN && hasValidSession(request)
              ? `/unlock/${ACCESS_TOKEN}`
              : "/",
        },
        {
          "Content-Type": "application/manifest+json; charset=utf-8",
          "Referrer-Policy": "no-referrer",
        },
      );
      return;
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const body = await readJson(request);
        if (!ACCESS_PASSWORD || !safeEqual(body.password || "", ACCESS_PASSWORD)) {
          sendJson(response, 401, {
            error: "That password does not match.",
          });
          return;
        }
        sendJson(
          response,
          200,
          { authenticated: true },
          { "Set-Cookie": sessionCookie(request) },
        );
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid request.",
        });
      }
      return;
    }

    const protectedDashboardPage = ["/", "/index.html"].includes(url.pathname);
    const protectedApi =
      url.pathname.startsWith("/api/") &&
      url.pathname !== "/api/landlord-listings";
    if (
      AUTH_ENABLED &&
      (protectedDashboardPage || protectedApi) &&
      !hasValidSession(request)
    ) {
      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 401, {
          error: "Unlock First Look to scan listings.",
        });
      } else {
        response.writeHead(302, {
          Location: "/login.html",
          "Cache-Control": "no-store",
        });
        response.end();
      }
      return;
    }

    if (url.pathname === "/api/user-state") {
      try {
        if (request.method === "GET") {
          sendJson(response, 200, readUserState());
          return;
        }
        if (request.method === "PUT") {
          sendJson(response, 200, writeUserState(await readJson(request)));
          return;
        }
        response.writeHead(405, { Allow: "GET, PUT" });
        response.end("Method not allowed");
      } catch (error) {
        sendJson(response, 400, {
          error:
            error instanceof Error
              ? error.message
              : "Saved listing state could not be updated.",
        });
      }
      return;
    }

    if (url.pathname === "/api/listings" && request.method === "GET") {
      try {
        const criteria = parseSearchParams(url.searchParams);
        sendJson(response, 200, await findRecentListings(criteria));
      } catch (error) {
        const status = error instanceof UpstreamError ? error.status : 400;
        sendJson(response, status, {
          error:
            error instanceof Error
              ? error.message
              : "The listing search could not be completed.",
        });
      }
      return;
    }

    if (url.pathname === "/api/landlord-listings" && request.method === "GET") {
      try {
        sendJson(
          response,
          200,
          await findLandlordListings(url.searchParams.get("source") || ""),
        );
      } catch (error) {
        const status = error instanceof AgentError ? error.status : 400;
        sendJson(response, status, {
          error:
            error instanceof Error
              ? error.message
              : "The landlord agent could not complete the search.",
        });
      }
      return;
    }

    const listingDetailsMatch = url.pathname.match(
      /^\/api\/listings\/([A-Za-z0-9_-]{1,80})$/,
    );
    if (listingDetailsMatch && request.method === "GET") {
      try {
        sendJson(
          response,
          200,
          await findListingDetails(listingDetailsMatch[1]),
        );
      } catch (error) {
        const status = error instanceof UpstreamError ? error.status : 400;
        sendJson(response, status, {
          error:
            error instanceof Error
              ? error.message
              : "The listing details could not be loaded.",
        });
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }

    serveStatic(url.pathname, response);
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`First Look dashboard: http://${HOST}:${PORT}`);
  });
}

module.exports = {
  buildDetailsQuery,
  buildFilterLiteral,
  buildFullDetailsQuery,
  buildSearchQuery,
  createServer,
  decorateListing,
  findLandlordListings,
  avenueBLongitudeAt,
  latestActiveAt,
  normalizeStreetSlug,
  parseManhattanSkylineUnits,
  parseSearchParams,
  passesAvenueBBoundary,
  normalizeUserState,
  readUserState,
  writeUserState,
};
