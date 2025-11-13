import { metrics } from '@opentelemetry/api';
import logger from '../config/logger.js';

/**
 * OpenTelemetry Metrics for Cache Operations
 * 
 * Provides comprehensive metrics for monitoring cache performance:
 * - Hit/miss rates by cache layer
 * - Operation latencies
 * - Cache size and memory usage
 * - Error rates
 * - Connection health
 */
class CacheMetrics {
  constructor() {
    this.meter = metrics.getMeter('cache-metrics', '1.0.0');
    this.initialized = false;
    this.metrics = {};
    
    this.initialize();
  }

  initialize() {
    try {
      // Counter: Cache hits by layer
      this.metrics.cacheHits = this.meter.createCounter('cache.hits', {
        description: 'Number of cache hits',
        unit: '1',
      });

      // Counter: Cache misses by layer
      this.metrics.cacheMisses = this.meter.createCounter('cache.misses', {
        description: 'Number of cache misses',
        unit: '1',
      });

      // Counter: Cache sets by layer
      this.metrics.cacheSets = this.meter.createCounter('cache.sets', {
        description: 'Number of cache set operations',
        unit: '1',
      });

      // Counter: Cache errors by operation type
      this.metrics.cacheErrors = this.meter.createCounter('cache.errors', {
        description: 'Number of cache errors',
        unit: '1',
      });

      // Histogram: Cache operation latency
      this.metrics.cacheLatency = this.meter.createHistogram('cache.operation.duration', {
        description: 'Duration of cache operations',
        unit: 'ms',
      });

      // Histogram: Cached value size
      this.metrics.cacheValueSize = this.meter.createHistogram('cache.value.size', {
        description: 'Size of cached values',
        unit: 'bytes',
      });

      // UpDownCounter: Current cache connections
      this.metrics.cacheConnections = this.meter.createUpDownCounter('cache.connections', {
        description: 'Number of active cache connections',
        unit: '1',
      });

      // ObservableGauge: Cache hit rate
      this.metrics.cacheHitRate = this.meter.createObservableGauge('cache.hit_rate', {
        description: 'Cache hit rate percentage',
        unit: '%',
      });

      // ObservableGauge: Cache memory usage
      this.metrics.cacheMemoryUsage = this.meter.createObservableGauge('cache.memory.usage', {
        description: 'Cache memory usage',
        unit: 'bytes',
      });

      // ObservableGauge: Cache key count
      this.metrics.cacheKeyCount = this.meter.createObservableGauge('cache.keys.count', {
        description: 'Number of keys in cache',
        unit: '1',
      });

      this.initialized = true;
      logger.info('Cache metrics initialized');
    } catch (error) {
      logger.error('Failed to initialize cache metrics:', error);
    }
  }

  /**
   * Record cache hit
   * @param {string} layer - Cache layer (response, vector, embedding)
   * @param {number} latency - Operation latency in ms
   * @param {number} valueSize - Size of cached value in bytes
   */
  recordHit(layer, latency, valueSize) {
    if (!this.initialized) return;

    try {
      this.metrics.cacheHits.add(1, { layer });
      this.metrics.cacheLatency.record(latency, { operation: 'get', layer, result: 'hit' });
      if (valueSize) {
        this.metrics.cacheValueSize.record(valueSize, { layer });
      }
    } catch (error) {
      logger.error('Error recording cache hit metric:', error);
    }
  }

  /**
   * Record cache miss
   * @param {string} layer - Cache layer (response, vector, embedding)
   * @param {number} latency - Operation latency in ms
   */
  recordMiss(layer, latency) {
    if (!this.initialized) return;

    try {
      this.metrics.cacheMisses.add(1, { layer });
      this.metrics.cacheLatency.record(latency, { operation: 'get', layer, result: 'miss' });
    } catch (error) {
      logger.error('Error recording cache miss metric:', error);
    }
  }

  /**
   * Record cache set operation
   * @param {string} layer - Cache layer (response, vector, embedding)
   * @param {number} latency - Operation latency in ms
   * @param {number} valueSize - Size of cached value in bytes
   * @param {boolean} success - Whether the operation succeeded
   */
  recordSet(layer, latency, valueSize, success = true) {
    if (!this.initialized) return;

    try {
      if (success) {
        this.metrics.cacheSets.add(1, { layer });
        this.metrics.cacheValueSize.record(valueSize, { layer });
      }
      this.metrics.cacheLatency.record(latency, { 
        operation: 'set', 
        layer, 
        result: success ? 'success' : 'failure' 
      });
    } catch (error) {
      logger.error('Error recording cache set metric:', error);
    }
  }

  /**
   * Record cache error
   * @param {string} operation - Operation type (get, set, delete)
   * @param {string} layer - Cache layer
   * @param {string} errorType - Type of error
   */
  recordError(operation, layer, errorType) {
    if (!this.initialized) return;

    try {
      this.metrics.cacheErrors.add(1, { operation, layer, error_type: errorType });
    } catch (error) {
      logger.error('Error recording cache error metric:', error);
    }
  }

  /**
   * Update connection count
   * @param {number} delta - Change in connection count (+1 or -1)
   */
  updateConnections(delta) {
    if (!this.initialized) return;

    try {
      this.metrics.cacheConnections.add(delta);
    } catch (error) {
      logger.error('Error updating cache connections metric:', error);
    }
  }

  /**
   * Register observable metrics callback
   * @param {Function} getStatsCallback - Function that returns cache stats
   */
  registerObservables(getStatsCallback) {
    if (!this.initialized) return;

    try {
      // Register hit rate observable
      this.metrics.cacheHitRate.addCallback((observableResult) => {
        const stats = getStatsCallback();
        if (stats && stats.hitRate !== undefined) {
          observableResult.observe(parseFloat(stats.hitRate), { 
            cache: 'redis' 
          });
        }
      });

      logger.info('Cache observable metrics registered');
    } catch (error) {
      logger.error('Error registering cache observable metrics:', error);
    }
  }
}

export default new CacheMetrics();
