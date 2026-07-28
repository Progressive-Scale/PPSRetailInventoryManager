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
    return this.svc.list(ctx, query.storeId);
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

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  remove(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.deactivate(ctx, id);
  }
}
