import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import llmProvider from './llmProvider.js';
import vectorStore from './vectorStore.js';
import cacheService from './cacheService.js';
import logger from '../config/logger.js';
import { traceLLMCall, addLLMEvents } from '../utils/llmTracing.js';

const tracer = trace.getTracer('rag-service-cached', '1.0.0');

/**
 * RAG Service with Multi-Layer Caching
 * 
 * Integrates three caching layers:
 * 1. Response Cache: Full LLM responses (highest priority)
 * 2. Vector Search Cache: Pre-computed vector search results
 * 3. Embedding Cache: Cached embeddings for queries
 * 
 * Cache Strategy:
 * - Check response cache first (fastest path)
 * - If miss, check vector search cache
 * - If miss, check embedding cache before generating new embedding
 * - Cache all results for future requests
 */
class RAGServiceCached {
  constructor() {
    this.systemPrompt = `You are AI Chatbot specializing in OpenTelemetry (OTel) integration and implementation. 
Your role is to help developers understand and implement OpenTelemetry instrumentation in their applications.

## Your application architecture is as follows:
### Frontend
Frontend (/client)
Modern React application
Real-time chat interface
Provider selection component
Message streaming support
API service layer for backend communication

#### Key Dependencies of Frontend
The project is using modern JavaScript (ES6+) with JSX syntax
Modern ES6+ module imports/exports
react-router-dom (v6.20.1) for routing
axios (v1.6.2) for HTTP requests
react-markdown (v9.0.1) for markdown rendering
react-syntax-highlighter (v15.5.0) for code highlighting
react-icons (v4.12.0) for icon components
OpenTelemetry related packages for web monitoring

### Backend (/server)
Express.js server with modular architecture
Comprehensive middleware (auth, validation, rate limiting)
Robust error handling and logging
API routes for chat and admin functions
Service layer for business logic

#### Key Dependencies of Backend
Node.js with Express.js framework
Uses ES Modules (type: "module" in package.json)
Modern JavaScript (ES6+) with async/await patterns
Class-based architecture for server setup
LangChain ecosystem (@langchain/core, @langchain/openai, etc.)
ChromaDB for vector storage
Express middleware (cors, helmet, rate-limit)
Winston for logging
Various AI provider SDKs (OpenAI, Anthropic, AWS)

### Services
llmProvider.js: Manages multiple AI provider integrations
vectorStore.js: Handles ChromaDB interactions
ragService.js: Implements RAG functionality
Various middleware services for security and validation

### Data Management
Uses ChromaDB for vector storage
Includes data ingestion scripts
Supports custom documentation ingestion
Pre-loaded with OpenTelemetry documentation

## Context:
You have access to comprehensive documentation about OpenTelemetry, including:
- Installation and setup guides
- Instrumentation examples for various frameworks and libraries
- Best practices and configuration options
- Troubleshooting guides
- Code snippets and examples

## Instructions:
1. Provide accurate, practical, and actionable advice based on the provided context
2. Include relevant code examples when appropriate
3. Explain concepts clearly and concisely
4. If the context doesn't contain enough information, acknowledge this and provide general guidance
5. Focus on helping users implement OTel successfully in their specific use case
6. Always prioritize official OpenTelemetry documentation and best practices

Context information:
{context}

User question: {question}

Provide a helpful, accurate response based on the context above. think deeply and verify as much as possible.:`;

    this.promptTemplate = PromptTemplate.fromTemplate(this.systemPrompt);
  }

  async generateResponse(question, providerName = null, maxContextDocs = 5) {
    return tracer.startActiveSpan('rag.generate_response_cached', async (span) => {
      try {
        logger.info(`Generating response for question: "${question}"`);
        const actualProvider = providerName || 'bedrock';

        // Add question metadata to span
        span.setAttributes({
          'rag.question': question,
          'rag.question_length': question.length,
          'rag.provider': actualProvider,
          'rag.max_context_docs': maxContextDocs,
          'rag.cache_enabled': cacheService.isAvailable(),
        });

        // =============================================================================
        // LAYER 1: Check Response Cache (Full Response)
        // =============================================================================
        const cachedResponse = await tracer.startActiveSpan('rag.cache.check_response', async (cacheSpan) => {
          try {
            const cached = await cacheService.getCachedResponse(question, actualProvider);
            
            cacheSpan.setAttributes({
              'cache.layer': 'response',
              'cache.hit': cached !== null,
            });

            if (cached) {
              logger.info(`Response cache HIT for question: "${question}"`);
              span.setAttribute('rag.cache_hit', true);
              span.setAttribute('rag.cache_layer', 'response');
            }

            cacheSpan.setStatus({ code: SpanStatusCode.OK });
            cacheSpan.end();
            return cached;
          } catch (error) {
            cacheSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
            cacheSpan.recordException(error);
            cacheSpan.end();
            return null;
          }
        });

        if (cachedResponse) {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return cachedResponse;
        }

        // =============================================================================
        // LAYER 2: Vector Search with Caching
        // =============================================================================
        const relevantDocs = await tracer.startActiveSpan('rag.vector_search_cached', async (vectorSpan) => {
          const vectorStartTime = Date.now();

          try {
            // Check vector search cache
            const cachedVectorResults = await cacheService.getCachedVectorSearch(question, maxContextDocs);
            
            if (cachedVectorResults) {
              const duration = Date.now() - vectorStartTime;
              logger.info(`Vector search cache HIT for question: "${question}"`);
              
              vectorSpan.setAttributes({
                'rag.vector_search.cached': true,
                'rag.vector_search.duration_ms': duration,
                'rag.vector_search.results_count': cachedVectorResults.length,
              });

              vectorSpan.setStatus({ code: SpanStatusCode.OK });
              vectorSpan.end();
              return cachedVectorResults;
            }

            // Cache miss - perform vector search
            logger.debug(`Vector search cache MISS for question: "${question}"`);
            const results = await vectorStore.similaritySearchWithScore(question, maxContextDocs);
            const duration = Date.now() - vectorStartTime;

            // Calculate relevance scores
            const scores = results.map(([, score]) => score);
            const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

            vectorSpan.setAttributes({
              'rag.vector_search.cached': false,
              'rag.vector_search.duration_ms': duration,
              'rag.vector_search.results_count': results.length,
              'rag.vector_search.max_score': Math.max(...scores),
              'rag.vector_search.min_score': Math.min(...scores),
              'rag.vector_search.avg_score': avgScore,
            });

            // Cache the vector search results
            await cacheService.cacheVectorSearch(question, maxContextDocs, results);

            vectorSpan.setStatus({ code: SpanStatusCode.OK });
            vectorSpan.end();
            return results;
          } catch (error) {
            vectorSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
            vectorSpan.recordException(error);
            vectorSpan.end();
            throw error;
          }
        });

        // =============================================================================
        // Format Context
        // =============================================================================
        const formattedContext = await tracer.startActiveSpan('rag.format_context', async (formatSpan) => {
          try {
            const context = this.formatContext(relevantDocs);

            formatSpan.setAttributes({
              'rag.context.formatted_length': context.length,
              'rag.context.documents_used': relevantDocs.length,
              'rag.context.sources': this.extractSources(relevantDocs).join(', '),
            });

            formatSpan.setStatus({ code: SpanStatusCode.OK });
            formatSpan.end();
            return context;
          } catch (error) {
            formatSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
            formatSpan.recordException(error);
            formatSpan.end();
            throw error;
          }
        });

        // =============================================================================
        // LLM Generation
        // =============================================================================
        const llm = llmProvider.getProvider(actualProvider);

        const llmResponse = await tracer.startActiveSpan('rag.llm_generation', async (llmSpan) => {
          const llmStartTime = Date.now();

          try {
            llmSpan.setAttributes({
              'rag.llm.provider': actualProvider,
              'rag.llm.context_length': formattedContext.length,
            });

            const response = await this.promptTemplate
              .pipe(llm)
              .pipe(new StringOutputParser())
              .invoke({
                context: formattedContext,
                question: question,
              });

            const duration = Date.now() - llmStartTime;

            llmSpan.setAttributes({
              'rag.llm.duration_ms': duration,
              'rag.llm.response_length': response.length,
              'rag.llm.success': true,
            });

            llmSpan.setStatus({ code: SpanStatusCode.OK });
            llmSpan.end();
            return response;
          } catch (error) {
            const duration = Date.now() - llmStartTime;

            llmSpan.setAttributes({
              'rag.llm.duration_ms': duration,
              'rag.llm.success': false,
              'rag.llm.error': error.message,
            });

            llmSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
            llmSpan.recordException(error);
            llmSpan.end();
            throw error;
          }
        });

        // =============================================================================
        // Build and Cache Response
        // =============================================================================
        const fullResponse = {
          response: llmResponse,
          context: {
            documentsUsed: relevantDocs.length,
            sources: this.extractSources(relevantDocs),
            relevanceScores: relevantDocs.map(([doc, score]) => ({
              source: doc.metadata?.source || 'unknown',
              score: score,
            })),
          },
          metadata: {
            question: question,
            provider: actualProvider,
            timestamp: new Date().toISOString(),
            cached: false,
          },
        };

        // Cache the full response
        await cacheService.cacheResponse(question, actualProvider, fullResponse);

        logger.info('Response generated and cached successfully');

        span.setAttributes({
          'rag.documents_used': relevantDocs.length,
          'rag.response_length': llmResponse.length,
          'rag.success': true,
          'rag.cache_hit': false,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        return fullResponse;

      } catch (error) {
        logger.error('Error generating RAG response:', error);

        span.setAttributes({
          'rag.success': false,
          'rag.error': error.message,
        });

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        span.recordException(error);
        span.end();

        throw error;
      }
    });
  }

  formatContext(relevantDocs) {
    if (!relevantDocs || relevantDocs.length === 0) {
      return 'No relevant context found in the knowledge base.';
    }

    return relevantDocs
      .map(([doc, score]) => {
        const source = doc.metadata?.source || 'unknown';
        const content = doc.pageContent;
        return `Source: ${source} (Relevance: ${score.toFixed(3)})\n${content}`;
      })
      .join('\n\n---\n\n');
  }

  extractSources(relevantDocs) {
    const sources = new Set();
    relevantDocs.forEach(([doc]) => {
      const source = doc.metadata?.source;
      if (source) {
        sources.add(source);
      }
    });
    return Array.from(sources);
  }

  async askQuestion(question, options = {}) {
    const {
      provider = null,
      maxContextDocs = 5,
      includeContext = false,
    } = options;

    try {
      const result = await this.generateResponse(question, provider, maxContextDocs);
      
      if (!includeContext) {
        // Return simplified response without internal context details
        return {
          response: result.response,
          sources: result.context.sources,
          metadata: {
            provider: result.metadata.provider,
            timestamp: result.metadata.timestamp,
            cached: result.metadata.cached || false,
          },
        };
      }

      return result;
    } catch (error) {
      logger.error('Error in askQuestion:', error);
      throw new Error(`Failed to generate response: ${error.message}`);
    }
  }

  async getContextForQuestion(question, maxDocs = 5) {
    try {
      // Check vector search cache first
      const cachedResults = await cacheService.getCachedVectorSearch(question, maxDocs);
      
      let relevantDocs;
      if (cachedResults) {
        logger.debug(`Using cached vector search results for context`);
        relevantDocs = cachedResults;
      } else {
        relevantDocs = await vectorStore.similaritySearchWithScore(question, maxDocs);
        // Cache for future requests
        await cacheService.cacheVectorSearch(question, maxDocs, relevantDocs);
      }

      return {
        context: this.formatContext(relevantDocs),
        sources: this.extractSources(relevantDocs),
        documentCount: relevantDocs.length,
        cached: cachedResults !== null,
      };
    } catch (error) {
      logger.error('Error getting context for question:', error);
      throw error;
    }
  }
}

export default new RAGServiceCached();
