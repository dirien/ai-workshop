import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import llmProvider from './llmProvider.js';
import vectorStore from './vectorStore.js';
import logger from '../config/logger.js';
import { traceLLMCall, addLLMEvents } from '../utils/llmTracing.js';

const tracer = trace.getTracer('rag-service', '1.0.0');

class RAGService {
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
    return tracer.startActiveSpan('rag.generate_response', async (span) => {
      try {
        logger.info(`Generating response for question: "${question}"`);

        // Add question metadata to span
        span.setAttributes({
          'rag.question': question,
          'rag.question_length': question.length,
          'rag.provider': providerName || 'default',
          'rag.max_context_docs': maxContextDocs
        });

        // Vector search with tracing
        const relevantDocs = await tracer.startActiveSpan('rag.vector_search', async (vectorSpan) => {
          const vectorStartTime = Date.now();

          try {
            const results = await vectorStore.similaritySearchWithScore(question, maxContextDocs);
            const duration = Date.now() - vectorStartTime;

            // Calculate relevance scores
            const scores = results.map(([, score]) => score);
            const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

            vectorSpan.setAttributes({
              'rag.vector_search.duration_ms': duration,
              'rag.vector_search.results_count': results.length,
              'rag.vector_search.max_score': Math.max(...scores),
              'rag.vector_search.min_score': Math.min(...scores),
              'rag.vector_search.avg_score': avgScore
            });

            vectorSpan.setStatus({ code: SpanStatusCode.OK });
            vectorSpan.end();
            return results;
          } catch (error) {
            vectorSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message
            });
            vectorSpan.recordException(error);
            vectorSpan.end();
            throw error;
          }
        });

        // Format context with tracing
        const formattedContext = await tracer.startActiveSpan('rag.format_context', async (formatSpan) => {
          try {
            const context = this.formatContext(relevantDocs);

            formatSpan.setAttributes({
              'rag.context.formatted_length': context.length,
              'rag.context.documents_used': relevantDocs.length,
              'rag.context.sources': this.extractSources(relevantDocs).join(', ')
            });

            formatSpan.setStatus({ code: SpanStatusCode.OK });
            formatSpan.end();
            return context;
          } catch (error) {
            formatSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message
            });
            formatSpan.recordException(error);
            formatSpan.end();
            throw error;
          }
        });

        // Get LLM provider
        const llm = llmProvider.getProvider(providerName);
        const actualProvider = providerName || llmProvider.getAvailableProviders()[0];

        // LLM generation with tracing
        const llmResponse = await tracer.startActiveSpan('rag.llm_generation', async (llmSpan) => {
          const llmStartTime = Date.now();

          try {
            llmSpan.setAttributes({
              'rag.llm.provider': actualProvider,
              'rag.llm.context_length': formattedContext.length
            });

            const response = await this.promptTemplate
              .pipe(llm)
              .pipe(new StringOutputParser())
              .invoke({
                context: formattedContext,
                question: question
              });

            const duration = Date.now() - llmStartTime;

            llmSpan.setAttributes({
              'rag.llm.duration_ms': duration,
              'rag.llm.response_length': response.length,
              'rag.llm.success': true
            });

            llmSpan.setStatus({ code: SpanStatusCode.OK });
            llmSpan.end();
            return response;
          } catch (error) {
            const duration = Date.now() - llmStartTime;

            llmSpan.setAttributes({
              'rag.llm.duration_ms': duration,
              'rag.llm.success': false,
              'rag.llm.error': error.message
            });

            llmSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message
            });
            llmSpan.recordException(error);
            llmSpan.end();
            throw error;
          }
        });

        // Format and return the response
        logger.info('Response generated successfully');

        span.setAttributes({
          'rag.documents_used': relevantDocs.length,
          'rag.response_length': llmResponse.length,
          'rag.success': true
        });

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        return {
          response: llmResponse,
          context: {
            documentsUsed: relevantDocs.length,
            sources: this.extractSources(relevantDocs),
            relevanceScores: relevantDocs.map(([doc, score]) => ({
              source: doc.metadata?.source || 'unknown',
              score: score
            }))
          },
          metadata: {
            question: question,
            provider: actualProvider,
            timestamp: new Date().toISOString()
          }
        };

      } catch (error) {
        logger.error('Error generating RAG response:', error);

        span.setAttributes({
          'rag.success': false,
          'rag.error': error.message
        });

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message
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

  async generateResponseStream(question, providerName = null, maxContextDocs = 5) {
    return tracer.startActiveSpan('rag.generate_response_stream', async (span) => {
      try {
        logger.info(`Generating streaming response for question: "${question}"`);

        // Add question metadata to span
        span.setAttributes({
          'rag.question': question,
          'rag.question_length': question.length,
          'rag.provider': providerName || 'default',
          'rag.max_context_docs': maxContextDocs,
          'rag.streaming': true
        });

        // Vector search with tracing
        const relevantDocs = await tracer.startActiveSpan('rag.vector_search', async (vectorSpan) => {
          const vectorStartTime = Date.now();

          try {
            const results = await vectorStore.similaritySearchWithScore(question, maxContextDocs);
            const duration = Date.now() - vectorStartTime;

            // Calculate relevance scores
            const scores = results.map(([, score]) => score);
            const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

            vectorSpan.setAttributes({
              'rag.vector_search.duration_ms': duration,
              'rag.vector_search.results_count': results.length,
              'rag.vector_search.max_score': Math.max(...scores),
              'rag.vector_search.min_score': Math.min(...scores),
              'rag.vector_search.avg_score': avgScore
            });

            vectorSpan.setStatus({ code: SpanStatusCode.OK });
            vectorSpan.end();
            return results;
          } catch (error) {
            vectorSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message
            });
            vectorSpan.recordException(error);
            vectorSpan.end();
            throw error;
          }
        });

        // Format context with tracing
        const formattedContext = await tracer.startActiveSpan('rag.format_context', async (formatSpan) => {
          try {
            const context = this.formatContext(relevantDocs);

            formatSpan.setAttributes({
              'rag.context.formatted_length': context.length,
              'rag.context.documents_used': relevantDocs.length,
              'rag.context.sources': this.extractSources(relevantDocs).join(', ')
            });

            formatSpan.setStatus({ code: SpanStatusCode.OK });
            formatSpan.end();
            return context;
          } catch (error) {
            formatSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message
            });
            formatSpan.recordException(error);
            formatSpan.end();
            throw error;
          }
        });

        // Get LLM provider
        const llm = llmProvider.getProvider(providerName);
        const actualProvider = providerName || llmProvider.getAvailableProviders()[0];

        // Create the streaming chain
        const chain = this.promptTemplate
          .pipe(llm)
          .pipe(new StringOutputParser());

        // Return stream generator with metadata
        const streamGenerator = async function* () {
          const llmStartTime = Date.now();
          let totalChunks = 0;
          let totalLength = 0;
          let streamError = null;

          try {
            // Start LLM span
            const llmSpan = tracer.startSpan('rag.llm_generation_stream', {
              attributes: {
                'rag.llm.provider': actualProvider,
                'rag.llm.context_length': formattedContext.length,
                'rag.llm.streaming': true
              }
            });

            // Stream the response
            const stream = await chain.stream({
              context: formattedContext,
              question: question
            });

            for await (const chunk of stream) {
              totalChunks++;
              totalLength += chunk.length;
              
              // Add streaming metrics
              llmSpan.addEvent('rag.llm.chunk_received', {
                'rag.llm.chunk_number': totalChunks,
                'rag.llm.chunk_length': chunk.length,
                'rag.llm.total_length': totalLength
              });

              yield chunk;
            }

            const duration = Date.now() - llmStartTime;

            // Update span with final metrics
            llmSpan.setAttributes({
              'rag.llm.duration_ms': duration,
              'rag.llm.total_chunks': totalChunks,
              'rag.llm.response_length': totalLength,
              'rag.llm.success': true
            });

            llmSpan.setStatus({ code: SpanStatusCode.OK });
            llmSpan.end();

          } catch (error) {
            streamError = error;
            const duration = Date.now() - llmStartTime;

            const llmSpan = tracer.startSpan('rag.llm_generation_stream', {
              attributes: {
                'rag.llm.provider': actualProvider,
                'rag.llm.duration_ms': duration,
                'rag.llm.total_chunks': totalChunks,
                'rag.llm.success': false,
                'rag.llm.error': error.message
              }
            });

            llmSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message
            });
            llmSpan.recordException(error);
            llmSpan.end();

            throw error;
          }
        };

        // Add metadata to span
        span.setAttributes({
          'rag.documents_used': relevantDocs.length,
          'rag.success': true
        });

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        // Return stream generator with metadata
        return {
          stream: streamGenerator(),
          metadata: {
            documentsUsed: relevantDocs.length,
            sources: this.extractSources(relevantDocs),
            relevanceScores: relevantDocs.map(([doc, score]) => ({
              source: doc.metadata?.source || 'unknown',
              score: score
            })),
            provider: actualProvider,
            timestamp: new Date().toISOString()
          }
        };

      } catch (error) {
        logger.error('Error generating streaming RAG response:', error);

        span.setAttributes({
          'rag.success': false,
          'rag.error': error.message
        });

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message
        });
        span.recordException(error);
        span.end();

        throw error;
      }
    });
  }

  async askQuestion(question, options = {}) {
    const {
      provider = null,
      maxContextDocs = 5,
      includeContext = false
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
            timestamp: result.metadata.timestamp
          }
        };
      }

      return result;
    } catch (error) {
      logger.error('Error in askQuestion:', error);
      throw new Error(`Failed to generate response: ${error.message}`);
    }
  }

  async askQuestionStream(question, options = {}) {
    const {
      provider = null,
      maxContextDocs = 5
    } = options;

    try {
      return await this.generateResponseStream(question, provider, maxContextDocs);
    } catch (error) {
      logger.error('Error in askQuestionStream:', error);
      throw new Error(`Failed to generate streaming response: ${error.message}`);
    }
  }

  async getContextForQuestion(question, maxDocs = 5) {
    try {
      const relevantDocs = await vectorStore.similaritySearchWithScore(question, maxDocs);
      return {
        context: this.formatContext(relevantDocs),
        sources: this.extractSources(relevantDocs),
        documentCount: relevantDocs.length
      };
    } catch (error) {
      logger.error('Error getting context for question:', error);
      throw error;
    }
  }
}

export default new RAGService();
