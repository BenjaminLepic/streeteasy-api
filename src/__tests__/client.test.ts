import { GraphQLClient } from "graphql-request";
import { StreetEasyClient } from "../index";
import { Areas, Amenities } from "../constants";
import { SEARCH_RENTALS_QUERY, RENTAL_LISTING_DETAILS_QUERY } from "../queries";
import type {
  SearchRentalsInput,
  OrganicRentalEdge,
  FeaturedRentalEdge,
  SponsoredRentalEdge,
  RentalEdge,
} from "../types";
import { v4 as uuidv4 } from "uuid";

// Type guard functions - imported from examples for testing
function isOrganicOrFeaturedEdge(
  edge: any,
): edge is OrganicRentalEdge | FeaturedRentalEdge {
  return (
    edge.__typename === "OrganicRentalEdge" ||
    edge.__typename === "FeaturedRentalEdge"
  );
}

function isSponsoredEdge(edge: any): edge is SponsoredRentalEdge {
  return edge.__typename === "SponsoredRentalEdge";
}

// Create a ClientError class for testing
class ClientError extends Error {
  response: {
    errors: Array<{ message: string; extensions?: any }>;
    status: number;
    headers: any;
  };
  request: {
    query: string;
    variables: any;
  };

  constructor(message: string, response: any, request: any) {
    super(message);
    this.name = "ClientError";
    this.response = response;
    this.request = request;
  }
}

// Mock GraphQLClient
jest.mock("graphql-request");

// Mock the UUID library
jest.mock("uuid", () => ({
  v4: jest.fn(() => "mock-uuid"),
}));

describe("StreetEasyClient", () => {
  let client: StreetEasyClient;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Mock successful response
    (GraphQLClient as jest.Mock).mockImplementation(() => ({
      request: jest.fn().mockResolvedValue({
        searchRentals: {
          search: {
            criteria: "area:400|price:-10000",
          },
          totalCount: 1,
          edges: [
            {
              node: {
                id: "123",
                areaName: "Queens",
                bedroomCount: 2,
                buildingType: "RENTAL",
                fullBathroomCount: 1,
                geoPoint: {
                  latitude: 40.7128,
                  longitude: -73.8067,
                },
                halfBathroomCount: 0,
                noFee: true,
                leadMedia: {
                  photo: {
                    key: "photo123",
                  },
                },
                price: 2500,
                sourceGroupLabel: "Agency",
                street: "123 Main St",
                unit: "2B",
                urlPath: "/rental/123",
              },
            },
          ],
        },
      }),
    }));
  });

  describe("constructor", () => {
    it("should create client with default endpoint", () => {
      client = new StreetEasyClient();
      expect(GraphQLClient).toHaveBeenCalledWith(
        "https://api-v6.streeteasy.com/",
        expect.any(Object),
      );
    });

    it("should create client with custom endpoint", () => {
      const customEndpoint = "https://custom.endpoint/graphql";
      client = new StreetEasyClient({ endpoint: customEndpoint });
      expect(GraphQLClient).toHaveBeenCalledWith(
        customEndpoint,
        expect.any(Object),
      );
    });

    it("should handle empty config object", () => {
      client = new StreetEasyClient({});
      expect(GraphQLClient).toHaveBeenCalledWith(
        "https://api-v6.streeteasy.com/",
        expect.any(Object),
      );
    });

    it("should handle undefined config", () => {
      client = new StreetEasyClient(undefined);
      expect(GraphQLClient).toHaveBeenCalledWith(
        "https://api-v6.streeteasy.com/",
        expect.any(Object),
      );
    });
  });

  describe("request", () => {
    beforeEach(() => {
      client = new StreetEasyClient();
    });

    it("should make successful request", async () => {
      const mockResponse = {
        searchRentals: {
          totalCount: 1,
          edges: [],
        },
      };

      const mockClient = {
        request: jest.fn().mockResolvedValue(mockResponse),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const response = await client.request(SEARCH_RENTALS_QUERY, {
        filters: {},
      });

      expect(response).toEqual(mockResponse);
      expect(mockClient.request).toHaveBeenCalledWith(SEARCH_RENTALS_QUERY, {
        filters: {},
      });
    });

    it("should handle Error objects", async () => {
      const mockClient = {
        request: jest.fn().mockRejectedValue(new Error("API Error")),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      await expect(
        client.request(SEARCH_RENTALS_QUERY, { filters: {} }),
      ).rejects.toThrow("StreetEasy GraphQL Error: API Error");
    });

    it("should handle string errors", async () => {
      const mockClient = {
        request: jest.fn().mockRejectedValue("String error message"),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      await expect(client.request(SEARCH_RENTALS_QUERY)).rejects.toThrow(
        "StreetEasy GraphQL Error: String error message",
      );
    });

    it("should handle null/undefined errors", async () => {
      const mockClient = {
        request: jest.fn().mockRejectedValue(null),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      await expect(client.request(SEARCH_RENTALS_QUERY)).rejects.toThrow(
        "StreetEasy GraphQL Error: null",
      );
    });

    it("should handle ClientError with validation errors", async () => {
      const validationError = new ClientError(
        "invalid type for variable: 'input'",
        {
          errors: [
            {
              message: "invalid type for variable: 'input'",
              extensions: {
                name: "input",
                code: "VALIDATION_INVALID_TYPE_VARIABLE",
              },
            },
          ],
          status: 400,
          headers: {},
        },
        {
          query: SEARCH_RENTALS_QUERY,
          variables: {
            input: {
              /* invalid data */
            },
          },
        },
      );

      const mockClient = {
        request: jest.fn().mockRejectedValue(validationError),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      await expect(
        client.request(SEARCH_RENTALS_QUERY, {
          input: {
            /* invalid data */
          },
        }),
      ).rejects.toThrow(
        "StreetEasy GraphQL Error: invalid type for variable: 'input'",
      );
    });
  });

  describe("searchRentals", () => {
    beforeEach(() => {
      client = new StreetEasyClient();
    });

    it("should make rental search request", async () => {
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          searchRentals: {
            totalCount: 1,
            edges: [],
          },
        }),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const params = {
        filters: {},
      };

      const response = await client.searchRentals(params);

      expect(response.searchRentals).toBeDefined();
      expect(mockClient.request).toHaveBeenCalledWith(SEARCH_RENTALS_QUERY, {
        input: {
          ...params,
          adStrategy: "NONE",
          userSearchToken: "mock-uuid",
        },
      });
    });

    it("should handle search errors", async () => {
      const mockClient = {
        request: jest.fn().mockRejectedValue(new Error("API Error")),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const params = {
        filters: {},
      };

      await expect(client.searchRentals(params)).rejects.toThrow(
        "StreetEasy GraphQL Error: API Error",
      );
    });

    it("should set adStrategy to 'NONE' by default", async () => {
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          searchRentals: {
            totalCount: 1,
            edges: [],
          },
        }),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const params = {
        filters: {},
      };

      await client.searchRentals(params);

      expect(mockClient.request).toHaveBeenCalledWith(SEARCH_RENTALS_QUERY, {
        input: {
          ...params,
          adStrategy: "NONE",
          userSearchToken: "mock-uuid",
        },
      });
    });

    it("should not override adStrategy if already provided", async () => {
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          searchRentals: {
            totalCount: 1,
            edges: [],
          },
        }),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const params = {
        filters: {},
        adStrategy: "NONE" as const,
      };

      await client.searchRentals(params);

      expect(mockClient.request).toHaveBeenCalledWith(SEARCH_RENTALS_QUERY, {
        input: {
          ...params,
          userSearchToken: "mock-uuid",
        },
      });
    });

    it("should not override userSearchToken if already provided", async () => {
      const mockClient = {
        request: jest.fn().mockResolvedValue({
          searchRentals: {
            totalCount: 1,
            edges: [],
          },
        }),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const params = {
        filters: {},
        userSearchToken: "custom-token",
      };

      await client.searchRentals(params);

      expect(mockClient.request).toHaveBeenCalledWith(SEARCH_RENTALS_QUERY, {
        input: {
          ...params,
          adStrategy: "NONE",
        },
      });
    });

    // Additional tests for the new federated search rentals query structure

    describe("Federated search edge types", () => {
      beforeEach(() => {
        client = new StreetEasyClient();
      });

      it("should handle OrganicRentalEdge type correctly", async () => {
        const mockResponse = {
          searchRentals: {
            __typename: "SearchRentals",
            edges: [
              {
                __typename: "OrganicRentalEdge",
                node: {
                  __typename: "SearchRentalListing",
                  id: "123",
                  areaName: "Manhattan",
                  availableAt: "2023-12-15",
                  bedroomCount: 2,
                  buildingType: "RENTAL",
                  fullBathroomCount: 1,
                  furnished: false,
                  geoPoint: {
                    __typename: "GeoPoint",
                    latitude: 40.7128,
                    longitude: -74.006,
                  },
                  halfBathroomCount: 0,
                  hasTour3d: false,
                  hasVideos: false,
                  isNewDevelopment: false,
                  leadMedia: {
                    __typename: "LeadMedia",
                    photo: {
                      __typename: "LeadMediaPhoto",
                      key: "photo123",
                    },
                  },
                  leaseTermMonths: 12,
                  livingAreaSize: 800,
                  mediaAssetCount: 5,
                  monthsFree: null,
                  noFee: true,
                  netEffectivePrice: null,
                  offMarketAt: null,
                  photos: [
                    {
                      __typename: "LeadMediaPhoto",
                      key: "photo123",
                    },
                  ],
                  price: 3000,
                  priceChangedAt: null,
                  priceDelta: null,
                  slug: "2br-manhattan-apt",
                  sourceGroupLabel: "Agency",
                  sourceType: "BROKER",
                  status: "ACTIVE",
                  street: "123 Main St",
                  unit: "4B",
                  upcomingOpenHouse: null,
                  urlPath: "/rental/123",
                },
                amenitiesMatch: true,
                matchedAmenities: ["DISHWASHER", "ELEVATOR"],
                missingAmenities: [],
              },
            ],
            totalCount: 1,
          },
        };

        const mockClient = {
          request: jest.fn().mockResolvedValue(mockResponse),
        };

        (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

        client = new StreetEasyClient();
        const params = {
          filters: {},
        };

        const response = await client.searchRentals(params);

        expect(response.searchRentals.edges.length).toBe(1);
        const edge = response.searchRentals.edges[0];
        expect(edge.__typename).toBe("OrganicRentalEdge");

        // Verify we can access OrganicRentalEdge specific properties
        if (isOrganicOrFeaturedEdge(edge)) {
          expect(edge.amenitiesMatch).toBe(true);
          expect(edge.matchedAmenities).toContain("DISHWASHER");
          expect(edge.missingAmenities?.length).toBe(0);
        } else {
          fail("Edge should be recognized as OrganicRentalEdge");
        }

        // Verify we can access node properties
        expect(edge.node.id).toBe("123");
        expect(edge.node.price).toBe(3000);
        expect(edge.node.noFee).toBe(true);
      });

      it("should handle FeaturedRentalEdge type correctly", async () => {
        const mockResponse = {
          searchRentals: {
            __typename: "SearchRentals",
            edges: [
              {
                __typename: "FeaturedRentalEdge",
                node: {
                  __typename: "SearchRentalListing",
                  id: "456",
                  areaName: "Brooklyn",
                  availableAt: "2023-11-01",
                  bedroomCount: 1,
                  buildingType: "CONDO",
                  fullBathroomCount: 1,
                  furnished: true,
                  geoPoint: {
                    __typename: "GeoPoint",
                    latitude: 40.6782,
                    longitude: -73.9442,
                  },
                  halfBathroomCount: 0,
                  hasTour3d: true,
                  hasVideos: true,
                  isNewDevelopment: true,
                  leadMedia: {
                    __typename: "LeadMedia",
                    photo: {
                      __typename: "LeadMediaPhoto",
                      key: "photo456",
                    },
                  },
                  leaseTermMonths: 24,
                  livingAreaSize: 650,
                  mediaAssetCount: 10,
                  monthsFree: 1,
                  noFee: false,
                  netEffectivePrice: 2750,
                  offMarketAt: null,
                  photos: [
                    {
                      __typename: "LeadMediaPhoto",
                      key: "photo456",
                    },
                  ],
                  price: 3000,
                  priceChangedAt: "2023-10-15",
                  priceDelta: -200,
                  slug: "1br-brooklyn-apt",
                  sourceGroupLabel: "Developer",
                  sourceType: "DEVELOPER",
                  status: "ACTIVE",
                  street: "456 Park Ave",
                  unit: "2A",
                  upcomingOpenHouse: {
                    __typename: "OpenHouseDigest",
                    startTime: "2023-10-20T12:00:00Z",
                    endTime: "2023-10-20T14:00:00Z",
                    appointmentOnly: false,
                  },
                  urlPath: "/rental/456",
                },
                amenitiesMatch: false,
                matchedAmenities: [],
                missingAmenities: ["DOORMAN"],
              },
            ],
            totalCount: 1,
          },
        };

        const mockClient = {
          request: jest.fn().mockResolvedValue(mockResponse),
        };

        (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

        client = new StreetEasyClient();
        const params = {
          filters: {},
        };

        const response = await client.searchRentals(params);

        expect(response.searchRentals.edges.length).toBe(1);
        const edge = response.searchRentals.edges[0];
        expect(edge.__typename).toBe("FeaturedRentalEdge");

        // Verify we can access FeaturedRentalEdge specific properties
        if (isOrganicOrFeaturedEdge(edge)) {
          expect(edge.amenitiesMatch).toBe(false);
          expect(edge.matchedAmenities?.length).toBe(0);
          expect(edge.missingAmenities).toContain("DOORMAN");
        } else {
          fail("Edge should be recognized as FeaturedRentalEdge");
        }

        // Verify we can access new node properties
        expect(edge.node.id).toBe("456");
        expect(edge.node.furnished).toBe(true);
        expect(edge.node.hasTour3d).toBe(true);
        expect(edge.node.monthsFree).toBe(1);
        expect(edge.node.netEffectivePrice).toBe(2750);
        expect(edge.node.upcomingOpenHouse).toBeDefined();
        expect(edge.node.upcomingOpenHouse?.appointmentOnly).toBe(false);
      });

      it("should handle SponsoredRentalEdge type correctly", async () => {
        const mockResponse = {
          searchRentals: {
            __typename: "SearchRentals",
            edges: [
              {
                __typename: "SponsoredRentalEdge",
                node: {
                  __typename: "SearchRentalListing",
                  id: "789",
                  areaName: "Queens",
                  availableAt: null,
                  bedroomCount: 3,
                  buildingType: "MULTI_FAMILY",
                  fullBathroomCount: 2,
                  furnished: false,
                  geoPoint: {
                    __typename: "GeoPoint",
                    latitude: 40.7282,
                    longitude: -73.7949,
                  },
                  halfBathroomCount: 1,
                  hasTour3d: false,
                  hasVideos: false,
                  isNewDevelopment: false,
                  leadMedia: {
                    __typename: "LeadMedia",
                    photo: {
                      __typename: "LeadMediaPhoto",
                      key: "photo789",
                    },
                  },
                  leaseTermMonths: null,
                  livingAreaSize: 1200,
                  mediaAssetCount: 3,
                  monthsFree: null,
                  noFee: false,
                  netEffectivePrice: null,
                  offMarketAt: null,
                  photos: [
                    {
                      __typename: "LeadMediaPhoto",
                      key: "photo789",
                    },
                  ],
                  price: 4000,
                  priceChangedAt: null,
                  priceDelta: null,
                  slug: "3br-queens-apt",
                  sourceGroupLabel: "Premium Agency",
                  sourceType: "PREMIUM_BROKER",
                  status: "ACTIVE",
                  street: "789 Broadway",
                  unit: "3C",
                  upcomingOpenHouse: null,
                  urlPath: "/rental/789",
                },
                sponsoredSimilarityLabel: "Sponsored Result",
              },
            ],
            totalCount: 1,
          },
        };

        const mockClient = {
          request: jest.fn().mockResolvedValue(mockResponse),
        };

        (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

        client = new StreetEasyClient();
        const params = {
          filters: {},
        };

        const response = await client.searchRentals(params);

        expect(response.searchRentals.edges.length).toBe(1);
        const edge = response.searchRentals.edges[0];
        expect(edge.__typename).toBe("SponsoredRentalEdge");

        // Verify we can access SponsoredRentalEdge specific properties
        if (isSponsoredEdge(edge)) {
          expect(edge.sponsoredSimilarityLabel).toBe("Sponsored Result");
        } else {
          fail("Edge should be recognized as SponsoredRentalEdge");
        }

        // Verify type guard works as expected
        expect(isOrganicOrFeaturedEdge(edge)).toBe(false);
        expect(isSponsoredEdge(edge)).toBe(true);

        // Verify we can access node properties
        expect(edge.node.id).toBe("789");
        expect(edge.node.bedroomCount).toBe(3);
        expect(edge.node.fullBathroomCount).toBe(2);
      });

      it("should handle mixed edge types in search results", async () => {
        const mockResponse = {
          searchRentals: {
            __typename: "SearchRentals",
            edges: [
              {
                __typename: "OrganicRentalEdge",
                node: {
                  __typename: "SearchRentalListing",
                  id: "123",
                  areaName: "Manhattan",
                  availableAt: "2023-12-15",
                  bedroomCount: 2,
                  buildingType: "RENTAL",
                  fullBathroomCount: 1,
                  furnished: false,
                  geoPoint: {
                    __typename: "GeoPoint",
                    latitude: 40.7128,
                    longitude: -74.006,
                  },
                  halfBathroomCount: 0,
                  hasTour3d: false,
                  hasVideos: false,
                  isNewDevelopment: false,
                  leadMedia: {
                    __typename: "LeadMedia",
                    photo: {
                      __typename: "LeadMediaPhoto",
                      key: "photo123",
                    },
                  },
                  leaseTermMonths: 12,
                  livingAreaSize: 800,
                  mediaAssetCount: 5,
                  monthsFree: null,
                  noFee: true,
                  netEffectivePrice: null,
                  offMarketAt: null,
                  photos: [
                    {
                      __typename: "LeadMediaPhoto",
                      key: "photo123",
                    },
                  ],
                  price: 3000,
                  priceChangedAt: null,
                  priceDelta: null,
                  slug: "2br-manhattan-apt",
                  sourceGroupLabel: "Agency",
                  sourceType: "BROKER",
                  status: "ACTIVE",
                  street: "123 Main St",
                  unit: "4B",
                  upcomingOpenHouse: null,
                  urlPath: "/rental/123",
                },
                amenitiesMatch: true,
                matchedAmenities: ["DISHWASHER"],
                missingAmenities: [],
              },
              {
                __typename: "SponsoredRentalEdge",
                node: {
                  __typename: "SearchRentalListing",
                  id: "789",
                  areaName: "Queens",
                  availableAt: null,
                  bedroomCount: 3,
                  buildingType: "MULTI_FAMILY",
                  fullBathroomCount: 2,
                  furnished: false,
                  geoPoint: {
                    __typename: "GeoPoint",
                    latitude: 40.7282,
                    longitude: -73.7949,
                  },
                  halfBathroomCount: 1,
                  hasTour3d: false,
                  hasVideos: false,
                  isNewDevelopment: false,
                  leadMedia: {
                    __typename: "LeadMedia",
                    photo: {
                      __typename: "LeadMediaPhoto",
                      key: "photo789",
                    },
                  },
                  leaseTermMonths: null,
                  livingAreaSize: 1200,
                  mediaAssetCount: 3,
                  monthsFree: null,
                  noFee: false,
                  netEffectivePrice: null,
                  offMarketAt: null,
                  photos: [
                    {
                      __typename: "LeadMediaPhoto",
                      key: "photo789",
                    },
                  ],
                  price: 4000,
                  priceChangedAt: null,
                  priceDelta: null,
                  slug: "3br-queens-apt",
                  sourceGroupLabel: "Premium Agency",
                  sourceType: "PREMIUM_BROKER",
                  status: "ACTIVE",
                  street: "789 Broadway",
                  unit: "3C",
                  upcomingOpenHouse: null,
                  urlPath: "/rental/789",
                },
                sponsoredSimilarityLabel: "Sponsored Result",
              },
              {
                __typename: "FeaturedRentalEdge",
                node: {
                  __typename: "SearchRentalListing",
                  id: "456",
                  areaName: "Brooklyn",
                  availableAt: "2023-11-01",
                  bedroomCount: 1,
                  buildingType: "CONDO",
                  fullBathroomCount: 1,
                  furnished: true,
                  geoPoint: {
                    __typename: "GeoPoint",
                    latitude: 40.6782,
                    longitude: -73.9442,
                  },
                  halfBathroomCount: 0,
                  hasTour3d: true,
                  hasVideos: true,
                  isNewDevelopment: true,
                  leadMedia: {
                    __typename: "LeadMedia",
                    photo: {
                      __typename: "LeadMediaPhoto",
                      key: "photo456",
                    },
                  },
                  leaseTermMonths: 24,
                  livingAreaSize: 650,
                  mediaAssetCount: 10,
                  monthsFree: 1,
                  noFee: false,
                  netEffectivePrice: 2750,
                  offMarketAt: null,
                  photos: [
                    {
                      __typename: "LeadMediaPhoto",
                      key: "photo456",
                    },
                  ],
                  price: 3000,
                  priceChangedAt: "2023-10-15",
                  priceDelta: -200,
                  slug: "1br-brooklyn-apt",
                  sourceGroupLabel: "Developer",
                  sourceType: "DEVELOPER",
                  status: "ACTIVE",
                  street: "456 Park Ave",
                  unit: "2A",
                  upcomingOpenHouse: {
                    __typename: "OpenHouseDigest",
                    startTime: "2023-10-20T12:00:00Z",
                    endTime: "2023-10-20T14:00:00Z",
                    appointmentOnly: false,
                  },
                  urlPath: "/rental/456",
                },
                amenitiesMatch: false,
                matchedAmenities: [],
                missingAmenities: ["DOORMAN"],
              },
            ],
            totalCount: 3,
          },
        };

        const mockClient = {
          request: jest.fn().mockResolvedValue(mockResponse),
        };

        (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

        client = new StreetEasyClient();
        const params = {
          filters: {},
        };

        const response = await client.searchRentals(params);

        expect(response.searchRentals.edges.length).toBe(3);

        // Process each edge by type
        let organicCount = 0;
        let featuredCount = 0;
        let sponsoredCount = 0;

        response.searchRentals.edges.forEach((edge) => {
          if (edge.__typename === "OrganicRentalEdge") {
            organicCount++;
            expect(isOrganicOrFeaturedEdge(edge)).toBe(true);
            expect(isSponsoredEdge(edge)).toBe(false);
          } else if (edge.__typename === "FeaturedRentalEdge") {
            featuredCount++;
            expect(isOrganicOrFeaturedEdge(edge)).toBe(true);
            expect(isSponsoredEdge(edge)).toBe(false);
          } else if (edge.__typename === "SponsoredRentalEdge") {
            sponsoredCount++;
            expect(isOrganicOrFeaturedEdge(edge)).toBe(false);
            expect(isSponsoredEdge(edge)).toBe(true);
          }
        });

        expect(organicCount).toBe(1);
        expect(featuredCount).toBe(1);
        expect(sponsoredCount).toBe(1);
      });

      it("should handle new fields in rental listings", async () => {
        const mockResponse = {
          searchRentals: {
            __typename: "SearchRentals",
            edges: [
              {
                __typename: "OrganicRentalEdge",
                node: {
                  __typename: "SearchRentalListing",
                  id: "123",
                  areaName: "Manhattan",
                  availableAt: "2023-12-15",
                  bedroomCount: 2,
                  buildingType: "RENTAL",
                  fullBathroomCount: 1,
                  furnished: true,
                  geoPoint: {
                    __typename: "GeoPoint",
                    latitude: 40.7128,
                    longitude: -74.006,
                  },
                  halfBathroomCount: 0,
                  hasTour3d: true,
                  hasVideos: true,
                  isNewDevelopment: true,
                  leadMedia: {
                    __typename: "LeadMedia",
                    photo: {
                      __typename: "LeadMediaPhoto",
                      key: "photo123",
                    },
                    floorPlan: {
                      __typename: "LeadMediaFloorPlan",
                      key: "floorplan123",
                    },
                  },
                  leaseTermMonths: 12,
                  livingAreaSize: 800,
                  mediaAssetCount: 5,
                  monthsFree: 1,
                  noFee: true,
                  netEffectivePrice: 2750,
                  offMarketAt: null,
                  photos: [
                    {
                      __typename: "LeadMediaPhoto",
                      key: "photo123",
                    },
                  ],
                  price: 3000,
                  priceChangedAt: "2023-10-01",
                  priceDelta: -200,
                  slug: "2br-manhattan-apt",
                  sourceGroupLabel: "Agency",
                  sourceType: "BROKER",
                  status: "ACTIVE",
                  street: "123 Main St",
                  unit: "4B",
                  upcomingOpenHouse: {
                    __typename: "OpenHouseDigest",
                    startTime: "2023-10-20T10:00:00Z",
                    endTime: "2023-10-20T12:00:00Z",
                    appointmentOnly: true,
                  },
                  urlPath: "/rental/123",
                },
                amenitiesMatch: true,
                matchedAmenities: ["DISHWASHER", "ELEVATOR"],
                missingAmenities: [],
              },
            ],
            totalCount: 1,
          },
        };

        const mockClient = {
          request: jest.fn().mockResolvedValue(mockResponse),
        };

        (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

        client = new StreetEasyClient();
        const params = {
          filters: {},
        };

        const response = await client.searchRentals(params);

        const listing = response.searchRentals.edges[0].node;

        // Test all new fields
        expect(listing.availableAt).toBe("2023-12-15");
        expect(listing.furnished).toBe(true);
        expect(listing.hasTour3d).toBe(true);
        expect(listing.hasVideos).toBe(true);
        expect(listing.isNewDevelopment).toBe(true);
        expect(listing.leadMedia.floorPlan).toBeDefined();
        expect(listing.leadMedia.floorPlan?.key).toBe("floorplan123");
        expect(listing.leaseTermMonths).toBe(12);
        expect(listing.livingAreaSize).toBe(800);
        expect(listing.mediaAssetCount).toBe(5);
        expect(listing.monthsFree).toBe(1);
        expect(listing.netEffectivePrice).toBe(2750);
        expect(listing.priceChangedAt).toBe("2023-10-01");
        expect(listing.priceDelta).toBe(-200);
        expect(listing.slug).toBe("2br-manhattan-apt");
        expect(listing.sourceType).toBe("BROKER");
        expect(listing.status).toBe("ACTIVE");
        expect(listing.upcomingOpenHouse).toBeDefined();
        expect(listing.upcomingOpenHouse?.appointmentOnly).toBe(true);
      });
    });

    describe("Type Guards", () => {
      it("should correctly identify OrganicRentalEdge", () => {
        const edge = { __typename: "OrganicRentalEdge" };
        expect(isOrganicOrFeaturedEdge(edge)).toBe(true);
        expect(isSponsoredEdge(edge)).toBe(false);
      });

      it("should correctly identify FeaturedRentalEdge", () => {
        const edge = { __typename: "FeaturedRentalEdge" };
        expect(isOrganicOrFeaturedEdge(edge)).toBe(true);
        expect(isSponsoredEdge(edge)).toBe(false);
      });

      it("should correctly identify SponsoredRentalEdge", () => {
        const edge = { __typename: "SponsoredRentalEdge" };
        expect(isOrganicOrFeaturedEdge(edge)).toBe(false);
        expect(isSponsoredEdge(edge)).toBe(true);
      });

      it("should handle unknown edge types gracefully", () => {
        const edge = { __typename: "UnknownEdgeType" };
        expect(isOrganicOrFeaturedEdge(edge)).toBe(false);
        expect(isSponsoredEdge(edge)).toBe(false);
      });
    });

    describe("Error handling", () => {
      it("should handle incomplete edge data gracefully", async () => {
        const mockResponse = {
          searchRentals: {
            __typename: "SearchRentals",
            edges: [
              {
                __typename: "OrganicRentalEdge",
                // Missing amenitiesMatch, matchedAmenities, missingAmenities
                node: {
                  __typename: "SearchRentalListing",
                  id: "123",
                  areaName: "Manhattan",
                  bedroomCount: 2,
                  buildingType: "RENTAL",
                  fullBathroomCount: 1,
                  geoPoint: {
                    __typename: "GeoPoint",
                    latitude: 40.7128,
                    longitude: -74.006,
                  },
                  halfBathroomCount: 0,
                  leadMedia: {
                    __typename: "LeadMedia",
                    photo: {
                      __typename: "LeadMediaPhoto",
                      key: "photo123",
                    },
                  },
                  noFee: true,
                  price: 3000,
                  sourceGroupLabel: "Agency",
                  street: "123 Main St",
                  unit: "4B",
                  urlPath: "/rental/123",
                },
              },
            ],
            totalCount: 1,
          },
        };

        const mockClient = {
          request: jest.fn().mockResolvedValue(mockResponse),
        };

        (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

        client = new StreetEasyClient();
        const params = {
          filters: {},
        };

        // This should not throw even though the data is incomplete
        const response = await client.searchRentals(params);

        expect(response.searchRentals.edges.length).toBe(1);
        const edge = response.searchRentals.edges[0] as any;

        // We can still access the node data
        expect(edge.node.id).toBe("123");
        expect(edge.node.price).toBe(3000);

        // But edge-specific properties might be undefined
        expect(edge.amenitiesMatch).toBeUndefined();
        expect(edge.matchedAmenities).toBeUndefined();
      });

      it("should handle unknown edge types gracefully", async () => {
        const mockResponse = {
          searchRentals: {
            __typename: "SearchRentals",
            edges: [
              {
                __typename: "UnknownRentalEdge",
                node: {
                  __typename: "SearchRentalListing",
                  id: "123",
                  areaName: "Manhattan",
                  bedroomCount: 2,
                  buildingType: "RENTAL",
                  fullBathroomCount: 1,
                  geoPoint: {
                    __typename: "GeoPoint",
                    latitude: 40.7128,
                    longitude: -74.006,
                  },
                  halfBathroomCount: 0,
                  leadMedia: {
                    __typename: "LeadMedia",
                    photo: {
                      __typename: "LeadMediaPhoto",
                      key: "photo123",
                    },
                  },
                  noFee: true,
                  price: 3000,
                  sourceGroupLabel: "Agency",
                  street: "123 Main St",
                  unit: "4B",
                  urlPath: "/rental/123",
                },
                someProperty: "some value",
              },
            ],
            totalCount: 1,
          },
        };

        const mockClient = {
          request: jest.fn().mockResolvedValue(mockResponse),
        };

        (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

        client = new StreetEasyClient();
        const params = {
          filters: {},
        };

        // This should not throw even with an unknown edge type
        const response = await client.searchRentals(params);

        expect(response.searchRentals.edges.length).toBe(1);
        const edge = response.searchRentals.edges[0] as any;

        // Type guards should return false
        expect(isOrganicOrFeaturedEdge(edge)).toBe(false);
        expect(isSponsoredEdge(edge)).toBe(false);

        // But node data should still be accessible
        expect(edge.node.id).toBe("123");
        expect(edge.node.price).toBe(3000);

        // And custom properties on the unknown edge type
        expect(edge.someProperty).toBe("some value");
      });
    });
  });

  describe("getRentalListingDetails", () => {
    beforeEach(() => {
      client = new StreetEasyClient();
    });

    it("should fetch rental listing details", async () => {
      const mockResponse = {
        rentalByListingId: {
          id: "4652509",
          status: "ACTIVE",
          propertyDetails: {
            address: {
              street: "123 Main St",
              unit: "4B",
            },
            bedroomCount: 2,
            fullBathroomCount: 1,
            halfBathroomCount: 0,
          },
          pricing: {
            price: 3500,
            noFee: true,
          },
        },
        buildingByRentalListingId: {
          name: "Test Building",
          type: "CONDO",
          area: {
            name: "Manhattan",
          },
        },
      };

      const mockClient = {
        request: jest.fn().mockResolvedValue(mockResponse),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const listingID = "4652509";

      const response = await client.getRentalListingDetails(listingID);

      expect(response).toEqual(mockResponse);
      expect(mockClient.request).toHaveBeenCalledWith(
        RENTAL_LISTING_DETAILS_QUERY,
        { listingID },
      );
    });

    it("should handle errors when fetching rental details", async () => {
      const mockClient = {
        request: jest.fn().mockRejectedValue(new Error("API Error")),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const listingID = "4652509";

      await expect(client.getRentalListingDetails(listingID)).rejects.toThrow(
        "StreetEasy GraphQL Error: API Error",
      );
    });

    it("should handle partial or missing data in the response", async () => {
      // Mock response with some null or missing fields
      const mockResponse = {
        rentalByListingId: {
          id: "4652509",
          status: "ACTIVE",
          offMarketAt: null,
          availableAt: null,
          propertyDetails: {
            address: {
              street: "123 Main St",
              unit: null,
            },
            bedroomCount: 2,
            fullBathroomCount: 1,
            halfBathroomCount: 0,
          },
          pricing: {
            price: 3500,
            noFee: true,
          },
          media: {
            photos: [],
            floorPlans: null,
          },
        },
        buildingByRentalListingId: {
          name: "Test Building",
          type: "CONDO",
          area: {
            name: "Manhattan",
          },
        },
        getRelloRentalById: null,
      };

      const mockClient = {
        request: jest.fn().mockResolvedValue(mockResponse),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const listingID = "4652509";

      const response = await client.getRentalListingDetails(listingID);

      expect(response).toEqual(mockResponse);
      // Verify we can handle null values
      expect(response.rentalByListingId.offMarketAt).toBeNull();
      expect(
        response.rentalByListingId.propertyDetails.address.unit,
      ).toBeNull();
      expect(response.rentalByListingId.media.floorPlans).toBeNull();
      expect(response.getRelloRentalById).toBeNull();
    });

    it("should pass the correct listing ID to the request", async () => {
      const mockResponse = { data: "test" };
      const mockClient = {
        request: jest.fn().mockResolvedValue(mockResponse),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();

      // Test with a numeric listing ID as string
      await client.getRentalListingDetails("12345");
      expect(mockClient.request).toHaveBeenCalledWith(
        RENTAL_LISTING_DETAILS_QUERY,
        { listingID: "12345" },
      );

      // Reset the mock and test with another ID
      mockClient.request.mockClear();
      await client.getRentalListingDetails("abc-123");
      expect(mockClient.request).toHaveBeenCalledWith(
        RENTAL_LISTING_DETAILS_QUERY,
        { listingID: "abc-123" },
      );
    });

    it("should handle a complete response with all nested objects", async () => {
      // Mock a complete response with all nested objects from the schema
      const mockResponse = {
        rentalByListingId: {
          __typename: "RentalListing",
          id: "4652509",
          offMarketAt: null,
          availableAt: "2024-05-15",
          buildingId: "12345",
          status: "ACTIVE",
          statusChanges: [
            {
              __typename: "RentalStatusChange",
              status: "ACTIVE",
              changedAt: "2024-04-01T12:00:00Z",
            },
          ],
          createdAt: "2024-04-01T12:00:00Z",
          updatedAt: "2024-04-01T12:00:00Z",
          interestingChangeAt: "2024-04-01T12:00:00Z",
          description: "Nice apartment",
          media: {
            __typename: "Media",
            photos: [
              {
                __typename: "Photo",
                key: "photo1",
              },
            ],
            floorPlans: [
              {
                __typename: "FloorPlan",
                key: "floorplan1",
              },
            ],
            videos: [],
            tour3dUrl: null,
            assetCount: 2,
          },
          propertyDetails: {
            __typename: "PropertyDetails",
            address: {
              __typename: "Address",
              street: "123 Main St",
              houseNumber: "123",
              streetName: "Main St",
              city: "New York",
              state: "NY",
              zipCode: "10001",
              unit: "4B",
            },
            roomCount: 3,
            bedroomCount: 1,
            fullBathroomCount: 1,
            halfBathroomCount: 0,
            livingAreaSize: 750,
            amenities: {
              __typename: "BuildingAmenities",
              list: ["DOORMAN", "ELEVATOR"],
              doormanTypes: [],
              parkingTypes: [],
              sharedOutdoorSpaceTypes: [],
              storageSpaceTypes: [],
            },
            features: {
              __typename: "PropertyFeatures",
              list: ["HARDWOOD_FLOORS", "DISHWASHER"],
              fireplaceTypes: [],
              privateOutdoorSpaceTypes: [],
              views: [],
            },
          },
          mlsNumber: null,
          backOffice: {
            __typename: "RentalBackOffice",
            brokerageListingId: null,
          },
          pricing: {
            __typename: "RentalPricing",
            leaseTermMonths: 12,
            monthsFree: null,
            noFee: true,
            price: 3500,
            priceDelta: null,
            priceChanges: [],
          },
          recentListingsPriceStats: {
            __typename: "NeighborhoodPriceStats",
            rentalPriceStats: {
              __typename: "PriceStats",
              medianPrice: 3400,
            },
            salePriceStats: {
              __typename: "PriceStats",
              medianPrice: 750000,
            },
          },
          upcomingOpenHouses: [],
          listingSource: {
            __typename: "ListingSource",
            sourceType: "BROKER",
          },
          propertyHistory: [],
        },
        buildingByRentalListingId: {
          __typename: "Building",
          id: "12345",
          name: "The Building",
          type: "CONDO",
          residentialUnitCount: 100,
          yearBuilt: 2000,
          status: "COMPLETED",
          additionalDetails: {
            __typename: "BuildingAdditionalDetails",
            leasingStartDate: null,
            salesStartDate: null,
          },
          address: {
            __typename: "Address",
            street: "123 Main St",
            city: "New York",
            state: "NY",
            zipCode: "10001",
          },
          heroImage: null,
          media: {
            __typename: "Media",
            photos: [],
          },
          complex: null,
          area: {
            __typename: "Area",
            name: "Manhattan",
          },
          saleInventorySummary: {
            __typename: "SaleInventorySummary",
            availableListingDigests: [],
          },
          rentalInventorySummary: {
            __typename: "RentalInventorySummary",
            availableListingDigests: [],
          },
          isLandLease: null,
          policies: null,
          nearby: {
            __typename: "Nearby",
            transitStations: [],
          },
        },
        getBuildingExpressByRentalListingId: {
          __typename: "BuildingExpress",
          nearbySchools: [],
        },
        getRelloRentalById: null,
        getRentalListingExpressById: {
          __typename: "RentalListingExpress",
          hasActiveBuildingShowcase: false,
        },
      };

      const mockClient = {
        request: jest.fn().mockResolvedValue(mockResponse),
      };

      (GraphQLClient as jest.Mock).mockImplementation(() => mockClient);

      client = new StreetEasyClient();
      const listingID = "4652509";

      const response = await client.getRentalListingDetails(listingID);

      expect(response).toEqual(mockResponse);
      // Verify we can access all the nested properties
      expect(response.rentalByListingId.id).toBe("4652509");
      expect(response.rentalByListingId.propertyDetails.address.city).toBe(
        "New York",
      );
      expect(response.rentalByListingId.media.photos[0].key).toBe("photo1");
      expect(response.buildingByRentalListingId.type).toBe("CONDO");
      expect(
        response.getRentalListingExpressById.hasActiveBuildingShowcase,
      ).toBe(false);
    });
  });
});
