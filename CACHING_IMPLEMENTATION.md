# Response Caching Strategy - Implementation Guide

## Overview

This document provides a comprehensive guide to the multi-layer caching implementation for the otel-ai-chatbot application. The caching strategy is designed to reduce LLM inference latency from ~20 seconds to 0.5-5 seconds through intelligent caching at multiple levels.

## Architecture

### Multi-Layer Caching Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                     User Request                             │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Response Cache (Full LLM Response)                │
│  - TTL: 24 hours                                             │
│  - Key: hash(question + provider)                            │
│  - Hit Rate Target: 60-80%                                   │
│  - Latency: ~50ms                                            │
└─────────────────────┬───────────────────────────────────────┘
                      │ Cache Miss
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Vector Search Cache                                │
│  - TTL: 12 hours                                             │
│  - Key: hash(query + k)                                      │
│  - Hit Rate Target: 40-60%                                   │
│  - Latency: ~100ms                                           │
└─────────────────────┬───────────────────────────────────────┘
                      │ Cache Miss
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Embedding Cache                                    │
│  - TTL: 7 days                                               │
│  - Key: hash(text)                                           │
│  - Hit Rate Target: 70-90%                                   │
│  - Latency: ~20ms                                            │
└─────────────────────┬───────────────────────────────────────┘
                      │ Cache Miss
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Bedrock API Call (Titan Embeddings)                         │
│  - Latency: ~200-500ms                                       │
└─────────────────────────────────────────────────────────────┘
```

## Infrastructure Setup

### 1. ElastiCache Redis Configuration

The infrastructure is defined in `pulumi/cache-infrastructure.ts` and provides:

- **High Availability**: Multi-AZ deployment with automatic failover
- **Replication**: 1 primary + 1 replica node
- **Encryption**: At-rest encryption enabled
- **Backups**: Automated daily backups with 7-day retention (prod)
- **Monitoring**: CloudWatch alarms for CPU, memory, evictions, and hit rate

#### Instance Sizing Recommendations

| Environment | Instance Type | Memory | Capacity | Monthly Cost |
|-------------|---------------|--------|----------|--------------|
| Dev/Test | cache.t4g.medium | 3.09 GB | ~3,000 responses | ~$50 |
| Production | cache.r7g.large | 13.07 GB | ~12,000 responses | ~$200 |

#### Deployment

```bash
cd pulumi
pulumi up
```

This will create:
- ElastiCache replication group with 2 nodes
- Security groups for Redis access
- CloudWatch log groups for slow queries and engine logs
- CloudWatch alarms for monitoring

### 2. Environment Variables

Add these to your ECS task definition (already configured in `pulumi/index.ts`):

```bash
REDIS_HOST=<primary-endpoint>
REDIS_PORT=6379
REDIS_ENABLED=true
CACHE_TTL_RESPONSE=86400    # 24 hours
CACHE_TTL_VECTOR=43200      # 12 hours
CACHE_TTL_EMBEDDING=604800  # 7 days
```

## Application Integration

### Cache Service API

The `cacheService.js` provides a comprehensive caching API:

#### Basic Operations

```javascript
import cacheService from './services/cacheService.js';

// Check if cache is available
if (cacheService.isAvailable()) {
  // Cache operations
}

// Get cached response
const cached = await cacheService.getCachedResponse(question, provider);

// Cache a response
await cacheService.cacheResponse(question, provider, response);

// Get cache statistics
const stats = cacheService.getStats();
console.log(`Hit rate: ${stats.hitRate}%`);
```

#### Layer-Specific Methods

```javascript
// Response caching
await cacheService.cacheResponse(question, provider, fullResponse);
const response = await cacheService.getCachedResponse(question, provider);

// Vector search caching
await cacheService.cacheVectorSearch(query, k, results);
const results = await cacheService.getCachedVectorSearch(query, k);

// Embedding caching
await cacheService.cacheEmbedding(text, embedding);
const embedding = await cacheService.getCachedEmbedding(text);
```

### RAG Service Integration

The cached RAG service (`ragServiceCached.js`) automatically uses all three cache layers:

```javascript
import ragService from './services/ragServiceCached.js';

// This will check all cache layers automatically
const result = await ragService.askQuestion(question, {
  provider: 'bedrock',
  maxContextDocs: 5,
});

// Result includes cache metadata
console.log(`Cached: ${result.metadata.cached}`);
```

### Vector Store Integration

The cached vector store (`vectorStoreCached.js`) caches embeddings:

```javascript
import vectorStore from './services/vectorStoreCached.js';

// Embeddings are automatically cached
const results = await vectorStore.similaritySearchWithScore(query, 5);
```

## Cache Management

### REST API Endpoints

#### Get Cache Statistics

```bash
GET /api/cache/stats

Response:
{
  "success": true,
  "data": {
    "hits": 1250,
    "misses": 450,
    "total": 1700,
    "hitRate": "73.53",
    "errors": 2,
    "sets": 450,
    "deletes": 10,
    "isConnected": true,
    "isEnabled": true,
    "circuitBreakerOpen": false
  }
}
```

#### Get Detailed Cache Info

```bash
GET /api/cache/info

Response:
{
  "success": true,
  "data": {
    "available": true,
    "stats": {
      "total_commands_processed": "15234",
      "instantaneous_ops_per_sec": "12"
    },
    "memory": {
      "used_memory": "2456789",
      "used_memory_human": "2.34M",
      "maxmemory": "3221225472"
    },
    "keyspace": {
      "db0": "keys=1234,expires=1234"
    }
  }
}
```

#### Invalidate Cache

```bash
# Invalidate all caches
POST /api/cache/invalidate
{}

# Invalidate specific layer
POST /api/cache/invalidate
{
  "layer": "response"  # or "vector" or "embedding"
}

Response:
{
  "success": true,
  "data": {
    "responses": 450,
    "vectors": 320,
    "embeddings": 890,
    "total": 1660
  }
}
```

#### Cache Health Check

```bash
GET /api/cache/health

Response:
{
  "success": true,
  "data": {
    "status": "healthy",
    "available": true,
    "connected": true,
    "enabled": true,
    "circuitBreakerOpen": false,
    "hitRate": 73.53,
    "totalRequests": 1700
  }
}
```

### Cache Warming

#### Automatic Warming on Startup

The cache warming utility (`utils/cacheWarming.js`) includes common OpenTelemetry questions:

```javascript
import cacheWarming from './utils/cacheWarming.js';

// Warm cache with common questions
const result = await cacheWarming.warmCommonQuestions('bedrock', 20);

console.log(`Warmed ${result.successful}/${result.total} questions`);
```

#### Manual Warming via API

```bash
# Warm with common questions
POST /api/cache/warm
{
  "provider": "bedrock",
  "maxQuestions": 10
}

# Warm with specific questions
POST /api/cache/warm
{
  "provider": "bedrock",
  "questions": [
    "How do I get started with OpenTelemetry?",
    "How do I instrument Express.js?"
  ]
}

Response:
{
  "success": true,
  "data": {
    "total": 10,
    "successful": 8,
    "failed": 0,
    "skipped": 2,
    "duration": 45230,
    "errors": []
  }
}
```

#### Scheduled Warming

Add to your server initialization:

```javascript
import cacheWarming from './utils/cacheWarming.js';

// Schedule warming every 6 hours
const stopWarming = cacheWarming.scheduleWarmingJob(
  6 * 60 * 60 * 1000, // 6 hours
  'bedrock'
);

// Stop warming on shutdown
process.on('SIGTERM', () => {
  stopWarming();
});
```

## Monitoring & Observability

### OpenTelemetry Metrics

The cache service automatically exports OpenTelemetry metrics:

```javascript
// Metrics exported:
- cache.hits (counter) - by layer
- cache.misses (counter) - by layer
- cache.sets (counter) - by layer
- cache.errors (counter) - by operation, layer
- cache.operation.duration (histogram) - by operation, layer, result
- cache.value.size (histogram) - by layer
- cache.connections (updowncounter)
- cache.hit_rate (gauge) - percentage
```

### Honeycomb Integration

All cache operations are traced with OpenTelemetry spans:

```
rag.generate_response_cached
├── rag.cache.check_response (Layer 1)
├── rag.vector_search_cached (Layer 2)
│   └── cache.get (vector search cache check)
├── vector_store.embed_query_cached (Layer 3)
│   └── cache.get (embedding cache check)
├── rag.format_context
└── rag.llm_generation
```

### CloudWatch Alarms

Automatically configured alarms:

1. **CPU Utilization** > 75% for 10 minutes
2. **Memory Usage** > 80% for 10 minutes
3. **Evictions** > 1000 per 5 minutes
4. **Cache Hit Rate** < 80% for 15 minutes
5. **Connection Count** > 500

### Key Metrics to Track

#### Cache Performance

- **Hit Rate**: Target 60-80% overall
  - Response layer: 60-80%
  - Vector layer: 40-60%
  - Embedding layer: 70-90%

- **Latency Reduction**:
  - Cache hit: ~50ms (97% reduction)
  - Cache miss: ~5-20s (depending on LLM)

- **Memory Usage**: Keep below 80% to avoid evictions

#### Application Performance

- **P95 Latency**: Target < 5 seconds
- **Cache Contribution**: % of requests served from cache
- **Error Rate**: < 0.1% cache errors

### Honeycomb Queries

```sql
-- Cache hit rate by layer
SELECT 
  AVG(cache.hit) as hit_rate,
  cache.layer
FROM spans
WHERE name = 'cache.get'
GROUP BY cache.layer

-- Cache latency distribution
SELECT 
  HEATMAP(cache.duration_ms),
  cache.layer,
  cache.hit
FROM spans
WHERE name = 'cache.get'

-- End-to-end latency with cache
SELECT 
  HEATMAP(duration_ms),
  rag.cache_hit,
  rag.cache_layer
FROM spans
WHERE name = 'rag.generate_response_cached'
```

## Performance Optimization

### Connection Pooling

The cache service uses connection pooling:

```javascript
isolationPoolOptions: {
  min: 2,   // Minimum connections
  max: 10,  // Maximum connections
}
```

Adjust based on your ECS task count:
- 1 task: min=2, max=10
- 2-4 tasks: min=2, max=20
- 5+ tasks: min=5, max=50

### Memory Optimization

#### Key Design

Keys are hashed to 16 characters for memory efficiency:

```javascript
// Instead of storing full question as key:
"How do I get started with OpenTelemetry in Node.js?"

// We store:
"resp:a3f5c8d9e2b1f4a6"
```

This reduces memory usage by ~80% for keys.

#### Value Compression

For large responses, consider enabling compression:

```javascript
// In cacheService.js, modify set method:
const serialized = JSON.stringify(value);
const compressed = await compress(serialized); // Add compression
await this.client.setEx(key, ttl, compressed);
```

### TTL Tuning

Adjust TTLs based on your usage patterns:

```javascript
// High-traffic, stable content
CACHE_TTL_RESPONSE=172800  // 48 hours

// Frequently updated content
CACHE_TTL_RESPONSE=43200   // 12 hours

// Development/testing
CACHE_TTL_RESPONSE=3600    // 1 hour
```

## Error Handling & Resilience

### Circuit Breaker Pattern

The cache service implements a circuit breaker:

```javascript
// Circuit breaker configuration
circuitBreaker: {
  failureThreshold: 5,      // Open after 5 failures
  resetTimeout: 60000,      // Reset after 1 minute
}
```

When the circuit breaker opens:
- All cache operations return null/false
- Application continues without caching
- Automatic retry after timeout

### Graceful Degradation

The application works without cache:

```javascript
// Cache miss or unavailable
if (!cached) {
  // Fall back to normal operation
  const response = await generateResponse();
}
```

### Retry Logic

Automatic reconnection with exponential backoff:

```javascript
reconnectStrategy: (retries) => {
  if (retries > 5) return new Error('Max retries');
  return Math.min(retries * 100, 3000); // Max 3 seconds
}
```

## Troubleshooting

### Cache Not Working

1. **Check Redis connection**:
   ```bash
   GET /api/cache/health
   ```

2. **Verify environment variables**:
   ```bash
   echo $REDIS_HOST
   echo $REDIS_ENABLED
   ```

3. **Check security groups**:
   - ECS tasks must have access to Redis security group
   - Port 6379 must be open

4. **Review logs**:
   ```bash
   # Application logs
   grep "cache" /var/log/app.log
   
   # Redis logs (CloudWatch)
   aws logs tail /aws/elasticache/otel-ai-chatbot-cache-slow-log
   ```

### Low Hit Rate

1. **Check TTLs**: May be too short
2. **Review query patterns**: High variability reduces hits
3. **Warm cache**: Use cache warming for common queries
4. **Check memory**: Evictions reduce hit rate

### High Memory Usage

1. **Review key count**:
   ```bash
   GET /api/cache/info
   # Check keyspace.db0
   ```

2. **Reduce TTLs**: Shorter TTLs = less memory
3. **Increase instance size**: Upgrade to larger instance
4. **Enable compression**: Compress large values

### Connection Errors

1. **Circuit breaker open**: Wait for reset (1 minute)
2. **Network issues**: Check VPC/security groups
3. **Redis overloaded**: Scale up instance
4. **Connection pool exhausted**: Increase max connections

## Cost Analysis

### Current Workload (7 requests/hour)

| Component | Configuration | Monthly Cost |
|-----------|---------------|--------------|
| ElastiCache | cache.t4g.medium (2 nodes) | $50 |
| Data Transfer | Minimal (VPC internal) | $2 |
| **Total** | | **$52/month** |

### Expected Savings

- **Bedrock API calls reduced by 70%**: $15/month savings
- **Faster responses**: Better user experience
- **Net cost increase**: $37/month
- **ROI**: 75-97% latency reduction for $37/month

### Scaling Costs

| Traffic | Instance | Monthly Cost | Capacity |
|---------|----------|--------------|----------|
| 100 req/hr | cache.t4g.medium | $50 | 3,000 responses |
| 500 req/hr | cache.r7g.large | $200 | 12,000 responses |
| 2000 req/hr | cache.r7g.xlarge | $400 | 25,000 responses |

## Best Practices

### 1. Cache Key Design

- Use consistent key formats
- Hash long keys for memory efficiency
- Include version in keys for schema changes

### 2. TTL Strategy

- Longer TTLs for stable content
- Shorter TTLs for dynamic content
- Monitor eviction rates

### 3. Monitoring

- Track hit rates by layer
- Monitor memory usage
- Alert on circuit breaker opens

### 4. Cache Warming

- Warm on deployment
- Schedule periodic warming
- Use analytics to identify common queries

### 5. Invalidation

- Invalidate on content updates
- Use pattern-based invalidation
- Log all invalidations

## Migration Guide

### Enabling Caching in Existing Deployment

1. **Deploy infrastructure**:
   ```bash
   cd pulumi
   pulumi up
   ```

2. **Update application**:
   - Already integrated in code
   - No code changes needed

3. **Verify deployment**:
   ```bash
   curl http://your-alb/api/cache/health
   ```

4. **Warm cache**:
   ```bash
   curl -X POST http://your-alb/api/cache/warm \
     -H "Content-Type: application/json" \
     -d '{"maxQuestions": 20}'
   ```

5. **Monitor performance**:
   - Check Honeycomb for latency improvements
   - Monitor cache hit rates
   - Review CloudWatch alarms

### Rollback Plan

If issues occur:

1. **Disable caching**:
   ```bash
   # Update ECS task definition
   REDIS_ENABLED=false
   ```

2. **Keep infrastructure**: No need to destroy Redis
3. **Re-enable when ready**: Set `REDIS_ENABLED=true`

## Support & Resources

- **Code**: `/server/services/cacheService.js`
- **Infrastructure**: `/pulumi/cache-infrastructure.ts`
- **Monitoring**: `/server/utils/cacheMetrics.js`
- **Warming**: `/server/utils/cacheWarming.js`
- **API**: `/server/routes/cache.js`

For issues or questions, check:
1. Application logs
2. CloudWatch logs
3. Cache health endpoint
4. Honeycomb traces
