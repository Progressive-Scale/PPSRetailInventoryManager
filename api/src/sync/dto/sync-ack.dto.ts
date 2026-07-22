import { ArrayNotEmpty, IsArray, IsInt } from 'class-validator';

export class SyncAckDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  ids!: number[];
}
