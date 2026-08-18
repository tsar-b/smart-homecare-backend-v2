import { env } from '../core/env.js';

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: '{{appName}} Backend API',
    version: '0.1.0'
  },
  servers: [
    {
      url: env.PUBLIC_API_URL
    }
  ],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
      }
    },
    responses: {
      ValidationError: {
        description: 'Request validation failed'
      },
      Unauthorized: {
        description: 'Authentication required'
      },
      Forbidden: {
        description: 'Admin privileges required'
      }
    }
  },
  paths: {
    '/health': {
      get: {
        security: [],
        responses: {
          '200': {
            description: 'Process is alive'
          }
        }
      }
    },
    '/ready': {
      get: {
        security: [],
        responses: {
          '200': {
            description: 'Backend dependencies are configured'
          }
        }
      }
    },
    '/api/auth/register': {
      post: {
        security: [],
        responses: {
          '201': {
            description: 'Registered user'
          }
        }
      }
    },
    '/api/auth/login': {
      post: {
        security: [],
        responses: {
          '200': {
            description: 'JWT token'
          }
        }
      }
    },
    '/api/app/initialize': {
      get: {
        security: [],
        responses: {
          '200': {
            description: 'Versioned app bootstrap payload'
          }
        }
      }
    },
    '/api/requests': {
      post: {
        responses: {
          '201': {
            description: 'Created request'
          },
          '409': {
            description: 'Time slot is unavailable'
          }
        }
      }
    },
    '/api/requests/history': {
      get: {
        responses: {
          '200': {
            description: 'Current user request history'
          }
        }
      }
    },
    '/api/app-drafts': {
      post: {
        responses: {
          '201': {
            description: 'Created AppNow application draft'
          }
        }
      },
      get: {
        responses: {
          '200': {
            description: 'Current user application drafts'
          }
        }
      }
    },
    '/api/admin/{table}': {
      get: {
        parameters: [
          { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          { name: 'pageSize', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'dateFrom', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'dateTo', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'search', in: 'query', required: false, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Paginated admin resource list'
          }
        }
      }
    }
  }
};
