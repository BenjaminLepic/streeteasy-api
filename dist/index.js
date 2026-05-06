"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreetEasyClient = void 0;
const graphql_request_1 = require("graphql-request");
const queries_1 = require("./queries");
const uuid_1 = require("uuid");
class StreetEasyClient {
    constructor(config = {}) {
        this.endpoint = "https://api-v6.streeteasy.com/";
        this.client = new graphql_request_1.GraphQLClient(config.endpoint || this.endpoint, {
            headers: {
                Host: "api-v6.streeteasy.com",
                Connection: "keep-alive",
                "Sec-Ch-Ua-Platform": '"macOS"',
                "X-Forwarded-Proto": "https",
                "Sec-Ch-Ua": '"Chromium";v="133", "Not(A:Brand";v="99"',
                "Sec-Ch-Ua-Mobile": "?0",
                "App-Version": "1.0.0",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
                Accept: "application/json",
                "Apollographql-Client-Version": "version  50bef71ef923e981bdcb7c781851c3bfdb12a0c1",
                "Apollographql-Client-Name": "srp-frontend-service",
                Os: "web",
                Dnt: "1",
                Origin: "https://streeteasy.com",
                "Sec-Fetch-Site": "same-site",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Dest": "empty",
                Referer: "https://streeteasy.com/",
                "Accept-Language": "en-US,en;q=0.9",
                "Content-Type": "application/json",
            },
        });
    }
    /**
     * Execute a GraphQL query
     * @param document The GraphQL query or mutation
     * @param variables Optional variables for the query
     * @returns The query result
     */
    async request(document, variables) {
        try {
            const response = await this.client.request(document, variables);
            return response;
        }
        catch (error) {
            if (error instanceof Error) {
                throw new Error(`StreetEasy GraphQL Error: ${error.message}`);
            }
            // Handle non-Error objects by converting them to a string
            throw new Error(`StreetEasy GraphQL Error: ${String(error)}`);
        }
    }
    /**
     * Search for rental listings
     * @param input Search parameters
     * @returns Search results
     */
    async searchRentals(input) {
        // Set default adStrategy to 'NONE' if not provided
        // Set default userSearchToken to a UUID if not provided
        const inputWithDefaults = {
            ...input,
            adStrategy: input.adStrategy || "NONE",
            userSearchToken: input.userSearchToken || (0, uuid_1.v4)(),
        };
        return this.request(queries_1.SEARCH_RENTALS_QUERY, {
            input: inputWithDefaults,
        });
    }
    /**
     * Get detailed information about a specific rental listing
     * @param listingID The ID of the rental listing to fetch
     * @returns Detailed rental listing information
     */
    async getRentalListingDetails(listingID) {
        return this.request(queries_1.RENTAL_LISTING_DETAILS_QUERY, { listingID });
    }
}
exports.StreetEasyClient = StreetEasyClient;
// Export types and constants for external use
__exportStar(require("./types"), exports);
__exportStar(require("./constants"), exports);
