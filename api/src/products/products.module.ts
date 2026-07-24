import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';

@Module({
  imports: [AuthModule],
  controllers: [ProductsController],
})
export class ProductsModule {}
