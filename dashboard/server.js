const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} = require("node:crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const AUTH_ENABLED =
  process.env.AUTH_ENABLED === "true" && Boolean(ACCESS_PASSWORD || ACCESS_TOKEN);
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
const BROKER_AGENT_ENDPOINT = process.env.BROKER_AGENT_ENDPOINT || "";
const BROKER_AGENT_SECRET = process.env.BROKER_AGENT_SECRET || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_RESPONSES_URL =
  process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
const BROKER_AGENT_MODEL = process.env.BROKER_AGENT_MODEL || "gpt-4.1-mini";
const BROKER_SOURCE_AGENT_LIMIT = boundedInteger(
  process.env.BROKER_SOURCE_AGENT_LIMIT,
  6,
  1,
  25,
);
const BROKER_AGENT_REQUEST_TIMEOUT_MS = boundedInteger(
  process.env.BROKER_AGENT_REQUEST_TIMEOUT_MS,
  600_000,
  30_000,
  900_000,
);
const BROKER_AGENT_MAX_OUTPUT_TOKENS = boundedInteger(
  process.env.BROKER_AGENT_MAX_OUTPUT_TOKENS,
  6000,
  1000,
  20000,
);
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

function boundedInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) ? clamp(number, min, max) : fallback;
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
    includeSourceListings: parseBoolean(params, "includeSourceListings"),
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
    includeSourceListings: false,
  };
  const cacheKey = JSON.stringify(sourceCriteria);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    const result = applyLocalFilters(cached.value, criteria, true);
    return maybeAppendSourceListings(result, criteria);
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
  const result = applyLocalFilters(sourceValue, criteria, false);
  return maybeAppendSourceListings(result, criteria);
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

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function normalizedSourceText(value = "") {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeAreaName(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function sourceListingPrice(listing) {
  return numberOrNull(
    listing.price ?? listing.rent ?? listing.monthlyRent ?? listing.monthly_rent,
  );
}

function sourceListingBedrooms(listing) {
  const value =
    listing.bedrooms ??
    listing.bedroomCount ??
    listing.beds ??
    listing.bed_count;
  if (typeof value === "string" && /\bstudio\b/i.test(value)) return 0;
  return numberOrNull(value);
}

function sourceListingBathrooms(listing) {
  return numberOrNull(
    listing.bathrooms ??
      listing.bathroomCount ??
      listing.baths ??
      listing.bath_count,
  );
}

function sourceListingNoFee(listing) {
  if (typeof listing.noFee === "boolean") return listing.noFee;
  const text = normalizedSourceText(
    [
      listing.fee,
      listing.description,
      ...(Array.isArray(listing.flags) ? listing.flags : []),
      ...(Array.isArray(listing.facts) ? listing.facts : []),
    ].join(" "),
  );
  return /\bno fee\b|\bno-fee\b/.test(text);
}

function normalizeAvailableDate(value) {
  if (!value) return null;
  const input = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function splitBathroomCount(value) {
  const bathrooms = numberOrNull(value);
  if (bathrooms === null) {
    return { fullBathroomCount: 0, halfBathroomCount: 0 };
  }
  return {
    fullBathroomCount: Math.floor(bathrooms),
    halfBathroomCount: bathrooms % 1 >= 0.5 ? 1 : 0,
  };
}

function stableSourceListingId(listing, seed) {
  const key = [
    listing.url,
    listing.id,
    listing.sourceUrl,
    listing.building,
    listing.address,
    listing.unit,
    listing.price,
    seed?.id,
  ]
    .filter(Boolean)
    .join("|");
  return `broker_${createHash("sha256")
    .update(key || randomUUID())
    .digest("hex")
    .slice(0, 18)}`;
}

function sourceListingKey(listing, normalized) {
  return (
    listing.url ||
    listing.sourceUrl ||
    listing.id ||
    `${normalized.sourceLabel}|${normalized.street}|${normalized.unit}|${normalized.price}`
  );
}

function matchesLandlordListingCriteria(listing, seed, criteria) {
  const price = sourceListingPrice(listing);
  if (!Number.isFinite(price)) return false;
  if (criteria.minPrice !== null && price < criteria.minPrice) return false;
  if (criteria.maxPrice !== null && price > criteria.maxPrice) return false;

  const areaCode = numberOrNull(listing.areaCode ?? listing.area?.id);
  if (areaCode !== null && !criteria.areas.includes(areaCode)) return false;
  if (
    listing.areaName &&
    seed?.areaName &&
    normalizeAreaName(listing.areaName) !== normalizeAreaName(seed.areaName)
  ) {
    return false;
  }
  if (!seed?.areaName && !listing.areaName && areaCode === null) return false;

  const bedrooms = sourceListingBedrooms(listing);
  if (criteria.minBedrooms !== null && bedrooms !== null && bedrooms < criteria.minBedrooms) {
    return false;
  }
  if (criteria.maxBedrooms !== null && bedrooms !== null && bedrooms > criteria.maxBedrooms) {
    return false;
  }

  const bathrooms = sourceListingBathrooms(listing);
  if (criteria.minBathrooms !== null && bathrooms !== null && bathrooms < criteria.minBathrooms) {
    return false;
  }
  return true;
}

function displayStreetForSourceListing(listing, seed) {
  return (
    listing.street ||
    parseStreetAddressFromInput(listing.address || "") ||
    parseStreetAddressFromInput(listing.building || "") ||
    listing.address ||
    listing.building ||
    seed?.street ||
    "Broker source listing"
  );
}

function normalizeSourceUnit(listing) {
  if (listing.unit) return String(listing.unit);
  if (listing.number) {
    const number = String(listing.number).trim();
    return number.startsWith("#") ? number : `#${number}`;
  }
  return "";
}

function sourceListingGeoPoint(listing, seed) {
  if (
    Number.isFinite(Number(listing.geoPoint?.latitude)) &&
    Number.isFinite(Number(listing.geoPoint?.longitude))
  ) {
    return {
      latitude: Number(listing.geoPoint.latitude),
      longitude: Number(listing.geoPoint.longitude),
    };
  }

  if (
    Number.isFinite(Number(listing.latitude)) &&
    Number.isFinite(Number(listing.longitude))
  ) {
    return {
      latitude: Number(listing.latitude),
      longitude: Number(listing.longitude),
    };
  }

  return seed?.geoPoint || null;
}

function normalizeLandlordListingForDashboard(listing, seed, criteria) {
  if (!matchesLandlordListingCriteria(listing, seed, criteria)) return null;

  const price = sourceListingPrice(listing);
  const bedroomCount = sourceListingBedrooms(listing);
  const bathrooms = sourceListingBathrooms(listing);
  const { fullBathroomCount, halfBathroomCount } = splitBathroomCount(bathrooms);
  const sourceLabel =
    listing.landlord ||
    listing.source ||
    listing.broker ||
    listing.brokerage ||
    "Broker site";
  const sourceUrl = listing.url || listing.sourceUrl || null;
  const noFee = sourceListingNoFee(listing);
  const neighborhoodMedian = seed?.neighborhoodMedian ?? null;
  const percentBelowMedian =
    neighborhoodMedian && price
      ? Math.round(((neighborhoodMedian - price) / neighborhoodMedian) * 100)
      : null;
  const valueScore = Math.round(
    clamp(percentBelowMedian ?? 0, -20, 30) * 2 +
      (noFee ? 14 : 0) +
      (numberOrNull(listing.squareFeet ?? listing.square_footage) ? 4 : 0),
  );

  return {
    id: stableSourceListingId(listing, seed),
    sourceOrigin: "broker_site",
    sourceLabel,
    sourceUrl,
    sourceMatchBasis: listing.areaName ? "agent_area" : "streeteasy_seed_area",
    seedListingId: seed?.id ? String(seed.id) : null,
    seedStreetEasyUrl: seed?.streetEasyUrl || null,
    areaName: listing.areaName || seed?.areaName || "Matched area",
    availableAt:
      normalizeAvailableDate(listing.availableOn) ||
      normalizeAvailableDate(listing.availableAt),
    bedroomCount,
    buildingType: seed?.buildingType || "RENTAL",
    fullBathroomCount,
    halfBathroomCount,
    furnished: Boolean(listing.furnished),
    geoPoint: sourceListingGeoPoint(listing, seed),
    hasTour3d: Boolean(listing.tour3dUrl || listing.three_d_tour_url),
    hasVideos: Boolean(listing.videoUrl || listing.videos),
    isNewDevelopment: Boolean(listing.isNewDevelopment),
    leaseTermMonths: numberOrNull(listing.leaseTermMonths),
    livingAreaSize: numberOrNull(listing.squareFeet ?? listing.square_footage),
    mediaAssetCount: listing.imageUrl ? 1 : 0,
    monthsFree: numberOrNull(listing.monthsFree ?? listing.concession_months_free),
    noFee,
    netEffectivePrice: numberOrNull(listing.netEffectivePrice),
    price,
    sourceGroupLabel: sourceLabel,
    status: "ACTIVE",
    street: displayStreetForSourceListing(listing, seed),
    unit: normalizeSourceUnit(listing),
    urlPath: sourceUrl,
    listedAt: seed?.listedAt || new Date().toISOString(),
    createdAt: null,
    ageHours: Number.isFinite(seed?.ageHours) ? seed.ageHours : 0,
    neighborhoodMedian,
    percentBelowMedian,
    valueScore,
    windowHours: criteria.hours,
    streetEasyUrl: sourceUrl || seed?.streetEasyUrl || "",
    imageUrl: listing.imageUrl || null,
    flags: uniqueValues([
      ...(Array.isArray(listing.flags) ? listing.flags : []),
      "Broker source",
      "Assumed off StreetEasy",
    ]),
  };
}

function brokerAgentSeedPayload(seed) {
  return {
    id: seed.id,
    streetEasyUrl: seed.streetEasyUrl,
    address: [seed.street, seed.unit].filter(Boolean).join(" "),
    areaName: seed.areaName,
    price: seed.price,
    bedrooms: seed.bedroomCount,
    bathrooms:
      Number(seed.fullBathroomCount || 0) +
      Number(seed.halfBathroomCount || 0) * 0.5,
    geoPoint: seed.geoPoint || null,
    sourceGroupLabel: seed.sourceGroupLabel || null,
  };
}

function brokerAgentCriteriaPayload(criteria) {
  return {
    areas: criteria.areas,
    hours: criteria.hours,
    minPrice: criteria.minPrice,
    maxPrice: criteria.maxPrice,
    minBedrooms: criteria.minBedrooms,
    maxBedrooms: criteria.maxBedrooms,
    minBathrooms: criteria.minBathrooms,
  };
}

const BROKER_SOURCE_AGENT_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["landlord", "website", "sourceUrl", "listings", "agentSteps"],
  properties: {
    landlord: {
      type: ["string", "null"],
      description: "The broker, brokerage, landlord, or source company name.",
    },
    website: {
      type: ["string", "null"],
      description: "The company website used for the search.",
    },
    sourceUrl: {
      type: ["string", "null"],
      description: "The rental, availability, or listing page inspected.",
    },
    listings: {
      type: "array",
      description:
        "Active rental listings found on the broker or landlord site, not aggregator pages.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "url",
          "sourceUrl",
          "source",
          "landlord",
          "broker",
          "price",
          "areaName",
          "address",
          "street",
          "unit",
          "bedrooms",
          "bathrooms",
          "squareFeet",
          "latitude",
          "longitude",
          "imageUrl",
          "availableOn",
          "description",
          "noFee",
          "facts",
          "flags",
        ],
        properties: {
          url: { type: ["string", "null"] },
          sourceUrl: { type: ["string", "null"] },
          source: { type: ["string", "null"] },
          landlord: { type: ["string", "null"] },
          broker: { type: ["string", "null"] },
          price: { type: ["number", "null"] },
          areaName: { type: ["string", "null"] },
          address: { type: ["string", "null"] },
          street: { type: ["string", "null"] },
          unit: { type: ["string", "null"] },
          bedrooms: { type: ["number", "null"] },
          bathrooms: { type: ["number", "null"] },
          squareFeet: { type: ["number", "null"] },
          latitude: { type: ["number", "null"] },
          longitude: { type: ["number", "null"] },
          imageUrl: { type: ["string", "null"] },
          availableOn: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          noFee: { type: ["boolean", "null"] },
          facts: { type: "array", items: { type: "string" } },
          flags: { type: "array", items: { type: "string" } },
        },
      },
    },
    agentSteps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["agent", "status", "detail", "url"],
        properties: {
          agent: { type: "string" },
          status: { type: "string", enum: ["complete", "partial", "skipped"] },
          detail: { type: "string" },
          url: { type: ["string", "null"] },
        },
      },
    },
  },
};

function brokerAgentConfigured() {
  return Boolean(BROKER_AGENT_ENDPOINT || OPENAI_API_KEY);
}

function brokerAgentConfigurationMessage() {
  return "Set OPENAI_API_KEY or BROKER_AGENT_ENDPOINT to enable the generic source-site AI agent.";
}

function normalizeExternalAgentResult(payload, seed) {
  return {
    landlord:
      payload.landlord ||
      payload.broker ||
      payload.source ||
      seed.sourceGroupLabel ||
      "Broker agent",
    website: payload.website || null,
    buildingUrl: payload.buildingUrl || null,
    sourceUrl: payload.sourceUrl || payload.website || null,
    listings: Array.isArray(payload.listings) ? payload.listings : [],
    agentSteps: Array.isArray(payload.agentSteps)
      ? payload.agentSteps
      : Array.isArray(payload.steps)
        ? payload.steps
        : [
            {
              agent: "Broker-site agent",
              status: "complete",
              detail: "The configured broker agent returned structured listings.",
              url: payload.sourceUrl || payload.website || null,
            },
          ],
  };
}

function extractOpenAiOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  (payload?.output || []).forEach((item) => {
    if (item?.type !== "message" || !Array.isArray(item.content)) return;
    item.content.forEach((content) => {
      if (typeof content?.text === "string") chunks.push(content.text);
    });
  });
  return chunks.join("\n").trim();
}

function extractOpenAiRefusal(payload) {
  for (const item of payload?.output || []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    const refused = item.content.find((content) => content?.refusal);
    if (refused) return refused.refusal;
  }
  return null;
}

function openAiBrokerAgentPrompt(seed, criteria) {
  return JSON.stringify(
    {
      currentDate: new Date().toISOString().slice(0, 10),
      task:
        "Find the broker/landlord/company website for this fresh StreetEasy rental, traverse that company site, and return active rental listings from that source site that match the supplied filters.",
      constraints: [
        "Do not use a known-landlord adapter or prior landlord-specific knowledge.",
        "Use web search to identify the source company website from the seed listing.",
        "Prefer the company's own website and direct availability/listing pages.",
        "Do not return StreetEasy, Zillow, Apartments.com, RentHop, Realtor.com, or other aggregator URLs as source listings.",
        "Only include listings that appear active and plausibly match the requested price, bedrooms, bathrooms, and neighborhood/area.",
        "If a value is not visible on the source site, return null rather than guessing.",
        "Assume returned source-site rentals are not on StreetEasy. Do not spend time checking StreetEasy duplication.",
      ],
      seedListing: brokerAgentSeedPayload(seed),
      criteria: brokerAgentCriteriaPayload(criteria),
      outputNotes: [
        "Return empty listings if the source website cannot be confidently found or has no matching active rentals.",
        "Use areaName values like the source site presents them, for example Soho or East Village.",
        "Put the best direct listing page in url; put the page you searched in sourceUrl.",
      ],
    },
    null,
    2,
  );
}

function parseOpenAiBrokerAgentPayload(payload) {
  if (payload?.status === "incomplete") {
    throw new AgentError(
      payload.incomplete_details?.reason
        ? `The OpenAI source-site agent stopped early: ${payload.incomplete_details.reason}.`
        : "The OpenAI source-site agent stopped before finishing.",
      502,
    );
  }

  const refusal = extractOpenAiRefusal(payload);
  if (refusal) {
    throw new AgentError(`The OpenAI source-site agent refused: ${refusal}`, 502);
  }

  const text = extractOpenAiOutputText(payload);
  if (!text) {
    throw new AgentError("The OpenAI source-site agent returned no listing JSON.", 502);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AgentError("The OpenAI source-site agent returned invalid JSON.", 502);
  }
}

async function runOpenAiBrokerAgent(seed, criteria) {
  if (!OPENAI_API_KEY) {
    throw new AgentError(
      "Set OPENAI_API_KEY to enable the generic source-site AI agent.",
      422,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    BROKER_AGENT_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: BROKER_AGENT_MODEL,
        store: false,
        tools: [{ type: "web_search", external_web_access: true }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        max_output_tokens: BROKER_AGENT_MAX_OUTPUT_TOKENS,
        input: [
          {
            role: "system",
            content:
              "You are a versatile web research agent for a NYC rental dashboard. You do not have hardcoded landlord adapters. Search the web, identify the source company website for the seed rental, inspect that company's own rental pages, and return only structured active rental candidates.",
          },
          { role: "user", content: openAiBrokerAgentPrompt(seed, criteria) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "broker_source_listing_result",
            strict: true,
            schema: BROKER_SOURCE_AGENT_RESULT_SCHEMA,
          },
        },
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      throw new AgentError(
        payload?.error?.message ||
          `The OpenAI source-site agent returned HTTP ${response.status}.`,
        response.status >= 500 ? 502 : response.status,
      );
    }

    const parsed = parseOpenAiBrokerAgentPayload(payload);
    return normalizeExternalAgentResult(parsed, seed);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AgentError("The OpenAI source-site agent did not finish in time.", 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runExternalBrokerAgent(seed, criteria) {
  if (!BROKER_AGENT_ENDPOINT) {
    throw new AgentError("No generic broker-site agent endpoint is configured.", 422);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    BROKER_AGENT_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(BROKER_AGENT_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(BROKER_AGENT_SECRET
          ? { "X-First-Look-Agent-Secret": BROKER_AGENT_SECRET }
          : {}),
      },
      body: JSON.stringify({
        version: "first-look-broker-agent-v1",
        task:
          "Find the broker or landlord website for this fresh StreetEasy rental, traverse the site, and return active rentals that match the supplied price and area criteria. Assume returned source-site units are not on StreetEasy.",
        seedListing: brokerAgentSeedPayload(seed),
        criteria: brokerAgentCriteriaPayload(criteria),
        requiredListingFields: [
          "url",
          "price",
          "areaName",
          "address",
          "unit",
          "bedrooms",
          "bathrooms",
          "imageUrl",
          "availableOn",
        ],
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      throw new AgentError(
        payload?.error ||
          `The configured broker agent returned HTTP ${response.status}.`,
        response.status >= 500 ? 502 : response.status,
      );
    }
    return normalizeExternalAgentResult(payload, seed);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AgentError("The configured broker agent did not finish in time.", 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runGenericBrokerAgent(seed, criteria) {
  if (!brokerAgentConfigured()) {
    throw new AgentError(brokerAgentConfigurationMessage(), 422);
  }
  if (BROKER_AGENT_ENDPOINT) {
    return runExternalBrokerAgent(seed, criteria);
  }
  return runOpenAiBrokerAgent(seed, criteria);
}

async function runBrokerSourceAgentForSeed(seed, criteria) {
  return runGenericBrokerAgent(seed, criteria);
}

async function findBrokerSourceListingsForRecentListings(seeds, criteria) {
  if (!brokerAgentConfigured()) {
    return {
      enabled: false,
      generatedAt: new Date().toISOString(),
      configuredGenericAgent: false,
      configurationError: brokerAgentConfigurationMessage(),
      seedLimit: BROKER_SOURCE_AGENT_LIMIT,
      searchedSeedCount: 0,
      successCount: 0,
      errorCount: 1,
      matchedListingCount: 0,
      sources: [],
      listings: [],
    };
  }

  const selectedSeeds = seeds
    .filter((listing) => listing.streetEasyUrl || listing.street)
    .slice(0, BROKER_SOURCE_AGENT_LIMIT);
  const seen = new Set();
  const listings = [];
  const sources = [];

  for (const seed of selectedSeeds) {
    try {
      const result = await runBrokerSourceAgentForSeed(seed, criteria);
      let matchedCount = 0;
      (result.listings || []).forEach((sourceListing) => {
        const normalized = normalizeLandlordListingForDashboard(
          {
            ...sourceListing,
            landlord: sourceListing.landlord || result.landlord,
            source: sourceListing.source || result.landlord,
          },
          seed,
          criteria,
        );
        if (!normalized) return;
        const key = sourceListingKey(sourceListing, normalized);
        if (seen.has(key)) return;
        seen.add(key);
        matchedCount += 1;
        listings.push(normalized);
      });
      sources.push({
        seedListingId: String(seed.id),
        seedAddress: [seed.street, seed.unit].filter(Boolean).join(" "),
        ok: true,
        landlord: result.landlord,
        website: result.website || null,
        sourceUrl: result.sourceUrl || null,
        foundCount: (result.listings || []).length,
        matchedCount,
        agentSteps: result.agentSteps || [],
      });
    } catch (error) {
      sources.push({
        seedListingId: String(seed.id),
        seedAddress: [seed.street, seed.unit].filter(Boolean).join(" "),
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "The broker-site agent could not complete this seed listing.",
      });
    }
  }

  return {
    enabled: true,
    generatedAt: new Date().toISOString(),
    configuredGenericAgent: brokerAgentConfigured(),
    seedLimit: BROKER_SOURCE_AGENT_LIMIT,
    searchedSeedCount: selectedSeeds.length,
    successCount: sources.filter((source) => source.ok).length,
    errorCount: sources.filter((source) => !source.ok).length,
    matchedListingCount: listings.length,
    sources,
    listings,
  };
}

async function findBrokerSourceListingsForDashboardListing(seed, criteria) {
  if (!seed || typeof seed !== "object") {
    throw new AgentError("A First Look rental is required for source search.", 400);
  }
  if (seed.sourceOrigin === "broker_site") {
    throw new AgentError("This rental already came from a broker source site.", 400);
  }

  const result = await runBrokerSourceAgentForSeed(seed, criteria);
  const seen = new Set();
  const listings = [];
  (result.listings || []).forEach((sourceListing) => {
    const normalized = normalizeLandlordListingForDashboard(
      {
        ...sourceListing,
        landlord: sourceListing.landlord || result.landlord,
        source: sourceListing.source || result.landlord,
      },
      seed,
      criteria,
    );
    if (!normalized) return;
    const key = sourceListingKey(sourceListing, normalized);
    if (seen.has(key)) return;
    seen.add(key);
    listings.push(normalized);
  });

  return {
    generatedAt: new Date().toISOString(),
    seedListingId: String(seed.id),
    seedAddress: [seed.street, seed.unit].filter(Boolean).join(" "),
    landlord: result.landlord,
    website: result.website || null,
    sourceUrl: result.sourceUrl || null,
    foundCount: (result.listings || []).length,
    matchedListingCount: listings.length,
    agentSteps: result.agentSteps || [],
    listings,
  };
}

async function maybeAppendSourceListings(result, criteria) {
  if (!criteria.includeSourceListings) return result;

  const sourceAgent = await findBrokerSourceListingsForRecentListings(
    result.listings,
    criteria,
  );
  const { listings: sourceListings, ...summary } = sourceAgent;
  return {
    ...result,
    listings: [...result.listings, ...sourceListings].sort(
      (left, right) =>
        Date.parse(right.listedAt || right.generatedAt || 0) -
        Date.parse(left.listedAt || left.generatedAt || 0),
    ),
    sourceAgent: summary,
  };
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseStreetAddressFromInput(value = "") {
  const input = String(value);
  const match = input.match(
    /\b(\d{1,5})\s+([A-Za-z][A-Za-z\s'.-]*?)\s+(street|st|avenue|ave|road|rd|place|pl|boulevard|blvd)\b/i,
  );
  if (!match) return null;
  return `${match[1]} ${match[2].trim()} ${match[3]}`;
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

function seedFromAgentInput(input) {
  const source = String(input || "").trim();
  const streetEasyUrl = streetEasyUrlFromInput(source);
  const address = parseStreetAddressFromInput(source) || source;
  return {
    id: `source-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
    streetEasyUrl,
    street: address,
    unit: "",
    areaName: null,
    price: null,
    bedroomCount: null,
    fullBathroomCount: null,
    halfBathroomCount: null,
    geoPoint: null,
    sourceGroupLabel: null,
  };
}

async function findLandlordListings(
  input,
  criteria = parseSearchParams(new URLSearchParams()),
) {
  const source = String(input || "").trim();
  if (!source) throw new AgentError("Enter a StreetEasy listing URL or address.", 400);

  const key = JSON.stringify({
    source: source.toLowerCase(),
    criteria: brokerAgentCriteriaPayload(criteria),
  });
  const cached = landlordAgentCache.get(key);
  if (cached && Date.now() - cached.savedAt < LANDLORD_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  const seed = seedFromAgentInput(source);
  const result = await runGenericBrokerAgent(seed, criteria);
  const value = {
    input: source,
    landlord: result.landlord,
    address: seed.street,
    streetEasyUrl: seed.streetEasyUrl,
    website: result.website,
    buildingUrl: result.buildingUrl,
    sourceUrl: result.sourceUrl,
    listings: result.listings,
    agentSteps: result.agentSteps || [],
    generatedAt: new Date().toISOString(),
    cached: false,
  };
  landlordAgentCache.set(key, { savedAt: Date.now(), value });
  return value;
}

function listingDetailsAgentSource(details) {
  const address = details?.property?.address || {};
  return [
    address.street || details?.building?.address?.street,
    address.unit,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

async function findLandlordListingsForListingIds(ids) {
  const listingIds = normalizeStoredIds(ids || [], "listingIds");
  if (!listingIds.length) {
    throw new AgentError("No liked First Look rentals were found.", 400);
  }
  if (listingIds.length > 25) {
    throw new AgentError("Scan 25 liked rentals or fewer at a time.", 400);
  }

  const settled = await Promise.all(
    listingIds.map(async (id) => {
      try {
        const details = await findListingDetails(id);
        const source = listingDetailsAgentSource(details);
        if (!source) {
          throw new AgentError("The listing address could not be resolved.", 422);
        }
        return {
          id,
          source,
          ok: true,
          result: await findLandlordListings(source),
        };
      } catch (error) {
        return {
          id,
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "The source agent could not complete this liked rental.",
        };
      }
    }),
  );

  const listingKeys = new Set();
  const listings = [];
  settled.forEach((item) => {
    if (!item.ok) return;
    item.result.listings.forEach((listing) => {
      const key = listing.url || listing.id;
      if (key && listingKeys.has(key)) return;
      if (key) listingKeys.add(key);
      listings.push({
        ...listing,
        firstLookListingId: item.id,
        scanSource: item.source,
        landlord: item.result.landlord,
        streetEasyUrl: item.result.streetEasyUrl,
      });
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    likedCount: listingIds.length,
    successCount: settled.filter((item) => item.ok).length,
    errorCount: settled.filter((item) => !item.ok).length,
    sources: settled,
    listings,
  };
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
      !url.pathname.startsWith("/api/landlord-listings");
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
              : "The source agent could not complete the search.",
        });
      }
      return;
    }

    if (
      url.pathname === "/api/landlord-listings/from-ids" &&
      request.method === "POST"
    ) {
      try {
        const body = await readJson(request);
        sendJson(
          response,
          200,
          await findLandlordListingsForListingIds(body.listingIds || []),
        );
      } catch (error) {
        const status = error instanceof AgentError ? error.status : 400;
        sendJson(response, status, {
          error:
            error instanceof Error
              ? error.message
              : "The liked-rental scan could not complete.",
        });
      }
      return;
    }

    if (
      url.pathname === "/api/source-listings/from-listing" &&
      request.method === "POST"
    ) {
      try {
        const criteria = parseSearchParams(url.searchParams);
        const body = await readJson(request);
        sendJson(
          response,
          200,
          await findBrokerSourceListingsForDashboardListing(
            body.listing,
            criteria,
          ),
        );
      } catch (error) {
        const status = error instanceof AgentError ? error.status : 400;
        sendJson(response, status, {
          error:
            error instanceof Error
              ? error.message
              : "The source search could not complete.",
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
  findLandlordListingsForListingIds,
  avenueBLongitudeAt,
  latestActiveAt,
  extractOpenAiOutputText,
  listingDetailsAgentSource,
  matchesLandlordListingCriteria,
  normalizeExternalAgentResult,
  normalizeLandlordListingForDashboard,
  parseSearchParams,
  passesAvenueBBoundary,
  normalizeUserState,
  readUserState,
  writeUserState,
};
