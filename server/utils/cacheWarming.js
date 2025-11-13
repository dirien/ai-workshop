import cacheService from '../services/cacheService.js';
import ragService from '../services/ragService.js';
import logger from '../config/logger.js';

/**
 * Cache Warming Utilities
 * 
 * Provides strategies for pre-populating the cache with common queries
 * to improve initial user experience and reduce cold-start latency.
 */

/**
 * Common OpenTelemetry questions for cache warming
 */
const COMMON_QUESTIONS = [
  // Getting Started
  "How do I get started with OpenTelemetry?",
  "What is OpenTelemetry and why should I use it?",
  "How do I install OpenTelemetry in my application?",
  
  // Instrumentation
  "How do I instrument a Node.js application with OpenTelemetry?",
  "How do I add custom spans in OpenTelemetry?",
  "What is automatic instrumentation in OpenTelemetry?",
  "How do I instrument Express.js with OpenTelemetry?",
  
  // Configuration
  "How do I configure OpenTelemetry exporters?",
  "What are the best practices for OpenTelemetry configuration?",
  "How do I set up sampling in OpenTelemetry?",
  
  // Troubleshooting
  "Why am I not seeing traces in my backend?",
  "How do I debug OpenTelemetry instrumentation?",
  "What are common OpenTelemetry configuration issues?",
  
  // Advanced Topics
  "How do I create custom metrics with OpenTelemetry?",
  "What is the difference between traces, metrics, and logs?",
  "How do I propagate context in OpenTelemetry?",
  "How do I use baggage in OpenTelemetry?",
  
  // Integration
  "How do I integrate OpenTelemetry with Honeycomb?",
  "How do I send OpenTelemetry data to multiple backends?",
  "How do I use OpenTelemetry with AWS Lambda?",
];

/**
 * Warm cache with common questions
 * @param {string} provider - LLM provider to use
 * @param {number} maxQuestions - Maximum number of questions to cache
 * @returns {Promise<object>} Warming results
 */
export async function warmCommonQuestions(provider = 'bedrock', maxQuestions = 20) {
  logger.info(`Starting cache warming with ${maxQuestions} common questions...`);
  
  const results = {
    total: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    duration: 0,
  };

  const startTime = Date.now();
  const questionsToWarm = COMMON_QUESTIONS.slice(0, maxQuestions);

  for (const question of questionsToWarm) {
    results.total++;

    try {
      // Check if already cached
      const cached = await cacheService.getCachedResponse(question, provider);
      if (cached) {
        results.skipped++;
        logger.debug(`Skipping already cached question: "${question}"`);
        continue;
      }

      // Generate response
      logger.debug(`Warming cache for question: "${question}"`);
      const response = await ragService.askQuestion(question, {
        provider,
        maxContextDocs: 5,
        includeContext: false,
      });

      // Cache the response
      const success = await cacheService.cacheResponse(question, provider, response);
      
      if (success) {
        results.successful++;
        logger.debug(`Successfully cached response for: "${question}"`);
      } else {
        results.failed++;
        logger.warn(`Failed to cache response for: "${question}"`);
      }

      // Add small delay to avoid overwhelming the LLM
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      results.failed++;
      results.errors.push({
        question,
        error: error.message,
      });
      logger.error(`Error warming cache for question "${question}":`, error);
    }
  }

  results.duration = Date.now() - startTime;
  
  logger.info('Cache warming completed:', {
    total: results.total,
    successful: results.successful,
    failed: results.failed,
    skipped: results.skipped,
    duration: `${(results.duration / 1000).toFixed(2)}s`,
  });

  return results;
}

/**
 * Warm cache from query logs
 * @param {Array<string>} queries - Array of queries from logs
 * @param {string} provider - LLM provider to use
 * @param {number} topN - Number of top queries to cache
 * @returns {Promise<object>} Warming results
 */
export async function warmFromQueryLogs(queries, provider = 'bedrock', topN = 50) {
  logger.info(`Warming cache from ${queries.length} query logs (top ${topN})...`);

  // Count query frequency
  const queryFrequency = {};
  for (const query of queries) {
    const normalized = query.toLowerCase().trim();
    queryFrequency[normalized] = (queryFrequency[normalized] || 0) + 1;
  }

  // Sort by frequency and take top N
  const topQueries = Object.entries(queryFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([query]) => query);

  logger.info(`Identified ${topQueries.length} unique queries to warm`);

  // Warm cache with top queries
  const results = {
    total: topQueries.length,
    successful: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    duration: 0,
  };

  const startTime = Date.now();

  for (const query of topQueries) {
    try {
      // Check if already cached
      const cached = await cacheService.getCachedResponse(query, provider);
      if (cached) {
        results.skipped++;
        continue;
      }

      // Generate and cache response
      const response = await ragService.askQuestion(query, {
        provider,
        maxContextDocs: 5,
        includeContext: false,
      });

      const success = await cacheService.cacheResponse(query, provider, response);
      
      if (success) {
        results.successful++;
      } else {
        results.failed++;
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      results.failed++;
      results.errors.push({
        query,
        error: error.message,
      });
      logger.error(`Error warming cache for query "${query}":`, error);
    }
  }

  results.duration = Date.now() - startTime;
  
  logger.info('Cache warming from logs completed:', {
    total: results.total,
    successful: results.successful,
    failed: results.failed,
    skipped: results.skipped,
    duration: `${(results.duration / 1000).toFixed(2)}s`,
  });

  return results;
}

/**
 * Scheduled cache warming job
 * Runs periodically to keep cache warm with common queries
 * @param {number} intervalMs - Interval in milliseconds (default: 6 hours)
 * @param {string} provider - LLM provider to use
 */
export function scheduleWarmingJob(intervalMs = 6 * 60 * 60 * 1000, provider = 'bedrock') {
  logger.info(`Scheduling cache warming job every ${intervalMs / 1000 / 60} minutes`);

  // Run immediately on startup
  warmCommonQuestions(provider, 10).catch(error => {
    logger.error('Error in initial cache warming:', error);
  });

  // Schedule periodic warming
  const intervalId = setInterval(async () => {
    try {
      logger.info('Running scheduled cache warming job...');
      await warmCommonQuestions(provider, 10);
    } catch (error) {
      logger.error('Error in scheduled cache warming:', error);
    }
  }, intervalMs);

  // Return cleanup function
  return () => {
    clearInterval(intervalId);
    logger.info('Cache warming job stopped');
  };
}

/**
 * Warm cache with specific questions
 * @param {Array<string>} questions - Questions to warm
 * @param {string} provider - LLM provider to use
 * @returns {Promise<object>} Warming results
 */
export async function warmSpecificQuestions(questions, provider = 'bedrock') {
  logger.info(`Warming cache with ${questions.length} specific questions...`);

  const results = {
    total: questions.length,
    successful: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    duration: 0,
  };

  const startTime = Date.now();

  for (const question of questions) {
    try {
      // Check if already cached
      const cached = await cacheService.getCachedResponse(question, provider);
      if (cached) {
        results.skipped++;
        continue;
      }

      // Generate and cache response
      const response = await ragService.askQuestion(question, {
        provider,
        maxContextDocs: 5,
        includeContext: false,
      });

      const success = await cacheService.cacheResponse(question, provider, response);
      
      if (success) {
        results.successful++;
      } else {
        results.failed++;
      }

    } catch (error) {
      results.failed++;
      results.errors.push({
        question,
        error: error.message,
      });
      logger.error(`Error warming cache for question "${question}":`, error);
    }
  }

  results.duration = Date.now() - startTime;
  
  logger.info('Specific questions cache warming completed:', results);

  return results;
}

export default {
  warmCommonQuestions,
  warmFromQueryLogs,
  scheduleWarmingJob,
  warmSpecificQuestions,
  COMMON_QUESTIONS,
};
