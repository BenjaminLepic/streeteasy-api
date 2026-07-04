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
const AUTH_SECRET = process.env.AUTH_SECRET || ACCESS_PASSWORD;
const PUBLIC_DIR = path.join(__dirname, "public");
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
const cache = new Map();

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
  if (!ACCESS_PASSWORD) return true;
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
    "Max-Age=2592000",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
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
    imageUrl: listing.leadMedia?.photo?.key
      ? `https://photos.zillowstatic.com/fp/${listing.leadMedia.photo.key}-cc_ft_768.webp`
      : null,
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
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
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

    if (
      ACCESS_PASSWORD &&
      ["/", "/index.html", "/api/listings"].includes(url.pathname) &&
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
  buildSearchQuery,
  createServer,
  decorateListing,
  avenueBLongitudeAt,
  latestActiveAt,
  parseSearchParams,
  passesAvenueBBoundary,
};
