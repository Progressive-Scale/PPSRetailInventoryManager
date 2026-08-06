import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { assertProductionConfig } from './common/production-config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Before anything is constructed or a port is bound: a production deploy still
  // carrying development configuration fails loudly here, rather than serving
  // traffic with a signing secret that is published in the repo.
  assertProductionConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Larger JSON bodies so an uploaded logo (sent as a data: URL) fits.
  app.useBodyParser('json', { limit: '6mb' });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const isProd = process.env.NODE_ENV === 'production';

  // Security headers. The CSP is written out rather than left at helmet's default
  // because two things this app genuinely does would otherwise be blocked: company
  // logos are stored and served as `data:` URLs, and the Angular build inlines
  // styles. Everything else stays at 'self' — there is no third-party origin in
  // this app, which is also why connect-src does not need widening.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          // Only meaningful over HTTPS, and in dev it would break plain http.
          upgradeInsecureRequests: isProd ? [] : null,
        },
      },
      // The app is served from tenant subdomains of one root domain; nothing
      // embeds it and nothing is loaded cross-origin.
      crossOriginEmbedderPolicy: false,
      // A year, and only once TLS is actually in front of it.
      hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  if (isProd) {
    // Serve the built Angular app so the whole thing is ONE service.
    const clientDir = join(__dirname, '..', 'client');
    if (existsSync(join(clientDir, 'index.html'))) {
      const server = app.getHttpAdapter().getInstance();
      server.use(express.static(clientDir));
      server.use((req, res, next) => {
        if (req.method === 'GET' && !req.path.startsWith('/api')) {
          res.sendFile(join(clientDir, 'index.html'));
        } else {
          next();
        }
      });
      logger.log(`Serving static client from ${clientDir}`);
    } else {
      logger.warn(`No built client at ${clientDir}; run "npm run build".`);
    }
  } else {
    // Dev: allow the Angular dev server (and tenant subdomains) cross-origin.
    app.enableCors({ origin: true, credentials: true });
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  logger.log(`API listening on port ${port} (routes under /api)`);
}

bootstrap();
