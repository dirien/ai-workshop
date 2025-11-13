// IMPORTANT: Import instrumentation FIRST before any other imports
import './instrumentation.js';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';

// Import configuration and services
import { config, validateConfig } from './config/index.js';
import logger from './config/logger.js';
import { rateLimiter, validateApiKey, requestLogger } from './middleware/auth.js';

// Import routes
import chatRouter from './routes/chat.js';
import adminRouter from './routes/admin.js';
import ingestRouter from './routes/ingest.js';
import cacheRouter from './routes/cache.js';

// Import services to initialize them
import llmProvider from './services/llmProvider.js';
import vectorStore from './services/vectorStoreCached.js';
import cacheService from './services/cacheService.js';
import cacheMetrics from './utils/cacheMetrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Server {
  constructor() {
    this.app = express();
    this.app.set('trust proxy', 1);
    this.port = config.port;
    if(process.env.CODESPACE_NAME) {
      this.host = process.env.CODESPACE_NAME + '-3000.app.github.dev';
    } else {
      this.host = 'localhost:3000';
    }
    console.info("💻 host is " + this.host);
  }

  async initialize() {
    try {
      logger.info('Starting server initialization...');

      // Validate configuration
      logger.debug('Validating configuration...');
      validateConfig();
      logger.info('Configuration validated successfully', {
        nodeEnv: config.nodeEnv,
        port: config.port,
        logLevel: config.logLevel,
        defaultProvider: config.llm.defaultProvider
      });

      // Initialize services
      logger.debug('Initializing services...');
      await this.initializeServices();

      // Setup middleware
      logger.debug('Setting up middleware...');
      this.setupMiddleware();

      // Setup routes
      logger.debug('Setting up routes...');
      this.setupRoutes();

      // Setup error handling
      logger.debug('Setting up error handling...');
      this.setupErrorHandling();

      logger.info('Server initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize server:', error);
      throw error;
    }
  }

  async initializeServices() {
    try {
      logger.debug('Initializing LLM provider...');
      // LLM Provider is already initialized in its constructor
      const availableProviders = llmProvider.getAvailableProviders();
      logger.info('LLM Provider service ready', {
        availableProviders,
        defaultProvider: config.llm.defaultProvider
      });

      // Initialize cache service
      logger.debug('Initializing cache service...');
      // Cache service initializes automatically in constructor
      if (cacheService.isAvailable()) {
        logger.info('Cache service initialized and available');
        
        // Register observable metrics
        cacheMetrics.registerObservables(() => cacheService.getStats());
      } else {
        logger.warn('Cache service not available - running without caching');
      }

      // Initialize vector store
      logger.debug('Initializing vector store...');
      await vectorStore.initialize();
      logger.info('Vector store service initialized', {
        collectionName: config.vectorDb.collectionName
      });

    } catch (error) {
      logger.error('Error initializing services:', error);
      throw error;
    }
  }

  setupMiddleware() {
    // Security middleware
    // Disable upgrade-insecure-requests when no HTTPS listener is configured
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "upgrade-insecure-requests": null, // Disable HTTPS upgrade when using HTTP-only ALB
        },
      },
    }));

    // CORS configuration
    this.app.use(cors({
      origin: `https://${this.host}`,
      credentials: true
    }));

    // Request parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Logging
    this.app.use(requestLogger);

    // Rate limiting
    this.app.use('/api/', rateLimiter);

    // API key validation (optional)
    this.app.use('/api/', validateApiKey);

    // Serve static files from client build (in production)
    if (config.nodeEnv === 'production') {
      this.app.use(express.static(path.join(__dirname, '../client/build')));
    }
  }

  setupRoutes() {
    // API routes
    this.app.use('/api/chat', chatRouter);
    this.app.use('/api/admin', adminRouter);
    this.app.use('/api/ingest', ingestRouter);
    this.app.use('/api/cache', cacheRouter);

    // Health check endpoint
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv,
        availableProviders: llmProvider.getAvailableProviders()
      });
    });

    // Serve React app (production)
    if (config.nodeEnv === 'production') {
      this.app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '../client/build/index.html'));
      });
    }

    // 404 handler for API routes
    this.app.use('/api/*', (req, res) => {
      res.status(404).json({
        success: false,
        error: 'API endpoint not found'
      });
    });
  }

  setupErrorHandling() {
    // Global error handler
    this.app.use((error, req, res, next) => {
      logger.error('Unhandled error:', error);

      res.status(500).json({
        success: false,
        error: config.nodeEnv === 'production' 
          ? 'Internal server error' 
          : error.message,
        ...(config.nodeEnv !== 'production' && { stack: error.stack })
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  }

  async start() {
    try {
      await this.initialize();

      this.app.listen(this.port, () => {
        logger.info(`🚀 Server running on port ${this.port}`);
        logger.info(`📊 Environment: ${config.nodeEnv}`);
        logger.info(`🤖 Available LLM providers: ${llmProvider.getAvailableProviders().join(', ')}`);
        logger.info(`🔍 Vector store: ${config.vectorDb.collectionName}`);
        
        if (config.nodeEnv === 'development') {
          logger.info(`💻 API endpoints available at http://localhost:${this.port}/api`);
        }
      });

    } catch (error) {
      logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}

// Start the server
const server = new Server();
server.start().catch((error) => {
  logger.error('Server startup failed:', error);
  process.exit(1);
});
