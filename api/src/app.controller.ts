import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  // GET /api/health
  @Get('health')
  health() {
    return { status: 'ok', service: 'pps-retail-inventory-api' };
  }
}
