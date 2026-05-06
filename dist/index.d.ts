import { DocumentNode } from "graphql";
import { Variables, SearchRentalsInput, SearchRentalsResponse, RentalListingDetailsResponse } from "./types";
export interface StreetEasyConfig {
    endpoint?: string;
}
export declare class StreetEasyClient {
    private readonly client;
    private readonly endpoint;
    constructor(config?: StreetEasyConfig);
    /**
     * Execute a GraphQL query
     * @param document The GraphQL query or mutation
     * @param variables Optional variables for the query
     * @returns The query result
     */
    request<TData>(document: string | DocumentNode, variables?: Variables): Promise<TData>;
    /**
     * Search for rental listings
     * @param input Search parameters
     * @returns Search results
     */
    searchRentals(input: SearchRentalsInput): Promise<SearchRentalsResponse>;
    /**
     * Get detailed information about a specific rental listing
     * @param listingID The ID of the rental listing to fetch
     * @returns Detailed rental listing information
     */
    getRentalListingDetails(listingID: string): Promise<RentalListingDetailsResponse>;
}
export * from "./types";
export * from "./constants";
