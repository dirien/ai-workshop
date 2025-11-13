import { createClient } from 'redis';
import crypto from 'crypto';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import logger from '../config/logger.js';

const tracer = trace.getTracer('cache-service', '1.0.0');

/**
 * Multi-Layer Caching Service with Redis
 * 
 * Provides three caching layers:
 * 1. Response Cache: Full LLM responses (highest latency reduction)
 * 2. Vector Search Cache: Pre-computed vector search results
 * 3. Embedding Cache: Cached embeddings for common queries
 * 
 * Features:
 * - Automatic connection management with retry logic
 * - Circuit breaker pattern for fault tolerance
 * - OpenTelemetry instrumentation for observability
 * - Configurable TTLs per cache layer
 * - Cache warming and invalidation strategies
 * - Memory-efficient key design with hashing
 */
class CacheService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.isEnabled = process.env.REDIS_ENABLED === 'true';
    this.circuitBreakerOpen = false;
    this.circuitBreakerResetTime = null;
    this.connectionRetries = 0;
    this.maxRetries = 5;
    
    // Cache configuration
    this.config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      ttl: {
        response: parseInt(process.env.CACHE_TTL_RESPONSE) || 86400, // 24 hours
        vector: parseInt(process.env.CACHE_TTL_VECTOR) || 43200, // 12 hours
        embedding: parseInt(process.env.CACHE_TTL_EMBEDDING) || 604800, // 7 days
      },
      circuitBreaker: {
        failureThreshold: 5,
        resetTimeout: 60000, // 1 minute
      },
    };

    // Cache key prefixes for different layers
    this.prefixes = {
      response: 'resp:',
      vector: 'vec:',
      embedding: 'emb:',
      metadata: 'meta:',
    };

    // Statistics tracking
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0,
      sets: 0,
      deletes: 0,
    };

    if (this.isEnabled) {
      this.initialize();
    } else {
      logger.info('Redis caching is disabled');
    }
  }

  /**
   * Initialize Redis connection with retry logic
   */
  async initialize() {
    if (!this.isEnabled) return;

    try {
      logger.info(`Initializing Redis connection to ${this.config.host}:${this.config.port}`);

      this.client = createClient({
        socket: {
          host: this.config.host,
          port: this.config.port,
          reconnectStrategy: (retries) => {
            if (retries > this.maxRetries) {
              logger.error('Max Redis reconnection attempts reached');
              return new Error('Max reconnection attempts reached');
            }
            const delay = Math.min(retries * 100, 3000);
            logger.info(`Reconnecting to Redis in ${delay}ms (attempt ${retries})`);
            return delay;
          },
        },
        // Connection pool settings
        isolationPoolOptions: {
          min: 2,
          max: 10,
        },
      });

      // Event handlers
      this.client.on('connect', () => {
        logger.info('Redis client connecting...');
      });

      this.client.on('ready', () => {
        logger.info('Redis client ready');
        this.isConnected = true;
        this.connectionRetries = 0;
        this.circuitBreakerOpen = false;
      });

      this.client.on('error', (err) => {
        logger.error('Redis client error:', err);
        this.stats.errors++;
        this.handleConnectionError();
      });

      this.client.on('end', () => {
        logger.warn('Redis client connection closed');
        this.isConnected = false;
      });

      this.client.on('reconnecting', () => {
        logger.info('Redis client reconnecting...');
        this.connectionRetries++;
      });

      // Connect to Redis
      await this.client.connect();
      
      // Test connection
      await this.client.ping();
      logger.info('Redis connection established successfully');

    } catch (error) {
      logger.error('Failed to initialize Redis:', error);
      this.handleConnectionError();
    }
  }

  /**
   * Handle connection errors with circuit breaker pattern
   */
  handleConnectionError() {
    this.isConnected = false;
    
    if (!this.circuitBreakerOpen) {
      this.circuitBreakerOpen = true;
      this.circuitBreakerResetTime = Date.now() + this.config.circuitBreaker.resetTimeout;
      
      logger.warn(`Circuit breaker opened. Will retry after ${this.config.circuitBreaker.resetTimeout}ms`);
      
      // Schedule circuit breaker reset
      setTimeout(() => {
        this.circuitBreakerOpen = false;
        this.circuitBreakerResetTime = null;
        logger.info('Circuit breaker reset. Attempting to reconnect...');
        this.initialize();
      }, this.config.circuitBreaker.resetTimeout);
    }
  }

  /**
   * Check if cache is available
   */
  isAvailable() {
    if (!this.isEnabled) return false;
    if (this.circuitBreakerOpen) return false;
    return this.isConnected && this.client;
  }

  /**
   * Generate cache key with hash for memory efficiency
   * @param {string} prefix - Cache layer prefix
   * @param {string} data - Data to hash
   * @returns {string} Cache key
   */
  generateKey(prefix, data) {
    const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
    return `${prefix}${hash}`;
  }

  /**
   * Get value from cache with OpenTelemetry tracing
   * @param {string} key - Cache key
   * @param {string} layer - Cache layer name for metrics
   * @returns {Promise<any|null>} Cached value or null
   */
  async get(key, layer = 'unknown') {
    if (!this.isAvailable()) return null;

    return tracer.startActiveSpan('cache.get', async (span) => {
      const startTime = Date.now();
      
      try {
        span.setAttributes({
          'cache.operation': 'get',
          'cache.key': key,
          'cache.layer': layer,
        });

        const value = await this.client.get(key);
        const duration = Date.now() - startTime;

        if (value) {
          this.stats.hits++;
          span.setAttributes({
            'cache.hit': true,
            'cache.duration_ms': duration,
            'cache.value_size': value.length,
          });
          logger.debug(`Cache HIT for key: ${key} (${layer}) in ${duration}ms`);
          
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          
          return JSON.parse(value);
        } else {
          this.stats.misses++;
          span.setAttributes({
            'cache.hit': false,
            'cache.duration_ms': duration,
          });
          logger.debug(`Cache MISS for key: ${key} (${layer}) in ${duration}ms`);
          
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          
          return null;
        }
      } catch (error) {
        this.stats.errors++;
        logger.error(`Cache GET error for key ${key}:`, error);
        
        span.setAttributes({
          'cache.error': error.message,
          'cache.hit': false,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        span.recordException(error);
        span.end();
        
        return null;
      }
    });
  }

  /**
   * Set value in cache with TTL and OpenTelemetry tracing
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in seconds
   * @param {string} layer - Cache layer name for metrics
   * @returns {Promise<boolean>} Success status
   */
  async set(key, value, ttl, layer = 'unknown') {
    if (!this.isAvailable()) return false;

    return tracer.startActiveSpan('cache.set', async (span) => {
      const startTime = Date.now();
      
      try {
        span.setAttributes({
          'cache.operation': 'set',
          'cache.key': key,
          'cache.layer': layer,
          'cache.ttl': ttl,
        });

        const serialized = JSON.stringify(value);
        await this.client.setEx(key, ttl, serialized);
        
        const duration = Date.now() - startTime;
        this.stats.sets++;

        span.setAttributes({
          'cache.duration_ms': duration,
          'cache.value_size': serialized.length,
          'cache.success': true,
        });
        
        logger.debug(`Cache SET for key: ${key} (${layer}) with TTL ${ttl}s in ${duration}ms`);
        
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        
        return true;
      } catch (error) {
        this.stats.errors++;
        logger.error(`Cache SET error for key ${key}:`, error);
        
        span.setAttributes({
          'cache.error': error.message,
          'cache.success': false,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        span.recordException(error);
        span.end();
        
        return false;
      }
    });
  }

  /**
   * Delete value from cache
   * @param {string} key - Cache key
   * @returns {Promise<boolean>} Success status
   */
  async delete(key) {
    if (!this.isAvailable()) return false;

    try {
      await this.client.del(key);
      this.stats.deletes++;
      logger.debug(`Cache DELETE for key: ${key}`);
      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error(`Cache DELETE error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete multiple keys matching a pattern
   * @param {string} pattern - Key pattern (e.g., "resp:*")
   * @returns {Promise<number>} Number of keys deleted
   */
  async deletePattern(pattern) {
    if (!this.isAvailable()) return 0;

    try {
      const keys = await this.client.keys(pattern);
      if (keys.length === 0) return 0;

      await this.client.del(keys);
      this.stats.deletes += keys.length;
      logger.info(`Cache DELETE pattern ${pattern}: ${keys.length} keys deleted`);
      return keys.length;
    } catch (error) {
      this.stats.errors++;
      logger.error(`Cache DELETE pattern error for ${pattern}:`, error);
      return 0;
    }
  }

  // =============================================================================
  // Layer-Specific Cache Methods
  // =============================================================================

  /**
   * Cache full LLM response
   * @param {string} question - User question
   * @param {string} provider - LLM provider
   * @param {object} response - Full response object
   * @returns {Promise<boolean>}
   */
  async cacheResponse(question, provider, response) {
    const keyData = `${question}:${provider}`;
    const key = this.generateKey(this.prefixes.response, keyData);
    return this.set(key, response, this.config.ttl.response, 'response');
  }

  /**
   * Get cached LLM response
   * @param {string} question - User question
   * @param {string} provider - LLM provider
   * @returns {Promise<object|null>}
   */
  async getCachedResponse(question, provider) {
    const keyData = `${question}:${provider}`;
    const key = this.generateKey(this.prefixes.response, keyData);
    return this.get(key, 'response');
  }

  /**
   * Cache vector search results
   * @param {string} query - Search query
   * @param {number} k - Number of results
   * @param {Array} results - Vector search results
   * @returns {Promise<boolean>}
   */
  async cacheVectorSearch(query, k, results) {
    const keyData = `${query}:${k}`;
    const key = this.generateKey(this.prefixes.vector, keyData);
    return this.set(key, results, this.config.ttl.vector, 'vector');
  }

  /**
   * Get cached vector search results
   * @param {string} query - Search query
   * @param {number} k - Number of results
   * @returns {Promise<Array|null>}
   */
  async getCachedVectorSearch(query, k) {
    const keyData = `${query}:${k}`;
    const key = this.generateKey(this.prefixes.vector, keyData);
    return this.get(key, 'vector');
  }

  /**
   * Cache embedding vector
   * @param {string} text - Text that was embedded
   * @param {Array} embedding - Embedding vector
   * @returns {Promise<boolean>}
   */
  async cacheEmbedding(text, embedding) {
    const key = this.generateKey(this.prefixes.embedding, text);
    return this.set(key, embedding, this.config.ttl.embedding, 'embedding');
  }

  /**
   * Get cached embedding
   * @param {string} text - Text to get embedding for
   * @returns {Promise<Array|null>}
   */
  async getCachedEmbedding(text) {
    const key = this.generateKey(this.prefixes.embedding, text);
    return this.get(key, 'embedding');
  }

  // =============================================================================
  // Cache Management & Monitoring
  // =============================================================================

  /**
   * Get cache statistics
   * @returns {object} Cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;

    return {
      ...this.stats,
      total,
      hitRate: hitRate.toFixed(2),
      isConnected: this.isConnected,
      isEnabled: this.isEnabled,
      circuitBreakerOpen: this.circuitBreakerOpen,
    };
  }

  /**
   * Reset cache statistics
   */
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0,
      sets: 0,
      deletes: 0,
    };
    logger.info('Cache statistics reset');
  }

  /**
   * Get cache info from Redis
   * @returns {Promise<object>} Redis info
   */
  async getInfo() {
    if (!this.isAvailable()) {
      return {
        available: false,
        reason: this.circuitBreakerOpen ? 'Circuit breaker open' : 'Not connected',
      };
    }

    try {
      const info = await this.client.info('stats');
      const memory = await this.client.info('memory');
      const keyspace = await this.client.info('keyspace');

      return {
        available: true,
        stats: this.parseRedisInfo(info),
        memory: this.parseRedisInfo(memory),
        keyspace: this.parseRedisInfo(keyspace),
        clientStats: this.getStats(),
      };
    } catch (error) {
      logger.error('Error getting cache info:', error);
      return {
        available: false,
        error: error.message,
      };
    }
  }

  /**
   * Parse Redis INFO command output
   * @param {string} info - Redis INFO output
   * @returns {object} Parsed info
   */
  parseRedisInfo(info) {
    const lines = info.split('\r\n');
    const parsed = {};

    for (const line of lines) {
      if (line && !line.startsWith('#')) {
        const [key, value] = line.split(':');
        if (key && value) {
          parsed[key] = value;
        }
      }
    }

    return parsed;
  }

  /**
   * Warm cache with common queries
   * @param {Array<object>} queries - Array of {question, provider, response}
   * @returns {Promise<number>} Number of queries cached
   */
  async warmCache(queries) {
    if (!this.isAvailable()) {
      logger.warn('Cannot warm cache: Redis not available');
      return 0;
    }

    return tracer.startActiveSpan('cache.warm', async (span) => {
      let cached = 0;

      try {
        span.setAttribute('cache.warm.query_count', queries.length);

        for (const query of queries) {
          const success = await this.cacheResponse(
            query.question,
            query.provider,
            query.response
          );
          if (success) cached++;
        }

        span.setAttributes({
          'cache.warm.cached_count': cached,
          'cache.warm.success': true,
        });

        logger.info(`Cache warming completed: ${cached}/${queries.length} queries cached`);
        
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        
        return cached;
      } catch (error) {
        logger.error('Error warming cache:', error);
        
        span.setAttributes({
          'cache.warm.error': error.message,
          'cache.warm.success': false,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        span.recordException(error);
        span.end();
        
        return cached;
      }
    });
  }

  /**
   * Invalidate all caches
   * @returns {Promise<object>} Invalidation results
   */
  async invalidateAll() {
    if (!this.isAvailable()) return { success: false, reason: 'Cache not available' };

    try {
      const results = {
        responses: await this.deletePattern(`${this.prefixes.response}*`),
        vectors: await this.deletePattern(`${this.prefixes.vector}*`),
        embeddings: await this.deletePattern(`${this.prefixes.embedding}*`),
      };

      const total = results.responses + results.vectors + results.embeddings;
      logger.info(`Cache invalidation completed: ${total} keys deleted`, results);

      return { success: true, ...results, total };
    } catch (error) {
      logger.error('Error invalidating cache:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Close Redis connection
   */
  async close() {
    if (this.client && this.isConnected) {
      try {
        await this.client.quit();
        logger.info('Redis connection closed');
      } catch (error) {
        logger.error('Error closing Redis connection:', error);
      }
    }
  }
}

export default new CacheService();
