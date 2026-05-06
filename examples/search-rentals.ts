import {
  StreetEasyClient,
  Areas,
  OrganicRentalEdge,
  FeaturedRentalEdge,
  SponsoredRentalEdge,
} from '../src';

// Type guards for different edge types
function isOrganicOrFeaturedEdge(edge: any): edge is OrganicRentalEdge | FeaturedRentalEdge {
  return edge.__typename === "OrganicRentalEdge" || edge.__typename === "FeaturedRentalEdge";
}

function isSponsoredEdge(edge: any): edge is SponsoredRentalEdge {
  return edge.__typename === "SponsoredRentalEdge";
}

async function main() {
  // Create a new client
  const client = new StreetEasyClient();

  try {
    // Search for rentals using the same parameters as the cURL request
    const response = await client.searchRentals({
      sorting: {
        attribute: 'RECOMMENDED',
        direction: 'DESCENDING'
      },
      adStrategy: 'NONE',
      filters: {
        areas: [Areas.ALL_NYC_AND_NJ], // 1 = ALL_NYC_AND_NJ
        rentalStatus: 'ACTIVE',
        price: {
          lowerBound: null,
          upperBound: 10000
        }
      },
      perPage: 5, // Reduced from 500 for example purposes
      page: 1,
      userSearchToken: '6acc6bf8-a96c-4883-9a20-d9712d7fa26f'
    });

    // Debug: Log the entire response
    console.log('Full response:', JSON.stringify(response, null, 2));

    // Print total count
    console.log(`Found ${response.searchRentals.totalCount} listings`);
    console.log('---');

    // Print each listing
    response.searchRentals.edges.forEach(edge => {
      const listing = edge.node;
      // Log edge type
      console.log(`Edge Type: ${edge.__typename}`);
      
      // Print common listing details
      console.log(`
${listing.bedroomCount}BR/${listing.fullBathroomCount}BA - $${listing.price}
${listing.street} ${listing.unit}
${listing.areaName}
${listing.noFee ? 'NO FEE' : 'FEE'}
${listing.availableAt ? `Available: ${listing.availableAt}` : 'Available: Immediately'}
${listing.livingAreaSize ? `Size: ${listing.livingAreaSize} sq ft` : ''}
URL: https://streeteasy.com${listing.urlPath}
      `);
      
      // Print amenity match information for organic and featured listings
      if (isOrganicOrFeaturedEdge(edge)) {
        console.log(`Amenities Match: ${edge.amenitiesMatch ? 'Yes' : 'No'}`);
        if (edge.matchedAmenities.length > 0) {
          console.log('Matched Amenities:');
          edge.matchedAmenities.forEach(amenity => console.log(`- ${amenity}`));
        }
        if (edge.missingAmenities.length > 0) {
          console.log('Missing Amenities:');
          edge.missingAmenities.forEach(amenity => console.log(`- ${amenity}`));
        }
      }
      
      // Print sponsored information for sponsored listings
      if (isSponsoredEdge(edge)) {
        console.log(`Sponsored: ${edge.sponsoredSimilarityLabel}`);
      }
      
      console.log('---');
    });
  } catch (error) {
    // Debug: Log the full error
    console.error('Error details:', error);
    console.error('Error searching rentals:', error instanceof Error ? error.message : String(error));
  }
}

// Run the script
main().catch(console.error); 