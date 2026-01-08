import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import logger from '../config/logger.js';

const tracer = trace.getTracer('llm-provider', '1.0.0');

/**
 * Wrap an LLM call with OpenTelemetry tracing
 * Following OpenTelemetry GenAI Semantic Conventions v1.0 (stable)
 * Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * @param {string} providerName - Name of the LLM provider (openai, anthropic, bedrock)
 * @param {string} modelName - Model identifier
 * @param {Function} fn - Async function that makes the LLM call
 * @param {Object} metadata - Additional metadata to attach
 * @returns {Promise<any>} - Result from the LLM call
 */
export async function traceLLMCall(providerName, modelName, fn, metadata = {}) {
  return tracer.startActiveSpan(
    `chat ${modelName}`,
    {
      attributes: {
        // REQUIRED v1.0 attributes
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': providerName === 'bedrock' ? 'aws.bedrock' : providerName,
        'gen_ai.request.model': modelName,

        // RECOMMENDED v1.0 attributes
        'server.address': providerName === 'bedrock' ? `bedrock-runtime.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com` : undefined,

        ...metadata
      }
    },
    async (span) => {
      const startTime = Date.now();

      try {
        // Execute the LLM call
        const result = await fn();

        const duration = Date.now() - startTime;

        // Extract token usage if available (varies by provider)
        const usage = extractTokenUsage(result, providerName);

        // Add token usage attributes if available (RECOMMENDED in v1.0)
        if (usage) {
          span.setAttributes({
            'gen_ai.usage.input_tokens': usage.promptTokens || 0,
            'gen_ai.usage.output_tokens': usage.completionTokens || 0,
          });
        }

        // Add response metadata (RECOMMENDED in v1.0)
        if (result.id) {
          span.setAttribute('gen_ai.response.id', result.id);
        }

        if (result.model) {
          span.setAttribute('gen_ai.response.model', result.model);
        }

        // Add finish reasons if available (RECOMMENDED in v1.0)
        if (result.stop_reason || result.finish_reason) {
          span.setAttribute('gen_ai.response.finish_reasons', [result.stop_reason || result.finish_reason]);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        return result;

      } catch (error) {
        const duration = Date.now() - startTime;

        // CONDITIONALLY REQUIRED: error.type when operation ends in error
        span.setAttribute('error.type', error.name || 'GenAIError');

        // Additional error context
        if (error.status === 429 || error.message?.includes('rate limit')) {
          span.setAttribute('error.type', 'RateLimitError');
        } else if (error.message?.includes('timeout')) {
          span.setAttribute('error.type', 'TimeoutError');
        } else if (error.status === 400) {
          span.setAttribute('error.type', 'InvalidRequestError');
        }

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message
        });
        span.recordException(error);
        span.end();

        throw error;
      }
    }
  );
}

/**
 * Extract token usage from LLM response
 * Different providers return usage data in different formats
 */
function extractTokenUsage(result, providerName) {
  try {
    // OpenAI format
    if (result.response?.usage) {
      return {
        promptTokens: result.response.usage.prompt_tokens,
        completionTokens: result.response.usage.completion_tokens,
        totalTokens: result.response.usage.total_tokens
      };
    }

    // LangChain format (common across providers)
    if (result.llmOutput?.tokenUsage) {
      return {
        promptTokens: result.llmOutput.tokenUsage.promptTokens,
        completionTokens: result.llmOutput.tokenUsage.completionTokens,
        totalTokens: result.llmOutput.tokenUsage.totalTokens
      };
    }

    // Anthropic format
    if (result.usage) {
      return {
        promptTokens: result.usage.input_tokens,
        completionTokens: result.usage.output_tokens,
        totalTokens: (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0)
      };
    }

    // Bedrock format
    if (result['amazon-bedrock-invocationMetrics']) {
      const metrics = result['amazon-bedrock-invocationMetrics'];
      return {
        promptTokens: metrics.inputTokenCount,
        completionTokens: metrics.outputTokenCount,
        totalTokens: (metrics.inputTokenCount || 0) + (metrics.outputTokenCount || 0)
      };
    }

    return null;
  } catch (error) {
    logger.debug('Could not extract token usage:', error);
    return null;
  }
}

/**
 * Add GenAI prompt and response content as span attributes (opt-in)
 * Following OpenTelemetry GenAI Semantic Conventions v1.0
 * Use sparingly in production due to privacy and data volume concerns
 *
 * @param {Object} span - OpenTelemetry span
 * @param {string} systemPrompt - System prompt/instructions
 * @param {string} userPrompt - User message
 * @param {string} response - LLM response
 * @param {boolean} includeContent - Whether to include full content (default: false for production)
 */
export function addGenAIContent(span, systemPrompt, userPrompt, response, includeContent = false) {
  try {
    if (includeContent) {
      // v1.0 OPTIONAL attributes for prompt content
      if (systemPrompt) {
        span.setAttribute('gen_ai.prompt.0.content', systemPrompt);
        span.setAttribute('gen_ai.prompt.0.role', 'system');
      }

      if (userPrompt) {
        span.setAttribute('gen_ai.prompt.1.content', userPrompt);
        span.setAttribute('gen_ai.prompt.1.role', 'user');
      }

      if (response) {
        span.setAttribute('gen_ai.completion.0.content', response);
        span.setAttribute('gen_ai.completion.0.role', 'assistant');
      }
    }

    // Always capture content lengths for analysis (no privacy concerns)
    if (systemPrompt) span.setAttribute('gen_ai.prompt.0.length', systemPrompt.length);
    if (userPrompt) span.setAttribute('gen_ai.prompt.1.length', userPrompt.length);
    if (response) span.setAttribute('gen_ai.completion.0.length', response.length);

  } catch (error) {
    logger.debug('Error adding GenAI content attributes:', error);
  }
}

/**
 * Create a span for embedding generation
 * Following OpenTelemetry GenAI Semantic Conventions v1.0
 */
export async function traceEmbeddingGeneration(providerName, modelName, fn, metadata = {}) {
  return tracer.startActiveSpan(
    `embeddings ${modelName}`,
    {
      attributes: {
        // REQUIRED v1.0 attributes
        'gen_ai.operation.name': 'embeddings',
        'gen_ai.provider.name': providerName === 'bedrock' ? 'aws.bedrock' : providerName,
        'gen_ai.request.model': modelName,
        ...metadata
      }
    },
    async (span) => {
      const startTime = Date.now();

      try {
        const result = await fn();
        const duration = Date.now() - startTime;

        // Track embedding dimensions (RECOMMENDED in v1.0)
        if (Array.isArray(result) && result.length > 0) {
          // If result is an array of embeddings, count the vector dimensions
          const firstEmbedding = Array.isArray(result[0]) ? result[0] : result;
          if (Array.isArray(firstEmbedding)) {
            span.setAttribute('gen_ai.embeddings.dimension.count', firstEmbedding.length);
          }
        }

        if (result.id) {
          span.setAttribute('gen_ai.response.id', result.id);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        return result;

      } catch (error) {
        const duration = Date.now() - startTime;

        // CONDITIONALLY REQUIRED: error.type
        span.setAttribute('error.type', error.name || 'GenAIError');

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message
        });
        span.recordException(error);
        span.end();

        throw error;
      }
    }
  );
}

export default {
  traceLLMCall,
  addGenAIContent,
  traceEmbeddingGeneration
};
