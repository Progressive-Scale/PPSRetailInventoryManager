import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'CANCELLED'] as const;

export class SyncReordersQuery {
  /**
   * Defaults to OPEN in the controller: the queue a consumer wants is the work it has
   * not done. The other statuses are readable for reconciliation.
   */
  @IsOptional() @IsEnum(STATUSES as unknown as string[])
  status?: (typeof STATUSES)[number];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class AckReorderDto {
  /**
   * The consuming system's own order identifier. Opaque to the cloud — it is displayed
   * back to store staff verbatim, so whatever a human would recognise in that system
   * is the right value (an order number, a document id, a URL).
   */
  @IsString() @MinLength(1) @MaxLength(128) externalOrderRef!: string;
}
