import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  // GET /api/health — no tenant context required (skipped by tenant middleware).
  @Get('health')
  health() {
    return { status: 'ok', service: 'pps-retail-inventory-api' };
  }
}
