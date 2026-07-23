import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const isProd = process.env.NODE_ENV === 'production';

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
