import { sui } from './suiClient.js';
import { setTimeout } from 'timers/promises';

/**
 * Query Sui events with automatic retry and exponential backoff
 * @param {string} digest - Transaction digest to query
 * @param {number} maxRetries - Maximum number of retry attempts (default: 5)
 * @param {number} initialDelay - Initial delay in ms before first retry (default: 500)
 * @returns {Promise<Object>} - The events result object from Sui
 */
export async function queryEventsWithRetry(digest, maxRetries = 5, initialDelay = 500) {
  let retries = 0;
  let delay = initialDelay;
  
  while (retries < maxRetries) {
    try {
      // Try to query events
      const eventsResult = await sui.queryEvents({
        query: { Transaction: digest },
      });
      
      // If successful, return the result
      return eventsResult;
    } catch (error) {
      // If we hit the specific error about transaction not found
      if (error.message?.includes('Could not find the referenced transaction') || 
          error.code === -32602) {
        
        // Increment retry counter
        retries++;
        
        if (retries >= maxRetries) {
          throw error; // Max retries reached, propagate the error
        }
        
        console.log(`Transaction ${digest} not yet indexed, retrying in ${delay}ms (attempt ${retries}/${maxRetries})...`);
        
        // Wait before retrying
        await setTimeout(delay);
        
        // Exponential backoff: double the delay for next retry
        delay *= 2;
      } else {
        // If it's a different error, don't retry, just throw
        throw error;
      }
    }
  }
}