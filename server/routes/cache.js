import express from 'express';
import cacheService from '../services/cacheService.js';
import cacheWarming from '../utils/cacheWarming.js';
import logger from '../config/logger.js';

const router = express.Router();

/**
 * Cache Management and Monitoring Endpoints
 * 
 * Provides REST API for cache operations, monitoring, and management
 */

// GET /api/cache/stats - Get cache statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = cacheService.getStats();
    
    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error getting cache stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get cache statistics',
      message: error.message,
    });
  }
});

// GET /api/cache/info - Get detailed cache information
router.get('/info', async (req, res) => {
  try {
    const info = await cacheService.getInfo();
    
    res.json({
      success: true,
      data: info,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error getting cache info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get cache information',
      message: error.message,
    });
  }
});

// POST /api/cache/invalidate - Invalidate all caches
router.post('/invalidate', async (req, res) => {
  try {
    const { layer } = req.body;

    let result;
    if (layer) {
      // Invalidate specific layer
      const pattern = `${cacheService.prefixes[layer]}*`;
      const deleted = await cacheService.deletePattern(pattern);
      result = { success: true, layer, deleted };
    } else {
      // Invalidate all layers
      result = await cacheService.invalidateAll();
    }

    logger.info('Cache invalidation completed:', result);

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error invalidating cache:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to invalidate cache',
      message: error.message,
    });
  }
});

// POST /api/cache/warm - Warm cache with common questions
router.post('/warm', async (req, res) => {
  try {
    const { 
      provider = 'bedrock', 
      maxQuestions = 10,
      questions = null,
    } = req.body;

    let result;
    if (questions && Array.isArray(questions)) {
      // Warm with specific questions
      result = await cacheWarming.warmSpecificQuestions(questions, provider);
    } else {
      // Warm with common questions
      result = await cacheWarming.warmCommonQuestions(provider, maxQuestions);
    }

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error warming cache:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to warm cache',
      message: error.message,
    });
  }
});

// GET /api/cache/health - Cache health check
router.get('/health', async (req, res) => {
  try {
    const isAvailable = cacheService.isAvailable();
    const stats = cacheService.getStats();

    const health = {
      status: isAvailable ? 'healthy' : 'unhealthy',
      available: isAvailable,
      connected: stats.isConnected,
      enabled: stats.isEnabled,
      circuitBreakerOpen: stats.circuitBreakerOpen,
      hitRate: parseFloat(stats.hitRate),
      totalRequests: stats.total,
    };

    const statusCode = isAvailable ? 200 : 503;

    res.status(statusCode).json({
      success: isAvailable,
      data: health,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error checking cache health:', error);
    res.status(503).json({
      success: false,
      error: 'Failed to check cache health',
      message: error.message,
    });
  }
});

// POST /api/cache/reset-stats - Reset cache statistics
router.post('/reset-stats', (req, res) => {
  try {
    cacheService.resetStats();
    
    res.json({
      success: true,
      message: 'Cache statistics reset successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error resetting cache stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset cache statistics',
      message: error.message,
    });
  }
});

// GET /api/cache/metrics - Get Prometheus-style metrics
router.get('/metrics', async (req, res) => {
  try {
    const stats = cacheService.getStats();
    const info = await cacheService.getInfo();

    // Generate Prometheus-style metrics
    const metrics = [];

    // Cache hit rate
    metrics.push(`# HELP cache_hit_rate Cache hit rate percentage`);
    metrics.push(`# TYPE cache_hit_rate gauge`);
    metrics.push(`cache_hit_rate{cache="redis"} ${stats.hitRate}`);

    // Cache hits
    metrics.push(`# HELP cache_hits_total Total number of cache hits`);
    metrics.push(`# TYPE cache_hits_total counter`);
    metrics.push(`cache_hits_total{cache="redis"} ${stats.hits}`);

    // Cache misses
    metrics.push(`# HELP cache_misses_total Total number of cache misses`);
    metrics.push(`# TYPE cache_misses_total counter`);
    metrics.push(`cache_misses_total{cache="redis"} ${stats.misses}`);

    // Cache errors
    metrics.push(`# HELP cache_errors_total Total number of cache errors`);
    metrics.push(`# TYPE cache_errors_total counter`);
    metrics.push(`cache_errors_total{cache="redis"} ${stats.errors}`);

    // Cache availability
    metrics.push(`# HELP cache_available Cache availability status`);
    metrics.push(`# TYPE cache_available gauge`);
    metrics.push(`cache_available{cache="redis"} ${stats.isConnected ? 1 : 0}`);

    // Circuit breaker status
    metrics.push(`# HELP cache_circuit_breaker_open Circuit breaker status`);
    metrics.push(`# TYPE cache_circuit_breaker_open gauge`);
    metrics.push(`cache_circuit_breaker_open{cache="redis"} ${stats.circuitBreakerOpen ? 1 : 0}`);

    res.set('Content-Type', 'text/plain');
    res.send(metrics.join('\n'));
  } catch (error) {
    logger.error('Error generating cache metrics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate cache metrics',
      message: error.message,
    });
  }
});

export default router;
