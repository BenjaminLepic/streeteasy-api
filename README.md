# StreetEasy API Client

A TypeScript GraphQL client for the StreetEasy API.

## Installation

```bash
npm install streeteasy-api
# or
yarn add streeteasy-api
```

## Usage

```typescript
import { StreetEasyClient, Areas, Amenities } from 'streeteasy-api';

// Create a client
const client = new StreetEasyClient();

// Search for rentals with detailed filters
async function searchRentals() {
  try {
    const response = await client.searchRentals({
      sorting: {
        attribute: 'RECOMMENDED',
        direction: 'DESCENDING'
      },
      filters: {
        // Location
        areas: [Areas.QUEENS], // Search in Queens

        // Status and Price
        rentalStatus: 'ACTIVE',
        price: {
          lowerBound: null,
          upperBound: 10000
        },

        // Size requirements
        bedrooms: {
          lowerBound: 3,
          upperBound: 4
        },
        bathrooms: {
          lowerBound: 3,
          upperBound: null
        },

        // Amenities
        amenities: [
          Amenities.WASHER_DRYER,
          Amenities.DISHWASHER,
          Amenities.CENTRAL_AC,
          Amenities.DOORMAN,
          Amenities.GYM
        ],

        // Pet policy
        petsAllowed: true
      },
      perPage: 50,
      page: 1
    });

    // Access the results
    console.log(`Found ${response.searchRentals.totalCount} listings`);
    
    // Access individual listings
    response.searchRentals.edges.forEach(edge => {
      const listing = edge.node;
      console.log(`
        ${listing.bedroomCount}BR/${listing.fullBathroomCount}BA
        ${listing.street} ${listing.unit}
        ${listing.areaName}
        $${listing.price}
        ${listing.noFee ? 'NO FEE' : 'FEE'}
      `);
    });
  } catch (error) {
    console.error('API Error:', error.message);
  }
}

// Search for luxury apartments
async function searchLuxuryApartments() {
  const response = await client.searchRentals({
    filters: {
      areas: [Areas.MANHATTAN],
      price: {
        lowerBound: 10000,
        upperBound: null
      },
      amenities: [
        Amenities.DOORMAN,
        Amenities.GYM,
        Amenities.POOL,
        Amenities.SKYLINE_VIEW
      ]
    }
  });
  return response;
}

// Search for pet-friendly apartments with outdoor space
async function searchPetFriendly() {
  const response = await client.searchRentals({
    filters: {
      areas: [Areas.BROOKLYN, Areas.QUEENS],
      petsAllowed: true,
      amenities: [
        Amenities.PRIVATE_OUTDOOR_SPACE,
        Amenities.WASHER_DRYER
      ]
    }
  });
  return response;
}
```

## Features

- Full TypeScript support with proper types for all responses
- GraphQL query execution
- Built-in convenience methods for common operations
- Automatic error handling
- Support for variables and complex queries
- Constants for area codes and amenities

## Types

The client includes TypeScript types for all responses. Here are some key types:

```typescript
// Area codes
const Areas = {
  // Regions
  ALL_NYC_AND_NJ: 1,

  // Boroughs
  MANHATTAN: 100,
  BRONX: 200,
  BROOKLYN: 300,
  QUEENS: 400,
  STATEN_ISLAND: 500
} as const;

// Amenities
const Amenities = {
  // Unit Amenities
  WASHER_DRYER: 'WASHER_DRYER',
  DISHWASHER: 'DISHWASHER',
  CENTRAL_AC: 'CENTRAL_AC',
  FURNISHED: 'FURNISHED',
  
  // Views
  SKYLINE_VIEW: 'SKYLINE_VIEW',
  WATER_VIEW: 'WATER_VIEW',
  
  // Building Amenities
  DOORMAN: 'DOORMAN',
  GYM: 'GYM',
  POOL: 'POOL',
  // ... and many more
} as const;

// Rental listing type
interface RentalListing {
  id: string;
  areaName: string;
  bedroomCount: number;
  buildingType: 'CO_OP' | 'CONDO' | 'MULTI_FAMILY' | 'RENTAL' | 'TOWNHOUSE';
  fullBathroomCount: number;
  geoPoint: {
    latitude: number;
    longitude: number;
  };
  halfBathroomCount: number;
  noFee: boolean;
  price: number;
  sourceGroupLabel: string;
  street: string;
  unit: string;
  urlPath: string;
}

// Search filters
interface SearchFilters {
  areas?: number[];
  rentalStatus?: 'ACTIVE';
  price?: {
    lowerBound: number | null;
    upperBound: number | null;
  };
  bedrooms?: {
    lowerBound: number | null;
    upperBound: number | null;
  };
  bathrooms?: {
    lowerBound: number | null;
    upperBound: number | null;
  };
  amenities?: string[];
  petsAllowed?: boolean;
}
```

## Development

```bash
# Install dependencies
yarn install

# Build the package
yarn build

# Format code
yarn format

# Run tests
yarn test

# Run tests in watch mode
yarn test:watch

# Run tests with coverage
yarn test:coverage
```

## Testing

The package includes a comprehensive test suite using Jest. Tests cover:

- Constants validation
- Client initialization
- API request handling
- Error handling
- Type safety

To run the tests:

```bash
# Run all tests
yarn test

# Run tests in watch mode (useful during development)
yarn test:watch

# Run tests with coverage report
yarn test:coverage
```

The test suite uses Jest's mocking capabilities to mock the GraphQL client, ensuring tests are fast and reliable without making actual API calls.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. 