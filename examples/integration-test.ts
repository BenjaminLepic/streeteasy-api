import { StreetEasyClient } from '../src';
import { Areas } from '../src/constants';
import { SearchRentalListing, OrganicRentalEdge, FeaturedRentalEdge, SponsoredRentalEdge, RentalEdge } from '../src/types';

// Type guard functions
function isOrganicOrFeaturedEdge(edge: RentalEdge): edge is OrganicRentalEdge | FeaturedRentalEdge {
  return edge.__typename === "OrganicRentalEdge" || edge.__typename === "FeaturedRentalEdge";
}

function isSponsoredEdge(edge: RentalEdge): edge is SponsoredRentalEdge {
  return edge.__typename === "SponsoredRentalEdge";
}

/**
 * This file performs integration testing against the actual StreetEasy API.
 * Run with: npm run test:integration
 */
async function main() {
  console.log('Starting StreetEasy API integration tests...');
  
  // Create a new client
  const client = new StreetEasyClient();
  const results = {
    searchRentals: { success: false, message: '' },
    getRentalListingDetails: { success: false, message: '' }
  };
  
  try {
    console.log('\n1. Testing searchRentals API...');
    console.log('--------------------------------');
    
    // Search for rentals in Manhattan
    const searchResponse = await client.searchRentals({
      sorting: {
        attribute: 'RECOMMENDED',
        direction: 'DESCENDING'
      },
      filters: {
        areas: [Areas.ALL_NYC_AND_NJ],
        rentalStatus: 'ACTIVE',
        price: {
          lowerBound: null,
          upperBound: 10000
        }
      },
      perPage: 3
    });
    
    const totalListings = searchResponse.searchRentals.totalCount;
    const edges = searchResponse.searchRentals.edges;
    
    console.log(`✅ Search successful! Found ${totalListings} total listings`);
    console.log(`Retrieved ${edges.length} listings in the response`);
    
    if (edges.length > 0) {
      const firstEdge = edges[0];
      const sample = firstEdge.node;
      
      console.log('\nSample listing:');
      console.log(`- Edge Type: ${firstEdge.__typename}`);
      console.log(`- ID: ${sample.id}`);
      console.log(`- Area: ${sample.areaName}`);
      console.log(`- Type: ${sample.buildingType}`);
      console.log(`- Bedrooms: ${sample.bedroomCount}`);
      console.log(`- Bathrooms: ${sample.fullBathroomCount}`);
      console.log(`- Price: $${sample.price}`);
      console.log(`- Fee: ${sample.noFee ? 'NO FEE' : 'FEE'}`);
      console.log(`- Available: ${sample.availableAt || 'Immediately'}`);
      
      if (isOrganicOrFeaturedEdge(firstEdge)) {
        console.log(`- Amenities Match: ${firstEdge.amenitiesMatch ? 'Yes' : 'No'}`);
        console.log(`- Matched Amenities: ${firstEdge.matchedAmenities?.length ?? 0}`);
        console.log(`- Missing Amenities: ${firstEdge.missingAmenities?.length ?? 0}`);
      }
      
      if (isSponsoredEdge(firstEdge)) {
        console.log(`- Sponsored: ${firstEdge.sponsoredSimilarityLabel}`);
      }
      
      // Store the success
      results.searchRentals = { 
        success: true, 
        message: `Successfully retrieved ${edges.length} listings` 
      };
      
      // Use the first listing ID to test the rental details API
      const firstListingId = sample.id;
      
      console.log('\n2. Testing getRentalListingDetails API...');
      console.log('----------------------------------------');
      console.log(`Using listing ID: ${firstListingId}`);
      
      try {
        const detailsResponse = await client.getRentalListingDetails(firstListingId);
        
        // Check if we got the primary data
        if (detailsResponse.rentalByListingId && detailsResponse.buildingByRentalListingId) {
          const listing = detailsResponse.rentalByListingId;
          const building = detailsResponse.buildingByRentalListingId;
          
          console.log('\n✅ Details retrieval successful!');
          console.log('\nListing Details:');
          console.log(`- ID: ${listing.id}`);
          console.log(`- Status: ${listing.status}`);
          console.log(`- Available: ${listing.availableAt || 'Immediately'}`);
          console.log(`- Created: ${listing.createdAt}`);
          console.log(`- Address: ${listing.propertyDetails.address.street}, ${listing.propertyDetails.address.unit || ''}`);
          console.log(`- Size: ${listing.propertyDetails.livingAreaSize || 'Unknown'} sq ft`);
          console.log(`- Price: $${listing.pricing.price}`);
          
          console.log('\nBuilding Information:');
          console.log(`- Name: ${building.name || 'N/A'}`);
          console.log(`- Type: ${building.type}`);
          console.log(`- Area: ${building.area.name}`);
          console.log(`- Year Built: ${building.yearBuilt || 'Unknown'}`);
          
          // Store the success
          results.getRentalListingDetails = { 
            success: true, 
            message: `Successfully retrieved details for listing ${firstListingId}` 
          };
        } else {
          console.log('❌ Error: Incomplete data received from the API');
          results.getRentalListingDetails = { 
            success: false, 
            message: 'Incomplete data received from the API' 
          };
        }
      } catch (error) {
        console.error('❌ Error getting rental details:', error instanceof Error ? error.message : String(error));
        results.getRentalListingDetails = { 
          success: false, 
          message: error instanceof Error ? error.message : String(error) 
        };
      }
    } else {
      console.log('No listings found in search results');
      results.searchRentals = { 
        success: true, 
        message: 'Search successful but no listings returned' 
      };
    }
  } catch (error) {
    console.error('❌ Error searching rentals:', error instanceof Error ? error.message : String(error));
    results.searchRentals = { 
      success: false, 
      message: error instanceof Error ? error.message : String(error) 
    };
  }
  
  // Final summary
  console.log('\n----- INTEGRATION TEST SUMMARY -----');
  console.log(`Search Rentals: ${results.searchRentals.success ? '✅ PASS' : '❌ FAIL'}`);
  if (!results.searchRentals.success) console.log(`  - ${results.searchRentals.message}`);
  
  console.log(`Get Rental Details: ${results.getRentalListingDetails.success ? '✅ PASS' : '❌ FAIL'}`);
  if (!results.getRentalListingDetails.success) console.log(`  - ${results.getRentalListingDetails.message}`);
  
  // Return exit code based on test results
  if (results.searchRentals.success && results.getRentalListingDetails.success) {
    console.log('\n✅ All integration tests passed successfully!');
    process.exit(0);
  } else {
    console.log('\n❌ Some integration tests failed.');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Unhandled error in integration tests:', error);
  process.exit(1);
}); 