import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { LocationsService } from './locations.service';
import {
  CreateLocationDto,
  ListLocationsQuery,
  ReorderLocationsDto,
  UpdateLocationDto,
} from './dto/locations.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('locations')
export class LocationsController {
  constructor(private readonly svc: LocationsService) {}

  // STORE_USER needs to read locations (scanner Move-Items target picker).
  @Get()
  @Roles(['COMPANY_ADMIN', 'STORE_USER'])
  list(@Ctx() ctx: DataContext, @Query() query: ListLocationsQuery) {
    return this.svc.list(ctx, query.storeId, query.includeInactive ?? false);
  }

  @Post()
  @Roles(['COMPANY_ADMIN'])
  create(@Ctx() ctx: DataContext, @Body() dto: CreateLocationDto) {
    return this.svc.create(ctx, dto);
  }

  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  reorder(@Ctx() ctx: DataContext, @Body() dto: ReorderLocationsDto) {
    return this.svc.reorder(ctx, dto);
  }

  @Patch(':id')
  @Roles(['COMPANY_ADMIN'])
  update(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.svc.update(ctx, id, dto);
  }

  /** Turn a location off. Blocked by live stock or being the last of a kind. */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  deactivate(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.deactivate(ctx, id);
  }

  /** Turn it back on. Allowed anytime, subject to active-name uniqueness. */
  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  reactivate(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.reactivate(ctx, id);
  }

  /** Hard delete — only for a location that was created and never used. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  remove(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(ctx, id);
  }
}
