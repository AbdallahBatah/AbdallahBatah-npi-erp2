import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { assertJwtSecret } from './modules/auth/jwt.constants';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // ConfigModule has loaded .env by now — enforce a real secret in EVERY
  // environment (presence alone is not enough; placeholders are rejected).
  assertJwtSecret();

  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));
  // Behind Caddy/any reverse proxy: trust X-Forwarded-For so the throttler
  // and audit IPs see the real client, not the proxy.
  app.set('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // OpenAPI is generated from the code itself (the @nestjs/swagger CLI plugin
  // in nest-cli.json derives DTO schemas from the TypeScript types), so the
  // document can never drift from the controllers it describes.
  //
  // Registration is gated behind EXPOSE_API_DOCS=1: with the flag absent
  // (the default — every production environment), /api/docs and
  // /api/docs-json must not exist (404), since the schema exposes the full
  // shape of every endpoint with no auth in front of it. The demo server
  // sets EXPOSE_API_DOCS=1 to keep the docs available there.
  if (process.env.EXPOSE_API_DOCS === '1') {
    const openApiConfig = new DocumentBuilder()
      .setTitle('NPI Solar ERP API')
      .setDescription('REST API for the NPI Solar ERP. All endpoints are prefixed with /api and, unless noted, require a Bearer token from POST /api/auth/login.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
    // Group operations by their first path segment after /api (finance, crm, …)
    // instead of one flat "default" bucket — derived from the routes, so a new
    // module gets its own group without anyone remembering to annotate it.
    const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
    for (const [path, ops] of Object.entries(openApiDocument.paths)) {
      const segment = path.replace(/^\/api\//, '').split('/')[0] ?? 'api';
      for (const method of httpMethods) {
        const op = (ops as Record<string, { tags?: string[] } | undefined>)[method];
        if (op) op.tags = [segment];
      }
    }
    SwaggerModule.setup('api/docs', app, openApiDocument);
  }

  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`NPI ERP API listening on http://localhost:${port}/api`);
}

void bootstrap();
