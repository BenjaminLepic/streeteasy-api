import { GraphQLClient } from "graphql-request";
import { DocumentNode } from "graphql";
import {
  QueryResponse,
  Variables,
  SearchRentalsInput,
  SearchRentalsResponse,
  RentalListingDetailsResponse,
  RentalListingDetailsVariables,
} from "./types";
import { SEARCH_RENTALS_QUERY, RENTAL_LISTING_DETAILS_QUERY } from "./queries";
import { v4 as uuidv4 } from "uuid";

export interface StreetEasyConfig {
  endpoint?: string;
}

export class StreetEasyClient {
  private readonly client: GraphQLClient;
  private readonly endpoint: string = "https://api-v6.streeteasy.com/";

  constructor(config: StreetEasyConfig = {}) {
    this.client = new GraphQLClient(config.endpoint || this.endpoint, {
      headers: {
        Host: "api-v6.streeteasy.com",
        Connection: "keep-alive",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "X-Forwarded-Proto": "https",
        "Sec-Ch-Ua": '"Chromium";v="133", "Not(A:Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "App-Version": "1.0.0",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        Accept: "application/json",
        "Apollographql-Client-Version":
          "version  50bef71ef923e981bdcb7c781851c3bfdb12a0c1",
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
  public async request<TData>(
    document: string | DocumentNode,
    variables?: Variables,
  ): Promise<TData> {
    try {
      const response = await this.client.request<TData>(document, variables);
      return response;
    } catch (error) {
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
  public async searchRentals(
    input: SearchRentalsInput,
  ): Promise<SearchRentalsResponse> {
    // Set default adStrategy to 'NONE' if not provided
    // Set default userSearchToken to a UUID if not provided
    const inputWithDefaults = {
      ...input,
      adStrategy: input.adStrategy || "NONE",
      userSearchToken: input.userSearchToken || uuidv4(),
    };

    return this.request<SearchRentalsResponse>(SEARCH_RENTALS_QUERY, {
      input: inputWithDefaults,
    });
  }

  /**
   * Get detailed information about a specific rental listing
   * @param listingID The ID of the rental listing to fetch
   * @returns Detailed rental listing information
   */
  public async getRentalListingDetails(
    listingID: string,
  ): Promise<RentalListingDetailsResponse> {
    return this.request<RentalListingDetailsResponse>(
      RENTAL_LISTING_DETAILS_QUERY,
      { listingID },
    );
  }
}

// Export types and constants for external use
export * from "./types";
export * from "./constants";
