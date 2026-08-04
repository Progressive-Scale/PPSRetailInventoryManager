import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { BrandingController } from './branding.controller';
import { ProfileController } from './profile.controller';
import { AuthService } from './auth.service';
import { ProfileService } from './profile.service';
import { PasswordResetService } from './password-reset.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret) throw new Error('JWT_SECRET is not set.');
        return { secret, signOptions: { expiresIn: '7d' } };
      },
    }),
  ],
  controllers: [AuthController, BrandingController, ProfileController],
  providers: [
    AuthService,
    ProfileService,
    PasswordResetService,
    JwtAuthGuard,
    RolesGuard,
  ],
  // PasswordResetService is exported for the platform-admin module, which issues
  // reset links on a tenant user's behalf through the same code path.
  exports: [JwtAuthGuard, RolesGuard, JwtModule, PasswordResetService],
})
export class AuthModule {}
