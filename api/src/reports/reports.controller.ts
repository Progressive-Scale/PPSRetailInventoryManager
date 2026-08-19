import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext, INVENTORY_ADMIN_ROLES } from '../auth/auth.types';
import { ReportsService } from './reports.service';
import { AnyReport, ReportRequestQuery } from './dto/reports.dto';
import { fileName, toCsv, toPdf } from './report-render';
import { EmailReportDto } from './dto/email-report.dto';

/**
 * Reporting, for everyone except a store user.
 *
 * INVENTORY_ADMIN_ROLES is already exactly COMPANY_ADMIN + STORE_MANAGER, so this
 * needs no new role set — the same pair that may correct stock and approve counts.
 * A store user is left out deliberately: these reports carry company-wide value
 * totals, which is not shop-floor information.
 *
 * Store scoping is enforced in the service, not here. A manager cannot report on a
 * store they cannot otherwise see, no matter what storeId they send.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(INVENTORY_ADMIN_ROLES)
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  /** One row per product: weight, cases, pieces, value, and a grand total. */
  @Get('inventory-summary')
  async summary(
    @Ctx() ctx: DataContext,
    @Query() q: ReportRequestQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.deliver(await this.svc.summary(ctx, q), q, res);
  }

  /** One row per on-hand unit, grouped by product, with subtotals. */
  @Get('inventory-detail')
  async detail(
    @Ctx() ctx: DataContext,
    @Query() q: ReportRequestQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.deliver(await this.svc.detail(ctx, q), q, res);
  }

  /** What sold between two dates. Both dates required — see the service. */
  @Get('items-sold')
  async sold(
    @Ctx() ctx: DataContext,
    @Query() q: ReportRequestQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.deliver(await this.svc.sold(ctx, q), q, res);
  }

  /**
   * Email a report as attachments.
   *
   * 200 with `{ ok: false, error }` rather than a 5xx when delivery fails: the
   * report was produced and the attempt was recorded, and the caller needs to show
   * the reason next to a retry button rather than a stack trace. The same choice the
   * invitation emails make.
   */
  @Post('email')
  @HttpCode(HttpStatus.OK)
  emailReport(@Ctx() ctx: DataContext, @Body() dto: EmailReportDto) {
    return this.svc.email(ctx, dto);
  }

  /**
   * One report, three renderings, chosen by `?format=`.
   *
   * The rows are computed once and then formatted, so the screen, the PDF and the
   * spreadsheet cannot disagree about a total — which they would if each rendering
   * ran its own query.
   */
  private async deliver(
    report: AnyReport,
    q: ReportRequestQuery,
    res: Response,
  ): Promise<AnyReport | void> {
    const format = q.format ?? 'json';
    if (format === 'json') return report;

    if (format === 'csv') {
      const body = toCsv(report);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName(report, 'csv')}"`,
      );
      // A BOM, so Excel on Windows reads the file as UTF-8 rather than guessing a
      // codepage and mangling any product name with an accent in it.
      res.send('﻿' + body);
      return;
    }

    const pdf = await toPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName(report, 'pdf')}"`,
    );
    res.setHeader('Content-Length', String(pdf.length));
    res.end(pdf);
  }
}
