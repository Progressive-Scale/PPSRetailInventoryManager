import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { REPORT_KINDS, ReportKind, ReportQuery } from './reports.dto';

export const ATTACH_FORMATS = ['pdf', 'csv'] as const;
export type AttachFormat = (typeof ATTACH_FORMATS)[number];

export class EmailReportDto extends ReportQuery {
  /** Which report to render and attach. */
  @IsIn(REPORT_KINDS)
  kind!: ReportKind;

  /**
   * Where to send it.
   *
   * Named `recipients`, not `to`: ReportQuery already uses `to` for the end of the
   * sold-report date range, and one field meaning both "last day" and "who gets it"
   * is a trap for whoever writes the next client.
   *
   * ARBITRARY ADDRESSES ARE ALLOWED, deliberately: the people who need an inventory
   * valuation are often an accountant or an owner who has no login here, and
   * restricting this to existing users would just push everybody back to
   * downloading and forwarding by hand — which is the same data leaving by a route
   * nobody can audit. The send IS audited, which is the trade.
   *
   * Capped at ten so a typo cannot turn one click into a mailing list.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsEmail({}, { each: true, message: 'Each recipient must be an email address.' })
  recipients!: string[];

  /**
   * Which files to attach. Both by default: the PDF is what gets filed or printed
   * and the CSV is what gets pivoted, and people rarely know which they want until
   * they open it.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsIn(ATTACH_FORMATS, { each: true })
  formats?: AttachFormat[];

  /** An optional note from the sender, shown above the attachment list. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Type(() => String)
  message?: string;
}
